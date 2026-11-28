import { describe, expect, it } from 'vitest';
import type { CliThread } from '../src/t3/cli';
import {
  COMPACT_TOOLBAR_MAX_WIDTH,
  WIDE_LAYOUT_MIN_WIDTH,
  buildModelCatalog,
  buildModelCatalogFromProviders,
  filterThreads,
  formatContextUsage,
  formatElapsedMs,
  formatModelTrigger,
  formatQuotaSummary,
  groupThreads,
  parseEffortLabel,
  resolveLayoutMode,
  resolveStatusBanner,
  resolveTabBadgeStatus,
} from '../src/ui/sidebar-model';

describe('sidebar-model layout breakpoints', () => {
  it('resolves narrow, single, and wide modes at 300px and 600px boundaries', () => {
    expect(COMPACT_TOOLBAR_MAX_WIDTH).toBe(300);
    expect(WIDE_LAYOUT_MIN_WIDTH).toBe(600);
    expect(resolveLayoutMode(240)).toBe('narrow');
    expect(resolveLayoutMode(299)).toBe('narrow');
    expect(resolveLayoutMode(300)).toBe('single');
    expect(resolveLayoutMode(360)).toBe('single');
    expect(resolveLayoutMode(599)).toBe('single');
    expect(resolveLayoutMode(600)).toBe('wide');
    expect(resolveLayoutMode(728)).toBe('wide');
  });
});

