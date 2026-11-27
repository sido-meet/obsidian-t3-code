import type { CliThread, ModelSelection } from '../t3/cli';

export const WIDE_LAYOUT_MIN_WIDTH = 600;
export const COMPACT_TOOLBAR_MAX_WIDTH = 300;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type LayoutMode = 'narrow' | 'single' | 'wide';
export type SessionGroupMode = 'time' | 'inbox';
export type TabBadgeStatus = 'action' | 'running' | 'error' | 'done' | 'idle';

export interface EffortInfo {
  label: string;
  bars: 1 | 2 | 3 | 4;
}

export interface EffortOption extends EffortInfo {
  option: string;
  selection: ModelSelection;
}

export interface ModelCatalogItem {
  provider: string;
  model: string;
  subtitle: string;
  defaultSelection: ModelSelection;
  efforts: EffortOption[];
}

export interface AgentCatalogGroup {
  provider: string;
  models: ModelCatalogItem[];
}

export interface ThreadGroup {
  label: string;
  threads: CliThread[];
}

export interface StatusBanner {
  tone: 'warning' | 'error';
  message: string;
  showRetry: boolean;
  link?: string;
}

export const ACTIVE_THREAD_STATUSES = new Set([
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'working',
]);

const EFFORT_LEVEL_MAP: Record<string, EffortInfo> = {
  low: { label: 'Low', bars: 1 },
  minimal: { label: 'Low', bars: 1 },
  medium: { label: 'Medium', bars: 2 },
  high: { label: 'High', bars: 3 },
  xhigh: { label: 'xHigh', bars: 4 },
  max: { label: 'Max', bars: 4 },
  ultrathink: { label: 'Max', bars: 4 },
};

/** Resolve sidebar layout mode from container width (aligned with Claudian DualPane breakpoints). */
export function resolveLayoutMode(width: number): LayoutMode {
  if (width >= WIDE_LAYOUT_MIN_WIDTH) return 'wide';
  if (width < COMPACT_TOOLBAR_MAX_WIDTH) return 'narrow';
  return 'single';
}

/** Parse a `key=value` CLI model option into display label and 1–4 signal bars. */
export function parseEffortLabel(option?: string): EffortInfo | undefined {
  if (!option) return undefined;
  const separator = option.indexOf('=');
  if (separator <= 0) return undefined;
  const rawValue = option.slice(separator + 1).trim();
  if (!rawValue) return undefined;
  return EFFORT_LEVEL_MAP[rawValue.toLowerCase()] ?? { label: rawValue, bars: 2 };
}

/** Group configured ModelSelection entries by Agent (provider) and model without inventing entries. */
export function buildModelCatalog(entries: readonly ModelSelection[]): AgentCatalogGroup[] {
  const groups = new Map<string, Map<string, ModelCatalogItem>>();
  for (const entry of entries) {
    let models = groups.get(entry.provider);
    if (!models) {
      models = new Map();
      groups.set(entry.provider, models);
    }
    let item = models.get(entry.model);
    if (!item) {
      item = {
        provider: entry.provider,
        model: entry.model,
        subtitle: entry.provider,
        defaultSelection: { provider: entry.provider, model: entry.model },
        efforts: [],
      };
      models.set(entry.model, item);
    }
    const parsed = parseEffortLabel(entry.option);
    if (entry.option && parsed && !item.efforts.some(existing => existing.option === entry.option)) {
      item.efforts.push({
        option: entry.option,
        label: parsed.label,
        bars: parsed.bars,
        selection: entry,
      });
    }
  }
  return [...groups.entries()].map(([provider, models]) => ({
    provider,
    models: [...models.values()],
  }));
}

/** Format the composer bottom bar `Agent · Model · Effort` trigger label. */
export function formatModelTrigger(
  selection?: ModelSelection,
  thread?: CliThread,
): { primary: string; secondary?: string; full: string } {
  if (thread) {
    const primary = [thread.providerInstanceId, thread.model].filter(Boolean).join(' · ') || 'Agent · 模型';
    return { primary, full: primary };
  }
  if (!selection) {
    return { primary: 'Agent · 模型', full: 'Agent · 模型' };
  }
  const primary = `${selection.provider} · ${selection.model}`;
  const effort = parseEffortLabel(selection.option);
  if (!effort) return { primary, full: primary };
  return {
    primary,
    secondary: effort.label,
    full: `${primary} · ${effort.label}`,
  };
}

