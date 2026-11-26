import { expect, it } from 'vitest';
import { ChatSession } from '../src/t3/session';
import { T3Rpc } from '../src/t3/rpc';

interface Request { id: string; tag: string; payload: Record<string, unknown> }

class ServiceSocket extends EventTarget {
  deferSnapshot = false;
  readonly commands: Record<string, unknown>[] = [];
  private stream?: Request;

  send(raw: string): void {
    const frame = JSON.parse(raw) as Request & { _tag: string };
    if (frame._tag !== 'Request') return;
    if (frame.tag === 'orchestration.subscribeThread') {
      this.stream = frame;
      if (!this.deferSnapshot) this.snapshot();
      return;
    }
    this.commands.push(frame.payload);
    this.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { sequence: 1 } } });
  }

  snapshot(projection = { messages: [] as unknown[], runs: [] as unknown[] }): void {
    this.item({ kind: 'snapshot', projection });
  }

  event(type: string, payload: Record<string, unknown>): void {
    this.item({ kind: 'event', event: { type, payload } });
  }

  private item(value: unknown): void {
    if (!this.stream) throw new Error('Missing thread subscription.');
    this.receive({ _tag: 'Chunk', requestId: this.stream.id, values: [value] });
  }

  private receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  close(): void { this.dispatchEvent(new Event('close')); }
}

it('dispatches two messages to one thread, recovers the stream and stops the current run', async () => {
  const project = { id: 'project', title: 'Test', root: 'C:/sandbox' };
  const socket = new ServiceSocket();
  const session = new ChatSession(() => undefined, () => undefined);
  session.attach(new T3Rpc(socket));
  await session.send(project, 'Hello');
  expect(socket.commands.map(command => command.type)).toEqual(['thread.create', 'message.dispatch']);
  const first = { id: 'r1', userMessageId: socket.commands[1].messageId, status: 'completed' };
  socket.event('run.updated', first);
  expect(session.busy).toBe(false);
  await session.send(project, 'Follow up');
  const second = { id: 'r2', userMessageId: socket.commands[2].messageId, status: 'running' };
  expect(socket.commands[2]).toMatchObject({ threadId: session.threadId, text: 'Follow up' });
  socket.event('run.created', second);
  socket.event('turn-item.updated', { type: 'assistant_message', messageId: 'a', text: 'Partial', runId: second.id });
  expect(session.transcript.messages[0]?.text).toBe('Partial');
  socket.close();

  const reconnected = new ServiceSocket();
  session.attach(new T3Rpc(reconnected));
  reconnected.snapshot({ messages: [{ id: 'a', role: 'assistant', text: 'Recovered', streaming: true }], runs: [first, second] });
  expect(session.transcript.messages[0]?.text).toBe('Recovered');
  expect(reconnected.commands).toEqual([]);
  await session.stop();
  expect(reconnected.commands).toEqual([expect.objectContaining({ type: 'run.interrupt', runId: second.id })]);
  reconnected.event('run.updated', { ...second, status: 'interrupted' });
  expect(session.busy).toBe(false);
  session.reset();
  expect(session.threadId).toBeUndefined();
  expect(session.transcript.messages).toEqual([]);
  reconnected.close();
});

it('does not let a stopped stream close the replacement socket after a reset', async () => {
  const project = { id: 'project', title: 'Test', root: 'C:/sandbox' };
  const socket = new ServiceSocket();
  const session = new ChatSession(() => undefined, () => undefined);
  session.attach(new T3Rpc(socket));
  await session.send(project, 'Start');
  session.reset();
  await session.send(project, 'Restart');
  expect(socket.commands.map(command => command.type)).toEqual([
    'thread.create', 'message.dispatch', 'thread.create', 'message.dispatch',
  ]);
  socket.close();
});


it('keeps the composer busy if the initial snapshot predates the accepted dispatch', async () => {
  const socket = new ServiceSocket();
  socket.deferSnapshot = true;
  const session = new ChatSession(() => undefined, () => undefined);
  session.attach(new T3Rpc(socket));
  await session.send({ id: 'project', title: 'Test', root: 'C:/sandbox' }, 'Hello');
  socket.snapshot();
  expect(session.busy).toBe(true);
  socket.close();
});
