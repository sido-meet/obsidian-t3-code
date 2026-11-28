import { describe, expect, it, vi } from 'vitest';
import { CLI_BACKEND_CAPABILITIES, type ThreadDetail } from '../src/t3/backend';
import { T3Store } from '../src/t3/store';

function makeDetail(threadId: string): ThreadDetail {
  return {
    thread: { threadId, title: `Thread ${threadId}`, status: 'ready' },
    messages: [],
    turnItems: [],
    runtimeRequests: [],
    contextUsage: { status: 'unknown' },
    runIds: [],
    lastSequence: 5,
    synchronized: true,
  };
}

describe('T3Store', () => {
  it('initializes with idle CLI defaults and notifies subscribers on updates until unsubscribed', () => {
    const store = new T3Store();
    expect(store.getSnapshot().connectionPhase).toBe('idle');
    expect(store.getSnapshot().capabilities).toEqual(CLI_BACKEND_CAPABILITIES);

    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.setConnection('connected-rpc', { ...CLI_BACKEND_CAPABILITIES, mode: 'rpc', supportsStreaming: true });
    expect(store.getSnapshot().connectionPhase).toBe('connected-rpc');
    expect(store.getSnapshot().capabilities.supportsStreaming).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.setThreads([{ threadId: 't1', title: 'T1', status: 'idle' }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tracks active thread details and pending dispatches independently and supports reset', () => {
    const store = new T3Store();
    store.setThreadDetail('t1', makeDetail('t1'));
    store.setThreadDetail('t2', makeDetail('t2'));
    expect(store.getSnapshot().activeThreadDetails.size).toBe(2);

    store.removeThreadDetail('t1');
    store.removeThreadDetail('missing');
    expect(store.getSnapshot().activeThreadDetails.has('t1')).toBe(false);
    expect(store.getSnapshot().activeThreadDetails.has('t2')).toBe(true);

    store.upsertPendingDispatch({
      commandId: 'cmd-1',
      messageId: 'msg-1',
      projectId: 'proj-1',
      text: 'hello',
      status: 'sending',
      createdAt: 100,
    });
    expect(store.getSnapshot().pendingDispatches.get('cmd-1')?.status).toBe('sending');

    // Reset without clearDispatches preserves uncertain/in-flight recovery records
    store.reset(false);
    expect(store.getSnapshot().activeThreadDetails.size).toBe(0);
    expect(store.getSnapshot().pendingDispatches.size).toBe(1);

    store.clearPendingDispatch('missing');
    store.clearPendingDispatch('cmd-1');
    expect(store.getSnapshot().pendingDispatches.size).toBe(0);

    store.upsertPendingDispatch({
      commandId: 'cmd-2',
      messageId: 'msg-2',
      projectId: 'proj-1',
      text: 'hi',
      status: 'uncertain',
      createdAt: 200,
    });
    store.reset(true);
    expect(store.getSnapshot().pendingDispatches.size).toBe(0);
  });
});
