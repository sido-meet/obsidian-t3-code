import { expect, it, vi } from 'vitest';
import { T3Rpc } from '../src/t3/rpc';

class Socket extends EventTarget {
  sent: unknown[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.dispatchEvent(new Event('close')); }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

it('routes Effect RPC chunks and replies with an acknowledgement', async () => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const items: unknown[] = [];
  const stream = rpc.request('orchestration.subscribeThread', { threadId: 't' }, item => items.push(item));
  expect(socket.sent).toEqual([
    { _tag: 'Request', id: '1', tag: 'orchestration.subscribeThread', payload: { threadId: 't' }, headers: [] },
  ]);
  socket.receive([{ _tag: 'Ping' }, { _tag: 'Chunk', requestId: '1', values: [{ kind: 'snapshot' }] }]);
  expect(items).toEqual([{ kind: 'snapshot' }]);
  expect(socket.sent.slice(1)).toEqual([{ _tag: 'Pong' }, { _tag: 'Ack', requestId: '1' }]);
  socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 42 } });
  await expect(stream.result).resolves.toBe(42);
  socket.close();
});

it('rejects all outstanding calls on close', async () => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const call = rpc.request('example', {});
  socket.close();
  await expect(call.result).rejects.toThrow('连接');
});

it('closes a half-open connection when a heartbeat gets no pong', async () => {
  vi.useFakeTimers();
  try {
    const socket = new Socket();
    const rpc = new T3Rpc(socket);
    await vi.advanceTimersByTimeAsync(15000);
    expect(socket.sent).toContainEqual({ _tag: 'Ping' });
    await vi.advanceTimersByTimeAsync(10000);
    await rpc.disconnected;
  } finally { vi.useRealTimers(); }
});


it('tolerates unknown frames and keeps the connection open after pong', async () => {
  vi.useFakeTimers();
  try {
    const socket = new Socket();
    const rpc = new T3Rpc(socket);
    await vi.advanceTimersByTimeAsync(15000);
    socket.receive([{ _tag: 'FutureFrame' }, false, [], null, { _tag: 'Pong' }]);
    await vi.advanceTimersByTimeAsync(10000);
    const call = rpc.request('query', {});
    socket.receive({ _tag: 'Chunk', requestId: '1', values: [42] });
    socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 7 } });
    await expect(call.result).resolves.toBe(7);
    call.cancel();
    rpc.close();
    rpc.close();
  } finally { vi.useRealTimers(); }
});

it('reports a rejected RPC without disconnecting other calls', async () => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const bad = rpc.request('denied', {});
  const good = rpc.request('allowed', {});
  socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Failure' } });
  socket.receive({ _tag: 'Exit', requestId: '2', exit: { _tag: 'Success', value: true } });
  await expect(bad.result).rejects.toThrow('拒绝');
  await expect(good.result).resolves.toBe(true);
  socket.close();
});

it.each([
  new MessageEvent('message', { data: '{' }),
  new Event('message'),
  new MessageEvent('message', { data: new ArrayBuffer(1) }),
  new MessageEvent('message', { data: '{"_tag":"Defect"}' }),
  new MessageEvent('message', { data: '{"_tag":"Chunk","requestId":"1","values":null}' }),
  new Event('error'),
])('fails the in-flight RPC on invalid frames or socket failures (%#)', async frame => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const call = rpc.request('query', {});
  socket.dispatchEvent(frame);
  await expect(call.result).rejects.toThrow('连接');
  await expect(rpc.request('query', {}).result).rejects.toThrow('连接');
});

it('interrupts a timed-out call and ignores its late result', async () => {
  vi.useFakeTimers();
  try {
    const socket = new Socket();
    const rpc = new T3Rpc(socket);
    const call = rpc.request('query', {});
    const rejected = expect(call.result).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(socket.sent).toContainEqual({ _tag: 'Interrupt', requestId: '1' });
    socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: true } });
    rpc.close();
  } finally { vi.useRealTimers(); }
});

it('cleans up calls if the socket rejects send and closes if cancel cannot be sent', async () => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const call = rpc.request('query', {});
  vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('fixture'); });
  await expect(rpc.request('query', {}).result).rejects.toThrow('发送');
  call.cancel();
  await expect(call.result).rejects.toThrow('取消');
  await rpc.disconnected;
});

it('closes the connection if sending a heartbeat fails', async () => {
  vi.useFakeTimers();
  try {
    const socket = new Socket();
    const rpc = new T3Rpc(socket);
    vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('fixture'); });
    await vi.advanceTimersByTimeAsync(15000);
    await rpc.disconnected;
  } finally { vi.useRealTimers(); }
});

it('supports subscribe/unsubscribe streaming and extracts redacted Effect Cause failure messages', async () => {
  const socket = new Socket();
  const rpc = new T3Rpc(socket);
  const chunks: unknown[] = [];

  const sub = rpc.subscribe('server.subscribeServerConfig', {}, value => chunks.push(value));
  socket.receive({ _tag: 'Chunk', requestId: '1', values: [{ ok: true }] });
  expect(chunks).toEqual([{ ok: true }]);
  expect(socket.sent).toContainEqual({ _tag: 'Ack', requestId: '1' });
  sub.unsubscribe();
  await expect(sub.result).rejects.toThrow('取消');
  expect(socket.sent).toContainEqual({ _tag: 'Interrupt', requestId: '1' });

  const failArrayDetail = rpc.request('cmd.a', {});
  socket.receive({
    _tag: 'Exit',
    requestId: '2',
    exit: {
      _tag: 'Failure',
      cause: [
        { _tag: 'Die' },
        { _tag: 'Fail', error: { detail: 'Auth failed Bearer top-secret-tok?wsTicket=tkt99' } },
      ],
    },
  });
  await expect(failArrayDetail.result).rejects.toThrow('Auth failed Bearer [REDACTED]?wsTicket=[REDACTED]');

  const failReasonsMsg = rpc.request('cmd.b', {});
  socket.receive({
    _tag: 'Exit',
    requestId: '3',
    exit: {
      _tag: 'Failure',
      cause: {
        reasons: [{ _tag: 'Fail', error: { message: 'Bad DPoP dpop123&token=abc' } }],
      },
    },
  });
  await expect(failReasonsMsg.result).rejects.toThrow('Bad DPoP [REDACTED]&token=[REDACTED]');

  const failDirectObj = rpc.request('cmd.c', {});
  socket.receive({
    _tag: 'Exit',
    requestId: '4',
    exit: { _tag: 'Failure', cause: { _tag: 'Fail', error: {} } },
  });
  await expect(failDirectObj.result).rejects.toThrow('T3 拒绝了请求');
  rpc.close();
});
