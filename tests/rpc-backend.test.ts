import { describe, expect, it, vi } from 'vitest';
import { T3AuthManager } from '../src/t3/auth';
import { RpcBackend, UncertainWriteError, type RpcSocketLike } from '../src/t3/rpc-backend';
import { T3Store } from '../src/t3/store';

class MockRpcSocket extends EventTarget implements RpcSocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

function createHarness(options: {
  serverCapabilities?: Record<string, unknown>;
  socketResponder?: (socket: MockRpcSocket, req: Record<string, unknown>, connIndex: number) => void;
  boundedOverride?: () => Record<string, unknown>;
  onTicketAttempt?: (url: string, count: number) => Response | null;
} = {}) {
  const sockets: MockRpcSocket[] = [];
  const store = new T3Store();
  let ticketCount = 0;
  let httpShellCalls = 0;

  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) {
      return new Response(JSON.stringify({ authenticated: true, scopes: ['orchestration:read', 'orchestration:operate'] }), { status: 200 });
    }
    if (url.includes('/api/auth/websocket-ticket')) {
      ticketCount++;
      const custom = options.onTicketAttempt?.(url, ticketCount);
      if (custom) return custom;
      return new Response(JSON.stringify({ ticket: `wst-${ticketCount}` }), { status: 200 });
    }
    if (url.includes('/api/orchestration/shell')) {
      httpShellCalls++;
      if (url.includes('resumeFrom=')) {
        return new Response(JSON.stringify({ resumable: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        snapshotSequence: 100,
        projects: [{ id: 'proj-1', title: 'VaultRepo', workspaceRoot: 'E:\\Repo' }],
        threads: [{ id: 'th-1', title: 'First Thread', projectId: 'proj-1', status: 'idle', runtimeMode: 'approval-required' }],
      }), { status: 200 });
    }
    if (url.includes('/bounded')) {
      const payload = options.boundedOverride?.() ?? {
        snapshotSequence: 150,
        projection: {
          thread: { id: 'th-1', title: 'First Thread', status: 'idle', runtimeMode: 'approval-required' },
          messages: [{ id: 'msg-1', role: 'user', text: 'hello', streaming: false }],
          turnItems: [],
          runtimeRequests: [],
          runs: [],
        },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });

  const runCli = vi.fn(async (_exe: string, args: string[]) => {
    if (args.includes('issue')) return JSON.stringify({ token: 'tok-live-1', sessionId: 'sess-1' });
    return '';
  });
  const auth = new T3AuthManager({ platform: 'linux', runCli, fetcher });
  let ids = 0;
  const backend = new RpcBackend({
    getSettings: () => ({ cliPath: '/usr/bin/t3', provider: 'codex', model: 'gpt-5', modelPresets: '', serverUrl: 'http://127.0.0.1:3773' }),
    auth,
    store,
    fetcher,
    discoverFn: async () => ({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      serverVersion: '0.1.13',
      orchestrationProtocolVersion: 2,
      capabilities: options.serverCapabilities ?? { threadStop: true, modelCatalogRefresh: true },
    }),
    discoverCliFn: () => '/usr/bin/t3',
    resolveT3HomeFn: () => '/home/user/.t3',
    realpathFn: async p => p,
    createWebSocket: () => {
      const connIndex = sockets.length;
      const socket = new MockRpcSocket();
      const origSend = socket.send.bind(socket);
      socket.send = (raw: string) => {
        origSend(raw);
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame._tag !== 'Request') return;
        if (options.socketResponder) {
          options.socketResponder(socket, frame, connIndex);
          return;
        }
        queueMicrotask(() => {
          if (frame.tag === 'server.getConfig') {
            socket.receive({
              _tag: 'Exit',
              requestId: frame.id,
              exit: {
                _tag: 'Success',
                value: {
                  providers: [{
                    instanceId: 'codex',
                    displayName: 'Codex',
                    enabled: true,
                    installed: true,
                    status: 'ready',
                    models: [{ slug: 'gpt-5', name: 'GPT 5', isDefault: true }],
                    usageLimits: { unavailable: { reason: 'unsupported' }, windows: [] },
                  }],
                },
              },
            });
          } else if (frame.tag === 'server.refreshProviders') {
            socket.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: {} } });
          } else if (frame.tag === 'orchestration.dispatchCommand') {
            socket.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { sequence: 101 } } });
          }
        });
      };
      sockets.push(socket);
      socket.open();
      return socket;
    },
    randomId: () => `uuid-${++ids}`,
    randomFn: () => 0.5,
  });

  return { backend, store, sockets, fetcher, runCli, auth, getHttpShellCalls: () => httpShellCalls };
}

