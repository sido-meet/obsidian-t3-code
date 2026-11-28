import { describe, expect, it } from 'vitest';
import {
  extractContextUsage,
  parseProviderQuota,
  parseServerProviders,
  parseShellSnapshot,
  parseThreadSnapshot,
  parseV2Thread,
  reduceThreadStreamItem,
  type ThreadStreamAccumulator,
} from '../src/t3/protocol-v2';

describe('protocol-v2 normalizers', () => {
  it('parses provider descriptors across codex, claudeAgent, antigravity, and disabled providers', () => {
    const providers = parseServerProviders([
      {
        instanceId: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: true,
        supportedRuntimeModes: ['approval-required', 'full-access'],
        showInteractionModeToggle: true,
        usageLimits: { checkedAt: '2026-11-28T03:00:00Z', unavailable: { reason: 'unsupported' }, windows: [] },
        optionDescriptors: [
          {
            id: 'reasoningEffort',
            type: 'select',
            label: 'Reasoning',
            options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }],
          },
          { id: 'serviceTier', type: 'select', label: 'Tier', options: [{ id: 'fast', label: 'Fast' }] },
        ],
        models: [{ slug: 'gpt-5', name: 'GPT 5', isDefault: true }],
      },
      {
        instanceId: 'claudeAgent',
        driver: 'claudeAgent',
        displayName: 'Claude',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: true,
        supportedRuntimeModes: ['approval-required'],
        showInteractionModeToggle: true,
        usageLimits: {
          checkedAt: '2026-11-28T03:00:00Z',
          windows: [{ id: 'w1', kind: 'session', label: '5h', usedPercent: 120, resetsAt: '2026-11-28T08:00:00Z', windowDurationMins: 300 }],
        },
        models: [{
          slug: 'claude-sonnet',
          name: 'Sonnet',
          capabilities: {
            optionDescriptors: [
              { id: 'effort', type: 'select', label: 'Reasoning', options: [{ id: 'ultrathink', label: 'Ultra' }] },
              { id: 'fastMode', type: 'boolean', label: 'Fast', currentValue: false },
            ],
          },
        }],
      },
      {
        instanceId: 'antigravity',
        driver: 'antigravity',
        displayName: 'Antigravity',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: false,
        usageLimits: null,
        optionDescriptors: [
          { id: 'thought_level', type: 'select', role: 'reasoning', label: 'Thinking Level', options: [{ id: 'xhigh', label: 'xHigh' }] },
        ],
        models: [{ slug: 'gemini-3', name: 'Gemini 3' }],
      },
      { instanceId: 'cursor', enabled: false, installed: false, status: 'disabled', models: [] },
    ]);

    expect(providers).toHaveLength(4);
    expect(providers[0].quota).toEqual({ status: 'unsupported', reason: 'unsupported', checkedAt: '2026-11-28T03:00:00Z', windows: [] });
    expect(providers[0].models[0].reasoningOption?.id).toBe('reasoningEffort');
    expect(providers[0].models[0].extraOptions.map(o => o.id)).toEqual(['serviceTier']);

    expect(providers[1].quota).toEqual({
      status: 'available',
      checkedAt: '2026-11-28T03:00:00Z',
      windows: [{ id: 'w1', kind: 'session', label: '5h', usedPercent: 100, resetsAt: '2026-11-28T08:00:00Z', windowDurationMins: 300 }],
    });
    expect(providers[1].models[0].reasoningOption?.id).toBe('effort');
    expect(providers[1].models[0].extraOptions[0]).toMatchObject({ id: 'fastMode', type: 'boolean', currentValue: false });

    expect(providers[2].quota).toEqual({ status: 'unknown', windows: [] });
    expect(providers[2].models[0].reasoningOption?.id).toBe('thought_level');
    expect(providers[3].status).toBe('disabled');
    expect(parseProviderQuota({ checkedAt: 'now', windows: [] })).toEqual({ status: 'unknown', checkedAt: 'now', windows: [] });
  });

  it('parses shell snapshots, filters deleted entries, and normalizes threads', () => {
    expect(parseShellSnapshot({ resumable: true })).toEqual({
      resumable: true,
      snapshotSequence: 0,
      projects: [],
      threads: [],
    });

    const parsed = parseShellSnapshot({
      snapshotSequence: 42,
      projects: [
        { id: 'p1', title: 'Repo', workspaceRoot: 'E:\\Repo' },
        { id: 'p2', title: 'Archived', workspaceRoot: 'E:\\Old', archivedAt: '2026-01-01' },
      ],
      threads: [
        {
          id: 'th-1',
          title: 'Active',
          projectId: 'p1',
          status: 'waiting',
          modelSelection: { instanceId: 'codex', model: 'gpt-5' },
          pendingRuntimeRequest: { id: 'req-1', status: 'pending' },
          pinnedAt: '2026-11-28',
        },
        { id: 'th-del', title: 'Deleted', deletedAt: '2026-11-28' },
      ],
    });
    expect(parsed.snapshotSequence).toBe(42);
    expect(parsed.projects).toEqual([{ id: 'p1', title: 'Repo', workspaceRoot: 'E:\\Repo' }]);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0]).toMatchObject({
      threadId: 'th-1',
      providerInstanceId: 'codex',
      model: 'gpt-5',
      pinned: true,
      pendingRequestCount: 1,
    });
    expect(parseV2Thread({})).toBeUndefined();
  });

  it('extracts contextUsage in strict priority order and falls back cleanly to unknown', () => {
    // 1. Active providerThread turn wins, falling back to any turn if activePtId lacks one
    expect(extractContextUsage({
      thread: { activeProviderThreadId: 'pt-2' },
      providerTurns: [
        { id: 't1', providerThreadId: 'pt-1', tokenUsage: { usedTokens: 100, maxTokens: 1000, updatedAt: '2026-11-28T01:00:00Z' } },
        { id: 't2', providerThreadId: 'pt-2', tokenUsage: { usedTokens: 250, maxTokens: 1000, inputTokens: 200, cachedInputTokens: 50, outputTokens: 50, reasoningOutputTokens: 10, updatedAt: '2026-11-28T02:00:00Z' } },
      ],
      providerThreads: [{ id: 'pt-2', contextUsage: { usedTokens: 999, maxTokens: 1000 } }],
    })).toEqual({
      status: 'available',
      usedTokens: 250,
      maxTokens: 1000,
      inputTokens: 200,
      cachedInputTokens: 50,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      percent: 25,
      source: 'providerTurn',
      updatedAt: '2026-11-28T02:00:00Z',
    });

    // Fallback to any turn when activePtId has no turn usage yet
    expect(extractContextUsage({
      thread: { activeProviderThreadId: 'pt-new' },
      providerTurns: [{ id: 't1', providerThreadId: 'pt-old', tokenUsage: { usedTokens: 120, maxTokens: 400 } }],
    })).toMatchObject({ status: 'available', usedTokens: 120, percent: 30, source: 'providerTurn' });

    // Context transfer fallback
    expect(extractContextUsage({
      contextTransfers: [{ sourceTokenUsage: { usedTokens: 80, maxTokens: 200 } }],
    })).toMatchObject({ status: 'available', usedTokens: 80, percent: 40, source: 'providerTurn' });

    // 2. ProviderThread fallback
    expect(extractContextUsage({
      thread: { activeProviderThreadId: 'pt-1' },
      providerThreads: [{ id: 'pt-1', contextUsage: { usedTokens: 300, maxTokens: 600 } }],
    })).toMatchObject({ status: 'available', usedTokens: 300, percent: 50, source: 'providerThread' });

    // 3. Compaction fallback & unknown
    expect(extractContextUsage({
      turnItems: [{ id: 'c1', type: 'compaction', afterTokenCount: 4096 }],
    })).toEqual({ status: 'available', usedTokens: 4096, source: 'compaction' });
    expect(extractContextUsage({})).toEqual({ status: 'unknown' });
  });

  it('reduces snapshot, non-contiguous global sequences, deduplication, unknown events, and mutations', () => {
    const acc: ThreadStreamAccumulator = { rawProjection: {}, seenEventIds: new Set() };
    const snapRes = reduceThreadStreamItem(acc, {
      kind: 'snapshot',
      snapshotSequence: 10,
      projection: {
        thread: { id: 'th-1', title: 'Demo', status: 'running' },
        runs: [{ id: 'run-1', status: 'running' }],
        messages: [{ id: 'm1', role: 'user', text: 'hi', streaming: false }],
        turnItems: [],
        runtimeRequests: [],
        providerTurns: [],
        providerThreads: [],
      },
    }, 'th-1');
    expect(snapRes.detail?.activeRunId).toBe('run-1');
    expect(snapRes.detail?.lastSequence).toBe(10);

    expect(reduceThreadStreamItem(acc, { kind: 'synchronized' }, 'th-1').detail?.synchronized).toBe(true);

    // Non-contiguous global sequence jump (10 -> 25) MUST NOT force resync
    const msgUpdate = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 25,
      event: { id: 'ev-1', type: 'message.created', payload: { id: 'm2', role: 'assistant', text: 'Hel', streaming: true } },
    }, 'th-1');
    expect(msgUpdate.resyncRequired).toBe(false);
    expect(msgUpdate.detail?.lastSequence).toBe(25);
    expect(msgUpdate.detail?.messages).toHaveLength(2);

    // Duplicate sequence or eventId dropped
    expect(reduceThreadStreamItem(acc, { kind: 'event', sequence: 25, event: { id: 'ev-other', type: 'message.updated', payload: { id: 'm2', role: 'assistant', text: 'x' } } }, 'th-1').detail).toBeUndefined();
    expect(reduceThreadStreamItem(acc, { kind: 'event', sequence: 26, event: { id: 'ev-1', type: 'message.updated', payload: { id: 'm2', role: 'assistant', text: 'x' } } }, 'th-1').detail).toBeUndefined();

    // unknown-event advances cursor
    const unknownEv = reduceThreadStreamItem(acc, { kind: 'unknown-event', sequence: 28 }, 'th-1');
    expect(unknownEv.detail?.lastSequence).toBe(28);

    // turn-item, runtime-request with supportsFeedback gating, provider-turn, run completion, snapshot-required
    reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 30,
      event: { id: 'ev-3', type: 'turn-item.updated', payload: { id: 'ti-1', type: 'command', toolName: 'rg', status: 'completed', command: 'rg foo' } },
    }, 'th-1');
    const reqEv = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 31,
      event: {
        id: 'ev-4',
        type: 'runtime-request.updated',
        payload: {
          id: 'req-1',
          kind: 'command',
          status: 'pending',
          responseCapability: { type: 'live', supportsFeedback: true },
          detail: { title: 'Run tests', command: 'npm test', description: 'Execute Vitest' },
        },
      },
    }, 'th-1');
    expect(reqEv.detail?.runtimeRequests[0]).toMatchObject({
      id: 'req-1',
      command: 'npm test',
      detail: 'Execute Vitest',
      supportsFeedback: true,
    });
    expect(reqEv.detail?.thread.pendingRequestCount).toBe(1);

    const turnEv = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 32,
      event: { id: 'ev-5', type: 'provider-turn.updated', payload: { id: 'pturn-1', tokenUsage: { usedTokens: 500, maxTokens: 1000 } } },
    }, 'th-1');
    expect(turnEv.detail?.contextUsage).toMatchObject({ status: 'available', usedTokens: 500, percent: 50 });

    const ptEv = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 33,
      event: { id: 'ev-5b', type: 'provider-thread.updated', payload: { id: 'pt-1', contextUsage: { usedTokens: 600, maxTokens: 1000 } } },
    }, 'th-1');
    expect(ptEv.detail?.contextUsage).toMatchObject({ status: 'available', usedTokens: 500 });

    const metaEv = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 34,
      event: { id: 'ev-5c', type: 'thread.metadata-updated', payload: { id: 'th-1', title: 'Renamed', status: 'running' } },
    }, 'th-1');
    expect(metaEv.detail?.thread.title).toBe('Renamed');

    const runDone = reduceThreadStreamItem(acc, {
      kind: 'event',
      sequence: 35,
      event: { id: 'ev-6', type: 'run.updated', payload: { id: 'run-1', status: 'completed' } },
    }, 'th-1');
    expect(runDone.detail?.activeRunId).toBeUndefined();
    expect(runDone.detail?.thread.status).toBe('completed');

    expect(reduceThreadStreamItem(acc, { kind: 'snapshot-required' }, 'th-1').resyncRequired).toBe(true);

    // Direct parseThreadSnapshot without projection wrapper handles non-feedback request safely
    const direct = parseThreadSnapshot({
      thread: { id: 'th-2', status: 'waiting' },
      runtimeRequests: [{ id: 'req-2', status: 'pending', responseCapability: { type: 'live' } }],
    });
    expect(direct.detail.runtimeRequests[0].supportsFeedback).toBe(false);
  });
});
