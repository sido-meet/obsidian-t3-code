import { describe, expect, it, vi } from 'vitest';
import { CLI_BACKEND_CAPABILITIES } from '../src/t3/backend';
import { CliBackend } from '../src/t3/cli-backend';

describe('CliBackend', () => {
  it('connects via CLI check, exposes configured providers/reasoning presets, and disconnects cleanly', async () => {
    const signals: AbortSignal[] = [];
    const runner = vi.fn(async (args: string[]) => {
      if (args[1] === 'list') return [{ threadId: 'th-1', title: 'Alpha', status: 'idle', projectId: 'proj-1' }];
      return {};
    });
    const backend = new CliBackend({
      getSettings: () => ({
        cliPath: 't3',
        provider: 'codex',
        model: 'gpt-6.2-sol',
        modelPresets: 'codex | gpt-6.2-sol | reasoningEffort=low\ncodex | gpt-6.2-sol | reasoningEffort=high\nclaudeAgent | claude-sonnet-5-5 | effort=medium',
      }),
      createRunner: (_path, signal) => {
        signals.push(signal);
        return runner;
      },
    });

    const caps = await backend.connect('/ws/proj', 'proj-1');
    expect(caps).toEqual(CLI_BACKEND_CAPABILITIES);
    expect(await backend.listThreads('proj-1')).toHaveLength(1);

    const providers = await backend.getProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].instanceId).toBe('codex');
    expect(providers[0].models[0].reasoningOption?.options?.map(o => o.id)).toEqual(['low', 'high']);
    expect(providers[0].quota.status).toBe('unsupported');

    await backend.disconnect();
    expect(signals[0].aborted).toBe(true);
  });

  it('polls active threads, emits errors gracefully, sends messages, and rejects unsupported RPC-only actions', async () => {
    vi.useFakeTimers();
    try {
      let showCalls = 0;
      const backend = new CliBackend({
        pollIntervalMs: 500,
        getSettings: () => ({ cliPath: 't3', provider: 'codex', model: 'gpt-6.2-sol', modelPresets: '' }),
        createRunner: () => async (args: string[]) => {
          if (args[1] === 'start') return { threadId: 'th-new', runId: 'run-1' };
          if (args[1] === 'show') {
            showCalls++;
            if (showCalls === 1) {
              return { thread: { threadId: 'th-new', title: 'New', status: 'running' }, messages: [{ role: 'user', text: 'hi' }] };
            }
            if (showCalls === 2) {
              return { thread: { threadId: 'th-new', title: 'New', status: 'completed' }, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'done' }] };
            }
            throw new Error('read err');
          }
          return [];
        },
      });

      const sent = await backend.sendMessage({
        projectId: 'proj-1',
        commandId: 'c1',
        messageId: 'm1',
        text: 'hello',
        modelSelection: { instanceId: 'codex', model: 'gpt-6.2-sol', options: [{ id: 'reasoningEffort', value: 'high' }] },
      });
      expect(sent).toEqual({ threadId: 'th-new', runId: 'run-1' });

      const events: unknown[] = [];
      const sub = await backend.openThread('th-new', ev => events.push(ev));
      expect(events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(events).toHaveLength(2);
      sub.unsubscribe();

      const errEvents: unknown[] = [];
      await backend.openThread('th-new', ev => errEvents.push(ev));
      expect(errEvents[0]).toEqual({ type: 'error', message: 'read err' });

      await expect(backend.stopThread()).rejects.toThrow('CLI 降级模式');
      await expect(backend.setModelSelection()).rejects.toThrow('CLI 降级模式');
      await expect(backend.setRuntimeMode()).rejects.toThrow('CLI 降级模式');
      await expect(backend.setInteractionMode()).rejects.toThrow('CLI 降级模式');
      await expect(backend.respondRuntimeRequest({ threadId: 't', requestId: 'r', commandId: 'c', decision: 'decline' })).rejects.toThrow('CLI 降级模式');
    } finally {
      vi.useRealTimers();
    }
  });
});