describe('sidebar-model Agent · Model · Effort catalog and trigger', () => {
  it('parses reasoning effort options into human labels and 1-4 signal bars', () => {
    expect(parseEffortLabel()).toBeUndefined();
    expect(parseEffortLabel('')).toBeUndefined();
    expect(parseEffortLabel('invalid-no-equals')).toBeUndefined();
    expect(parseEffortLabel('effort=')).toBeUndefined();
    expect(parseEffortLabel('reasoningEffort=low')).toEqual({ label: 'Low', bars: 1 });
    expect(parseEffortLabel('effort=minimal')).toEqual({ label: 'Low', bars: 1 });
    expect(parseEffortLabel('effort=medium')).toEqual({ label: 'Medium', bars: 2 });
    expect(parseEffortLabel('reasoningEffort=high')).toEqual({ label: 'High', bars: 3 });
    expect(parseEffortLabel('reasoningEffort=xhigh')).toEqual({ label: 'xHigh', bars: 4 });
    expect(parseEffortLabel('thinking=max')).toEqual({ label: 'Max', bars: 4 });
    expect(parseEffortLabel('effort=ultrathink')).toEqual({ label: 'Max', bars: 4 });
    expect(parseEffortLabel('speed=fast')).toEqual({ label: 'fast', bars: 2 });
  });

  it('groups configured model selections by Agent and model without inventing entries', () => {
    const groups = buildModelCatalog([
      { provider: 'codex', model: 'gpt-5.4' },
      { provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=low' },
      { provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=high' },
      { provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=high' },
      { provider: 'claude', model: 'sonnet', option: 'effort=medium' },
      { provider: 'claude', model: 'opus', option: 'invalid-effort' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      provider: 'codex',
      models: [
        {
          provider: 'codex',
          model: 'gpt-5.4',
          subtitle: 'codex',
          defaultSelection: { provider: 'codex', model: 'gpt-5.4' },
          efforts: [
            { option: 'reasoningEffort=low', label: 'Low', bars: 1, selection: { provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=low' } },
            { option: 'reasoningEffort=high', label: 'High', bars: 3, selection: { provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=high' } },
          ],
        },
      ],
    });
    expect(groups[1].models[0].efforts).toHaveLength(1);
    expect(groups[1].models[1].efforts).toEqual([]);
  });

  it('formats Agent · Model · Effort trigger for drafts and existing CLI threads', () => {
    expect(formatModelTrigger()).toEqual({ primary: 'Agent · 模型', full: 'Agent · 模型' });
    expect(formatModelTrigger({ provider: 'codex', model: 'gpt-5.4' })).toEqual({
      primary: 'codex · gpt-5.4',
      full: 'codex · gpt-5.4',
    });
    expect(formatModelTrigger({ provider: 'codex', model: 'gpt-5.4', option: 'reasoningEffort=high' })).toEqual({
      primary: 'codex · gpt-5.4',
      secondary: 'High',
      full: 'codex · gpt-5.4 · High',
    });
    expect(formatModelTrigger(
      { provider: 'claude', model: 'opus', option: 'effort=max' },
      { threadId: 't1', title: 'T', status: 'idle', providerInstanceId: 'codex-p', model: 'gpt-5.4' },
    )).toEqual({
      primary: 'codex-p · gpt-5.4',
      full: 'codex-p · gpt-5.4',
    });
    expect(formatModelTrigger(
      undefined,
      { threadId: 't2', title: 'T2', status: 'idle' },
    )).toEqual({
      primary: 'Agent · 模型',
      full: 'Agent · 模型',
    });
  });
});

describe('sidebar-model session filtering, grouping, tabs, and silent banners', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z');
  const threads: CliThread[] = [
    { threadId: 'a', title: 'Archived', status: 'idle', archived: true },
    { threadId: 'p', title: 'Pinned Sync', status: 'completed', pinned: true, settled: true, updatedAt: '2026-11-10T00:00:00.000Z' },
    { threadId: 'w', title: 'Active Run', status: 'running', model: 'gpt-5.4', providerInstanceId: 'codex', updatedAt: '2026-11-27T11:00:00.000Z' },
    { threadId: 'q', title: 'Wait Approval', status: 'idle', pendingRequestCount: 1, createdAt: '2026-11-26T10:00:00.000Z' },
    { threadId: 'o', title: 'Old Session', status: 'completed', settled: true, updatedAt: '2026-11-01T00:00:00.000Z' },
    { threadId: 'u', title: 'No Timestamp', status: 'idle' },
  ];

  it('filters out archived threads and searches title/provider/model', () => {
    expect(filterThreads(threads, '').map(t => t.threadId)).toEqual(['p', 'w', 'q', 'o', 'u']);
    expect(filterThreads(threads, 'GPT-5.4').map(t => t.threadId)).toEqual(['w']);
    expect(filterThreads(threads, 'sync').map(t => t.threadId)).toEqual(['p']);
  });

  it('groups threads by time and T3 Inbox state', () => {
    const byTime = groupThreads(filterThreads(threads, ''), 'time', now);
    expect(byTime.map(g => [g.label, g.threads.map(t => t.threadId)])).toEqual([
      ['置顶', ['p']],
      ['最近 7 天', ['w', 'q', 'u']],
      ['更早', ['o']],
    ]);

    const byInbox = groupThreads(filterThreads(threads, ''), 'inbox', now);
    expect(byInbox.map(g => [g.label, g.threads.map(t => t.threadId)])).toEqual([
      ['进行中 / 待处理', ['w', 'q']],
      ['活跃会话', ['u']],
      ['已完成 (Settled)', ['p', 'o']],
    ]);
  });

  it('resolves tab badge border status', () => {
    expect(resolveTabBadgeStatus({ status: 'waiting' })).toBe('action');
    expect(resolveTabBadgeStatus({ status: 'idle', pendingRequestCount: 2 })).toBe('action');
    expect(resolveTabBadgeStatus({ status: 'running' })).toBe('running');
    expect(resolveTabBadgeStatus({ status: 'failed' })).toBe('error');
    expect(resolveTabBadgeStatus({ status: 'completed', unread: true })).toBe('done');
    expect(resolveTabBadgeStatus({ status: 'idle' })).toBe('idle');
  });

  it('stays completely silent when connected normally and only surfaces anomalies', () => {
    expect(resolveStatusBanner({ ready: true, checking: false, blocksVaultSend: false })).toBeNull();
    expect(resolveStatusBanner({ ready: false, checking: true, blocksVaultSend: false })).toBeNull();
    expect(resolveStatusBanner({ ready: false, checking: false, blocksVaultSend: false })).toEqual({
      tone: 'error',
      message: '本地 T3 Code 未连接。',
      showRetry: true,
    });
    expect(resolveStatusBanner({
      ready: false,
      checking: false,
      error: '连接超时',
      blocksVaultSend: false,
    })).toEqual({
      tone: 'error',
      message: '连接超时',
      showRetry: true,
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      error: '请先打开要插入内容的 Markdown 笔记。',
      blocksVaultSend: false,
    })).toEqual({
      tone: 'error',
      message: '请先打开要插入内容的 Markdown 笔记。',
      showRetry: false,
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: true,
      safeLink: 'https://app.t3.codes/threads/local/t1',
    })).toEqual({
      tone: 'warning',
      message: '使用知识库目录时请在 T3 Code 中确认会话权限为需要审批。',
      showRetry: false,
      link: 'https://app.t3.codes/threads/local/t1',
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: true,
    })).toEqual({
      tone: 'warning',
      message: '使用知识库目录时请在 T3 Code 中确认会话权限为需要审批。',
      showRetry: false,
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      thread: { threadId: 't1', title: 'T', status: 'waiting' },
      safeLink: 'https://app.t3.codes/threads/local/t1',
    })).toEqual({
      tone: 'warning',
      message: '等待处理，请在 T3 Code 中查看',
      showRetry: false,
      link: 'https://app.t3.codes/threads/local/t1',
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      thread: { threadId: 't1', title: 'T', status: 'idle', pendingRequestCount: 1 },
    })).toEqual({
      tone: 'warning',
      message: '等待处理，请在 T3 Code 中查看',
      showRetry: false,
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      thread: { threadId: 't1', title: 'T', status: 'failed' },
      safeLink: 'https://app.t3.codes/threads/local/t2',
    })).toEqual({
      tone: 'error',
      message: '任务失败，请在 T3 Code 中查看详情',
      showRetry: false,
      link: 'https://app.t3.codes/threads/local/t2',
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      thread: { threadId: 't1', title: 'T', status: 'failed' },
    })).toEqual({
      tone: 'error',
      message: '任务失败，请在 T3 Code 中查看详情',
      showRetry: false,
    });
  });

  it('formats elapsed runtime in MM:SS', () => {
    expect(formatElapsedMs(-100)).toBe('耗时 00:00');
    expect(formatElapsedMs(33_000)).toBe('耗时 00:33');
    expect(formatElapsedMs(125_400)).toBe('耗时 02:05');
  });

  it('builds live catalog from server providers and formats real context usage, quotas, and RPC banners', () => {
    const groups = buildModelCatalogFromProviders([
      {
        instanceId: 'disabled-one',
        driver: 'cursor',
        displayName: 'Cursor',
        enabled: false,
        installed: false,
        status: 'disabled',
        reportsContextWindow: false,
        supportedRuntimeModes: [],
        showInteractionModeToggle: false,
        models: [],
        quota: { status: 'unknown', windows: [] },
      },
      {
        instanceId: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: true,
        supportedRuntimeModes: ['approval-required'],
        showInteractionModeToggle: true,
        models: [
          {
            providerId: 'codex',
            slug: 'gpt-6-astra',
            name: 'GPT-6 Astra',
            shortName: 'Astra',
            isDefault: true,
            reasoningOption: {
              id: 'reasoningEffort',
              type: 'select',
              label: 'Reasoning',
              currentValue: 'high',
              options: [
                { id: 'low', label: 'Low' },
                { id: 'high', label: 'High', isDefault: true },
                { id: 'custom-tier', label: 'CustomTier' },
              ],
            },
            extraOptions: [{ id: 'fast', type: 'boolean', label: 'Fast' }],
          },
          {
            providerId: 'codex',
            slug: 'gpt-mini',
            name: 'GPT Mini',
            reasoningOption: {
              id: 'effort',
              type: 'select',
              label: 'Reasoning',
              options: [{ id: 'medium', label: 'Medium', isDefault: true }],
            },
            extraOptions: [],
          },
          {
            providerId: 'codex',
            slug: 'gpt-bare',
            name: 'GPT Bare',
            extraOptions: [],
          },
        ],
        quota: { status: 'unsupported', reason: 'unsupported', windows: [] },
      },
      {
        instanceId: 'warn',
        driver: 'claudeAgent',
        displayName: 'ClaudeWarn',
        enabled: true,
        installed: true,
        status: 'warning',
        reportsContextWindow: false,
        supportedRuntimeModes: [],
        showInteractionModeToggle: false,
        models: [],
        quota: { status: 'unknown', windows: [] },
      },
      {
        instanceId: 'err-with-models',
        driver: 'other',
        displayName: 'Other',
        enabled: true,
        installed: true,
        status: 'error',
        reportsContextWindow: false,
        supportedRuntimeModes: [],
        showInteractionModeToggle: false,
        models: [{ providerId: 'err-with-models', slug: 'm1', name: 'M1', extraOptions: [] }],
        quota: { status: 'unknown', windows: [] },
      },
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0].models[0]).toMatchObject({
      model: 'gpt-6-astra',
      subtitle: 'Astra',
      isDefault: true,
      defaultSelection: { provider: 'codex', model: 'gpt-6-astra', option: 'reasoningEffort=high' },
    });
    expect(groups[0].models[0].efforts[2]).toMatchObject({ label: 'CustomTier', bars: 2 });
    expect(groups[0].models[0].extraOptions).toHaveLength(1);
    expect(groups[0].models[1].defaultSelection.option).toBe('effort=medium');
    expect(groups[0].models[2].efforts).toEqual([]);

    expect(formatModelTrigger(
      { provider: 'codex', model: 'gpt-6-astra', option: 'reasoningEffort=high' },
      { threadId: 't1', title: 'T1', status: 'idle', providerInstanceId: 'codex', model: 'gpt-6-astra' },
    )).toEqual({ primary: 'codex · gpt-6-astra', secondary: 'High', full: 'codex · gpt-6-astra · High' });

    expect(formatContextUsage(undefined)).toEqual({ shortLabel: '—', detailLines: ['当前会话暂无上下文窗口用量数据'] });
    expect(formatContextUsage({
      status: 'available',
      usedTokens: 25_000,
      maxTokens: 100_000,
      inputTokens: 20_000,
      cachedInputTokens: 5_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      percent: 25.4,
    })).toEqual({
      shortLabel: '25%',
      percent: 25,
      detailLines: [
        '已用 25,000 / 100,000 tokens',
        '输入 20,000（缓存 5,000）',
        '输出 5,000（思考 1,000）',
      ],
    });
    expect(formatContextUsage({ status: 'available', inputTokens: 10, outputTokens: 2 })).toEqual({
      shortLabel: '0',
      detailLines: ['已用 0 tokens', '输入 10', '输出 2'],
    });
    expect(formatContextUsage({ status: 'available', usedTokens: 4096 }).shortLabel).toBe('4096');

    expect(formatQuotaSummary()).toEqual([{ label: '账号额度', value: '未知 / Provider 未提供' }]);
    expect(formatQuotaSummary({ status: 'loading', windows: [] })).toEqual([{ label: '账号额度', value: '查询中…' }]);
    expect(formatQuotaSummary({ status: 'error', reason: 'timeout', windows: [] })).toEqual([{ label: '账号额度', value: 'timeout' }]);
    expect(formatQuotaSummary({ status: 'error', windows: [] })).toEqual([{ label: '账号额度', value: '额度查询失败' }]);
    expect(formatQuotaSummary({ status: 'unsupported', reason: 'unsupported', windows: [] })).toEqual([
      { label: '账号额度', value: '当前 Provider 暂不支持额度查询' },
    ]);
    expect(formatQuotaSummary({ status: 'unsupported', reason: 'plan disabled', windows: [] })).toEqual([
      { label: '账号额度', value: 'plan disabled' },
    ]);
    expect(formatQuotaSummary({
      status: 'available',
      windows: [
        { id: 'w1', kind: 'session', label: '5h Window', usedPercent: 42.3, resetsAt: '2026-11-28T08:30:00Z' },
        { id: 'w2', kind: 'weekly', label: 'Weekly', usedPercent: 10 },
      ],
    })).toEqual([
      { label: '5h Window', value: '42% · 重置 2026-11-28 08:30' },
      { label: 'Weekly', value: '10%' },
    ]);

    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      hasUncertainDispatch: true,
    })).toEqual({
      tone: 'warning',
      message: '上一条消息发送状态待确认，请点重试向服务端核对（不会重复发送）。',
      showRetry: true,
    });
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      supportsApprovals: true,
      thread: { threadId: 't1', title: 'T', status: 'waiting', pendingRequestCount: 1 },
    })).toBeNull();
    expect(resolveStatusBanner({
      ready: true,
      checking: false,
      blocksVaultSend: false,
      connectionPhase: 'fallback-cli',
      fallbackReason: 'RPC 离线',
    })).toEqual({
      tone: 'warning',
      message: 'CLI 降级模式：RPC 离线',
      showRetry: true,
    });
  });
});