/** Filter out archived threads and match query case-insensitively across title, provider, and model. */
export function filterThreads(threads: readonly CliThread[], query: string): CliThread[] {
  const normalized = query.trim().toLowerCase();
  return threads.filter(thread => {
    if (thread.archived) return false;
    if (!normalized) return true;
    const haystack = [thread.title, thread.providerInstanceId ?? '', thread.model ?? '']
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

function sortPinnedFirst(threads: CliThread[]): CliThread[] {
  return threads.slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

/** Group threads either chronologically (pinned / recent 7 days / older) or by T3 Inbox state. */
export function groupThreads(
  threads: readonly CliThread[],
  mode: SessionGroupMode,
  nowMs = Date.now(),
): ThreadGroup[] {
  if (mode === 'inbox') {
    const active: CliThread[] = [];
    const open: CliThread[] = [];
    const settled: CliThread[] = [];
    for (const thread of threads) {
      if (ACTIVE_THREAD_STATUSES.has(thread.status) || (thread.pendingRequestCount ?? 0) > 0) {
        active.push(thread);
      } else if (thread.settled) {
        settled.push(thread);
      } else {
        open.push(thread);
      }
    }
    return [
      { label: '进行中 / 待处理', threads: sortPinnedFirst(active) },
      { label: '活跃会话', threads: sortPinnedFirst(open) },
      { label: '已完成 (Settled)', threads: sortPinnedFirst(settled) },
    ].filter(group => group.threads.length > 0);
  }

  const pinned: CliThread[] = [];
  const recent: CliThread[] = [];
  const older: CliThread[] = [];
  for (const thread of threads) {
    if (thread.pinned) {
      pinned.push(thread);
      continue;
    }
    const tsText = thread.updatedAt ?? thread.createdAt;
    const ts = tsText ? Date.parse(tsText) : Number.NaN;
    if (Number.isNaN(ts) || nowMs - ts <= SEVEN_DAYS_MS) {
      recent.push(thread);
    } else {
      older.push(thread);
    }
  }
  return [
    { label: '置顶', threads: pinned },
    { label: '最近 7 天', threads: recent },
    { label: '更早', threads: older },
  ].filter(group => group.threads.length > 0);
}

/** Map thread runtime state and unread status to compact single-pane tab badge border states. */
export function resolveTabBadgeStatus(input: {
  status?: string;
  pendingRequestCount?: number;
  unread?: boolean;
}): TabBadgeStatus {
  if (input.status === 'waiting' || (input.pendingRequestCount ?? 0) > 0) return 'action';
  if (input.status && ACTIVE_THREAD_STATUSES.has(input.status)) return 'running';
  if (input.status === 'failed') return 'error';
  if (input.unread) return 'done';
  return 'idle';
}

/** Surface a banner only for connection faults, Vault permission blocks, pending requests, or failures. */
export function resolveStatusBanner(input: {
  ready: boolean;
  checking: boolean;
  error?: string;
  blocksVaultSend: boolean;
  thread?: CliThread;
  safeLink?: string;
}): StatusBanner | null {
  if (!input.ready && (!input.checking || input.error)) {
    return {
      tone: 'error',
      message: input.error || '本地 T3 Code 未连接。',
      showRetry: true,
    };
  }
  if (input.error) {
    return {
      tone: 'error',
      message: input.error,
      showRetry: false,
    };
  }
  if (input.blocksVaultSend) {
    return {
      tone: 'warning',
      message: '使用知识库目录时请在 T3 Code 中确认会话权限为需要审批。',
      showRetry: false,
      ...(input.safeLink ? { link: input.safeLink } : {}),
    };
  }
  if (input.thread?.status === 'waiting' || (input.thread?.pendingRequestCount ?? 0) > 0) {
    return {
      tone: 'warning',
      message: '等待处理，请在 T3 Code 中查看',
      showRetry: false,
      ...(input.safeLink ? { link: input.safeLink } : {}),
    };
  }
  if (input.thread?.status === 'failed') {
    return {
      tone: 'error',
      message: '任务失败，请在 T3 Code 中查看详情',
      showRetry: false,
      ...(input.safeLink ? { link: input.safeLink } : {}),
    };
  }
  return null;
}

/** Format an observed run duration in `耗时 MM:SS`. */
export function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `耗时 ${minutes}:${seconds}`;
}