describe('RpcBackend', () => {
  it('connects over ticket fallback /ws, hydrates shell/providers, streams threads, and reconnects with afterSequence + HTTP resync', async () => {
    const subPayloads: Array<Record<string, unknown>> = [];
    const harness = createHarness({
      onTicketAttempt: (url, count) => {
        if (count === 1 && url.endsWith('/api/auth/websocket-ticket/rpc')) {
          return new Response('', { status: 404 });
        }
        return null;
      },
      socketResponder: (socket, frame) => {
        if (frame.tag === 'orchestration.subscribeThread' || frame.tag === 'orchestration.subscribeShell') {
          subPayloads.push({ tag: frame.tag, payload: frame.payload });
        }
        queueMicrotask(() => {
          if (frame.tag === 'server.getConfig') {
            socket.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { providers: [] } } });
          }
        });
      },
    });

    const caps = await harness.backend.connect('E:\\Repo', '');
    expect(caps.supportsStop).toBe(true);
    expect(await harness.backend.listThreads('')).toHaveLength(1);

    const events: Array<{ type: string; seq?: number }> = [];
    const sub = await harness.backend.openThread('th-1', ev => {
      events.push({ type: ev.type, seq: ev.type === 'thread.detail' ? ev.detail.lastSequence : undefined });
    });

    const sock0 = harness.sockets[0];
    const threadSubReq = sock0.sent.find(f => f.tag === 'orchestration.subscribeThread');
    expect(threadSubReq).toBeDefined();
    const reqId = String(threadSubReq?.id);
    sock0.receive({
      _tag: 'Chunk',
      requestId: reqId,
      values: [
        { kind: 'snapshot', snapshotSequence: 100, projection: { thread: { id: 'th-1', status: 'idle' }, messages: [] } },
        { kind: 'synchronized' },
        { kind: 'event', sequence: 105, event: { id: 'ev-1', type: 'message.updated', payload: { id: 'm1', role: 'assistant', text: 'hi', streaming: false } } },
      ],
    });
    expect(events[events.length - 1]).toEqual({ type: 'thread.detail', seq: 105 });
    expect(sock0.sent).toContainEqual({ _tag: 'Ack', requestId: reqId });

    // Trigger snapshot-required resync over HTTP bounded endpoint
    sock0.receive({ _tag: 'Chunk', requestId: reqId, values: [{ kind: 'snapshot-required' }] });
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'thread.resync-required')).toBe(true);
      expect(events[events.length - 1]).toEqual({ type: 'thread.detail', seq: 150 });
    });

    // Disconnect WS -> reconnects and passes afterSequence: 150 + resumeFrom: 100
    vi.useFakeTimers();
    try {
      sock0.close();
      await vi.advanceTimersByTimeAsync(1500);
      await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
      const resumed = subPayloads.find(p => p.tag === 'orchestration.subscribeThread' && (p.payload as Record<string, unknown>).afterSequence === 150);
      expect(resumed).toBeDefined();
      expect(harness.getHttpShellCalls()).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }

    sub.unsubscribe();
    await harness.backend.disconnect();
    expect(harness.runCli).toHaveBeenLastCalledWith('/usr/bin/t3', ['auth', 'session', 'revoke', '--base-dir', '/home/user/.t3', 'sess-1'], undefined, 5000);
  });

  it('dispatches deterministic thread.create + message.dispatch, throws UncertainWriteError on transport drop, and enforces stop/feedback guards', async () => {
    const dispatchedCommands: Array<Record<string, unknown>> = [];
    let failDispatch = false;

    const harness = createHarness({
      serverCapabilities: { threadStop: false, threadForceStop: true, modelCatalogRefresh: true },
      socketResponder: (socket, frame) => {
        queueMicrotask(() => {
          if (frame.tag === 'server.getConfig' || frame.tag === 'server.refreshProviders') {
            socket.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { providers: [] } } });
            return;
          }
          if (frame.tag === 'orchestration.dispatchCommand') {
            const payload = frame.payload as Record<string, unknown>;
            dispatchedCommands.push(payload);
            if (failDispatch && payload.type === 'message.dispatch') {
              socket.close();
              return;
            }
            socket.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { sequence: 201 } } });
          }
        });
      },
    });

    await harness.backend.connect('E:\\Repo', 'proj-1');
    const providers = await harness.backend.getProviders(true);
    expect(providers).toEqual([]);

    // Drop transport on message.dispatch -> creates thread once, throws UncertainWriteError, keeps same threadId on retry
    failDispatch = true;
    await expect(harness.backend.sendMessage({
      projectId: 'proj-1',
      commandId: 'cmd-1',
      messageId: 'msg-1',
      text: 'Hello',
      modelSelection: { instanceId: 'codex', model: 'gpt-5' },
    })).rejects.toBeInstanceOf(UncertainWriteError);

    const firstThreadId = dispatchedCommands[0].threadId as string;
    expect(harness.backend.getPendingThreadIdForCommand('cmd-1')).toBe(firstThreadId);

    // Manually re-establish connection and retry with identical commandId -> reuses exact threadId
    await harness.backend.connect('E:\\Repo', 'proj-1');
    failDispatch = false;
    const sent = await harness.backend.sendMessage({
      projectId: 'proj-1',
      commandId: 'cmd-1',
      messageId: 'msg-1',
      text: 'Hello',
    });
    expect(sent.threadId).toBe(firstThreadId);
    const dispatchPayloads = dispatchedCommands.filter(c => c.type === 'message.dispatch');
    expect(dispatchPayloads.map(p => [p.commandId, p.messageId, p.threadId])).toEqual([
      ['cmd-1', 'msg-1', firstThreadId],
      ['cmd-1', 'msg-1', firstThreadId],
    ]);

    // When threadStop is false, falls back to run.interrupt with holdQueue: true
    await harness.backend.stopThread(firstThreadId, 'cmd-stop', 'run-active');
    expect(dispatchedCommands[dispatchedCommands.length - 1]).toMatchObject({
      type: 'run.interrupt',
      runId: 'run-active',
      holdQueue: true,
    });

    // Strict feedback guard: omit feedback when supportsFeedback is false or decision !== 'decline'
    harness.store.setThreadDetail('th-1', {
      thread: { threadId: 'th-1', title: 'T', status: 'waiting' },
      messages: [],
      turnItems: [],
      runtimeRequests: [
        { id: 'req-nofb', threadId: 'th-1', kind: 'command', status: 'pending', supportsFeedback: false },
        { id: 'req-fb', threadId: 'th-1', kind: 'command', status: 'pending', supportsFeedback: true },
      ],
      contextUsage: { status: 'unknown' },
      runIds: [],
      lastSequence: 1,
      synchronized: true,
    });

    await harness.backend.respondRuntimeRequest({
      threadId: 'th-1',
      requestId: 'req-nofb',
      commandId: 'cmd-r1',
      decision: 'decline',
      feedback: 'should be stripped',
    });
    expect(dispatchedCommands[dispatchedCommands.length - 1]).not.toHaveProperty('feedback');

    await harness.backend.respondRuntimeRequest({
      threadId: 'th-1',
      requestId: 'req-fb',
      commandId: 'cmd-r2',
      decision: 'accept',
      feedback: 'not allowed on accept',
    });
    expect(dispatchedCommands[dispatchedCommands.length - 1]).not.toHaveProperty('feedback');

    await harness.backend.respondRuntimeRequest({
      threadId: 'th-1',
      requestId: 'req-fb',
      commandId: 'cmd-r3',
      decision: 'decline',
      feedback: 'Unsafe command',
    });
    expect(dispatchedCommands[dispatchedCommands.length - 1]).toMatchObject({
      type: 'runtime-request.respond',
      decision: 'decline',
      feedback: 'Unsafe command',
    });

    await harness.backend.disconnect();
  });

  it('handles 401 session renewal, live shell/config deltas, inspectPendingWrite states, non-transport failures, and reconnect exhaustion', async () => {
    const dispatchedCommands: Array<Record<string, unknown>> = [];
    let shellAttempt = 0;
    let boundedStatus = 404;
    let boundedHasMsg = false;
    let failDispatchWithServerError = false;
    const exhausted = vi.fn();
    let activeSocket: MockRpcSocket | undefined;

    const sockets: MockRpcSocket[] = [];
    const store = new T3Store();
    const runCli = vi.fn(async (_exe: string, args: string[]) => {
      if (args.includes('issue')) return JSON.stringify({ token: `tok-${runCli.mock.calls.length}`, sessionId: 's-1' });
      return '';
    });
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/api/auth/session')) {
        return new Response(JSON.stringify({ authenticated: true, scopes: ['orchestration:read', 'orchestration:operate'] }), { status: 200 });
      }
      if (url.includes('/api/auth/websocket-ticket')) {
        return new Response(JSON.stringify({ ticket: 'wst-1' }), { status: 200 });
      }
      if (url.includes('/api/orchestration/shell')) {
        shellAttempt++;
        if (shellAttempt === 1) return new Response('', { status: 401 });
        return new Response(JSON.stringify({
          snapshotSequence: 50,
          projects: [{ id: 'proj-1', title: 'R', workspaceRoot: 'E:\\Repo' }],
          threads: [],
        }), { status: 200 });
      }
      if (url.includes('/bounded')) {
        if (boundedStatus !== 200) return new Response('', { status: boundedStatus });
        return new Response(JSON.stringify({
          snapshotSequence: 60,
          projection: {
            thread: { id: 'th-1', status: 'idle' },
            messages: boundedHasMsg ? [{ id: 'msg-x', role: 'user', text: 'ok', streaming: false }] : [],
          },
        }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    let connFailCount = 0;
    const auth = new T3AuthManager({ platform: 'linux', runCli, fetcher });
    const backend = new RpcBackend({
      getSettings: () => ({ cliPath: '/usr/bin/t3', provider: 'codex', model: 'gpt-5', modelPresets: '', serverUrl: 'http://127.0.0.1:3773' }),
      auth,
      store,
      fetcher,
      discoverFn: async () => ({
        origin: 'http://127.0.0.1:3773',
        environmentId: 'env-1',
        serverVersion: '0.1.13',
        orchestrationProtocolVersion: 2,
        capabilities: { threadStop: true },
      }),
      discoverCliFn: () => '/usr/bin/t3',
      resolveT3HomeFn: () => '/home/user/.t3',
      createWebSocket: () => {
        const s = new MockRpcSocket();
        sockets.push(s);
        activeSocket = s;
        if (connFailCount > 0) {
          connFailCount--;
          queueMicrotask(() => s.close());
          return s;
        }
        const origSend = s.send.bind(s);
        s.send = (raw: string) => {
          origSend(raw);
          const frame = JSON.parse(raw) as Record<string, unknown>;
          if (frame._tag !== 'Request') return;
          queueMicrotask(() => {
            if (frame.tag === 'server.getConfig') {
              s.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { providers: [] } } });
            } else if (frame.tag === 'orchestration.dispatchCommand') {
              dispatchedCommands.push(frame.payload as Record<string, unknown>);
              if (failDispatchWithServerError) {
                s.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Failure', cause: { _tag: 'Fail', error: { message: 'Invalid workspace' } } } });
              } else {
                s.receive({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value: { sequence: 55 } } });
              }
            }
          });
        };
        s.open();
        return s;
      },
      onReconnectExhausted: exhausted,
      randomFn: () => 0,
    });

    await backend.connect('E:\\Repo', 'proj-1');
    expect(shellAttempt).toBe(2); // 401 triggered automatic renewal + retry

    // Verify shell stream & config stream live deltas
    const shellReq = activeSocket!.sent.find(f => f.tag === 'orchestration.subscribeShell')!;
    const cfgReq = activeSocket!.sent.find(f => f.tag === 'subscribeServerConfig')!;
    activeSocket!.receive({
      _tag: 'Chunk',
      requestId: shellReq.id,
      values: [{ kind: 'thread.updated', sequence: 52, location: 'active', thread: { id: 'th-live', projectId: 'proj-1', title: 'Live', status: 'idle' } }],
    });
    expect(store.getSnapshot().threads.map(t => t.threadId)).toEqual(['th-live']);
    activeSocket!.receive({
      _tag: 'Chunk',
      requestId: cfgReq.id,
      values: [{ type: 'snapshot', config: { providers: [{ instanceId: 'codex', displayName: 'Codex', enabled: true, installed: true, status: 'ready', models: [] }] } }],
    });
    expect(store.getSnapshot().providers).toHaveLength(1);

    // Mid-thread setters & inspectPendingWrite states
    await backend.setModelSelection('th-live', 'c1', { instanceId: 'codex', model: 'gpt-5' });
    await backend.setRuntimeMode('th-live', 'c2', 'approval-required');
    await backend.setInteractionMode('th-live', 'c3', 'plan');
    expect(dispatchedCommands.map(c => c.type)).toEqual([
      'thread.model-selection.set',
      'thread.runtime-mode.set',
      'thread.interaction-mode.set',
    ]);

    expect(await backend.inspectPendingWrite('th-1', 'msg-x')).toBe('missing');
    boundedStatus = 500;
    expect(await backend.inspectPendingWrite('th-1', 'msg-x')).toBe('unknown');
    boundedStatus = 200;
    expect(await backend.inspectPendingWrite('th-1', 'msg-x')).toBe('thread-only');
    boundedHasMsg = true;
    expect(await backend.inspectPendingWrite('th-1', 'msg-x')).toBe('committed');

    // Non-transport business error must reject cleanly without UncertainWriteError
    failDispatchWithServerError = true;
    const errPromise = backend.sendMessage({ projectId: 'proj-1', threadId: 'th-live', commandId: 'c4', messageId: 'm4', text: 'hi' });
    await expect(errPromise).rejects.toThrow('Invalid workspace');
    await expect(errPromise).rejects.not.toBeInstanceOf(UncertainWriteError);

    // Exhaust MAX_RECONNECT_ATTEMPTS (5 failures) -> notifies exhausted callback
    vi.useFakeTimers();
    try {
      connFailCount = 10;
      activeSocket!.close();
      await vi.runAllTimersAsync();
      expect(exhausted).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    await backend.disconnect();
  });
});
