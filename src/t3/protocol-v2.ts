import type {
  AccountQuotaSnapshot,
  AccountQuotaWindow,
  ContextUsageSnapshot,
  ModelOptionChoice,
  ModelOptionDescriptor,
  ProviderDescriptor,
  ProviderModelDescriptor,
  RuntimeRequestItem,
  ThreadDetail,
  TurnItemSummary,
} from './backend';
import type { CliThread } from './cli';
import { record } from './rpc';
import type { Message } from './transcript';

const REASONING_OPTION_ID_RE = /^(?:reasoningEffort|effort|thought_level|thinking)$/i;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseOptionDescriptor(raw: unknown): ModelOptionDescriptor | undefined {
  const row = record(raw);
  const id = str(row.id);
  const label = str(row.label) ?? id;
  if (!id || !label) return undefined;
  if (row.type === 'boolean') {
    return {
      id,
      type: 'boolean',
      label,
      ...(str(row.role) ? { role: str(row.role) } : {}),
      ...(typeof row.currentValue === 'boolean' ? { currentValue: row.currentValue } : {}),
    };
  }
  if (row.type === 'select') {
    const choices = (Array.isArray(row.options) ? row.options : []).flatMap((choice): ModelOptionChoice[] => {
      const c = record(choice);
      const cid = str(c.id);
      if (!cid) return [];
      return [{ id: cid, label: str(c.label) ?? cid, ...(c.isDefault === true ? { isDefault: true } : {}) }];
    });
    return {
      id,
      type: 'select',
      label,
      ...(str(row.role) ? { role: str(row.role) } : {}),
      ...(typeof row.currentValue === 'string' ? { currentValue: row.currentValue } : {}),
      options: choices,
    };
  }
  return undefined;
}

function parseUsageWindow(raw: unknown): AccountQuotaWindow | undefined {
  const w = record(raw);
  const id = str(w.id);
  const label = str(w.label) ?? id;
  const usedPercent = num(w.usedPercent);
  if (!id || !label || usedPercent === undefined) return undefined;
  const rawKind = w.kind;
  const kind = rawKind === 'session' || rawKind === 'weekly' || rawKind === 'monthly' ? rawKind : 'other';
  return {
    id,
    kind,
    label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(str(w.resetsAt) ? { resetsAt: str(w.resetsAt) } : {}),
    ...(num(w.windowDurationMins) !== undefined ? { windowDurationMins: num(w.windowDurationMins) } : {}),
  };
}

export function parseProviderQuota(raw: unknown): AccountQuotaSnapshot {
  if (raw === null || raw === undefined) {
    return { status: 'unknown', windows: [] };
  }
  const q = record(raw);
  const checkedAt = str(q.checkedAt);
  const unavailable = record(q.unavailable);
  const reason = str(unavailable.reason);
  const windows = (Array.isArray(q.windows) ? q.windows : []).flatMap(w => {
    const parsed = parseUsageWindow(w);
    return parsed ? [parsed] : [];
  });
  if (windows.length > 0) {
    return { status: 'available', ...(checkedAt ? { checkedAt } : {}), windows };
  }
  if (reason) {
    return { status: 'unsupported', reason, ...(checkedAt ? { checkedAt } : {}), windows: [] };
  }
  return { status: 'unknown', ...(checkedAt ? { checkedAt } : {}), windows: [] };
}

function parseProviderModel(providerId: string, raw: unknown, providerDescriptors: unknown[]): ProviderModelDescriptor | undefined {
  const m = record(raw);
  const slug = str(m.slug);
  if (!slug) return undefined;
  const caps = record(m.capabilities);
  const rawDescriptors = Array.isArray(caps.optionDescriptors) ? caps.optionDescriptors : providerDescriptors;
  let reasoningOption: ModelOptionDescriptor | undefined;
  const extraOptions: ModelOptionDescriptor[] = [];

  for (const rawDesc of rawDescriptors) {
    const parsed = parseOptionDescriptor(rawDesc);
    if (!parsed) continue;
    const isReasoning = parsed.type === 'select'
      && (parsed.role === 'reasoning' || REASONING_OPTION_ID_RE.test(parsed.id));
    if (isReasoning && !reasoningOption) {
      reasoningOption = parsed;
    } else {
      extraOptions.push(parsed);
    }
  }

  return {
    providerId,
    slug,
    name: str(m.name) ?? slug,
    ...(str(m.shortName) ? { shortName: str(m.shortName) } : {}),
    ...(m.isDefault === true ? { isDefault: true } : {}),
    ...(m.isLegacy === true ? { isLegacy: true } : {}),
    ...(reasoningOption ? { reasoningOption } : {}),
    extraOptions,
  };
}

/** Parses `server.getConfig` (or `subscribeServerConfig` snapshot) providers into UI/backend descriptors. */
export function parseServerProviders(rawProviders: unknown): ProviderDescriptor[] {
  if (!Array.isArray(rawProviders)) return [];
  return rawProviders.flatMap((raw): ProviderDescriptor[] => {
    const p = record(raw);
    const instanceId = str(p.instanceId);
    if (!instanceId) return [];
    const providerDescriptors = Array.isArray(p.optionDescriptors) ? p.optionDescriptors : [];
    const models = (Array.isArray(p.models) ? p.models : []).flatMap(m => {
      const parsed = parseProviderModel(instanceId, m, providerDescriptors);
      return parsed ? [parsed] : [];
    });
    const rawStatus = p.status;
    const status = rawStatus === 'ready' || rawStatus === 'warning' || rawStatus === 'error' || rawStatus === 'disabled'
      ? rawStatus : 'disabled';
    const supportedRuntimeModes = Array.isArray(p.supportedRuntimeModes)
      ? p.supportedRuntimeModes.filter((m): m is string => typeof m === 'string')
      : [];

    return [{
      instanceId,
      driver: str(p.driver) ?? instanceId,
      displayName: str(p.displayName) ?? instanceId,
      enabled: p.enabled === true,
      installed: p.installed === true,
      status,
      reportsContextWindow: p.reportsContextWindow === true,
      supportedRuntimeModes,
      showInteractionModeToggle: p.showInteractionModeToggle === true,
      models,
      quota: parseProviderQuota(p.usageLimits),
    }];
  });
}

function parseThreadSelection(rawSel: unknown): { providerInstanceId?: string; model?: string } {
  const sel = record(rawSel);
  return {
    ...(str(sel.instanceId) ? { providerInstanceId: str(sel.instanceId) } : {}),
    ...(str(sel.model) ? { model: str(sel.model) } : {}),
  };
}

/** Normalizes an Orchestrator v2 shell/projection thread record into `CliThread`. */
export function parseV2Thread(raw: unknown): CliThread | undefined {
  const t = record(raw);
  const threadId = str(t.id) ?? str(t.threadId);
  if (!threadId) return undefined;
  const sel = parseThreadSelection(t.modelSelection);
  const pendingReq = record(t.pendingRuntimeRequest);
  const hasPending = Boolean(str(pendingReq.id) && pendingReq.status === 'pending');
  const settled = Boolean(t.settledAt) || t.settledOverride === 'settled';
  const pinned = Boolean(t.pinnedAt);
  const snoozed = Boolean(t.snoozedUntil || t.snoozedAt);
  const archived = Boolean(t.archivedAt);
  const status = str(t.status) ?? 'idle';

  return {
    threadId,
    title: str(t.title) ?? '未命名会话',
    status,
    ...(str(t.projectId) ? { projectId: str(t.projectId) } : {}),
    ...(str(t.providerInstanceId) ?? sel.providerInstanceId
      ? { providerInstanceId: str(t.providerInstanceId) ?? sel.providerInstanceId }
      : {}),
    ...(sel.model ?? str(t.model) ? { model: sel.model ?? str(t.model) } : {}),
    ...(str(t.runtimeMode) ? { runtimeMode: str(t.runtimeMode) } : {}),
    ...(str(t.interactionMode) ? { interactionMode: str(t.interactionMode) } : {}),
    ...(str(t.link) ? { link: str(t.link) } : {}),
    settled,
    pinned,
    snoozed,
    archived,
    ...(hasPending ? { pendingRequestCount: 1 } : {}),
    ...(str(t.createdAt) ? { createdAt: str(t.createdAt) } : {}),
    ...(str(t.updatedAt) ? { updatedAt: str(t.updatedAt) } : {}),
  };
}

export function parseShellSnapshot(raw: unknown): {
  resumable: boolean;
  snapshotSequence: number;
  projects: Array<{ id: string; title: string; workspaceRoot: string }>;
  threads: CliThread[];
} {
  const obj = record(raw);
  if (obj.resumable === true) {
    return { resumable: true, snapshotSequence: 0, projects: [], threads: [] };
  }
  const snapshotSequence = num(obj.snapshotSequence) ?? 0;
  const projects = (Array.isArray(obj.projects) ? obj.projects : []).flatMap(rawProj => {
    const p = record(rawProj);
    const id = str(p.id);
    const workspaceRoot = str(p.workspaceRoot);
    if (!id || !workspaceRoot || p.deletedAt || p.archivedAt) return [];
    return [{ id, title: str(p.title) ?? id, workspaceRoot }];
  });
  const threads = (Array.isArray(obj.threads) ? obj.threads : []).flatMap(rawThread => {
    if (record(rawThread).deletedAt) return [];
    const parsed = parseV2Thread(rawThread);
    return parsed ? [parsed] : [];
  });
  return { resumable: false, snapshotSequence, projects, threads };
}

function buildContextSnapshot(
  raw: Record<string, unknown>,
  source: 'providerTurn' | 'providerThread',
): ContextUsageSnapshot | undefined {
  const usedTokens = num(raw.usedTokens);
  if (usedTokens === undefined) return undefined;
  const maxTokens = num(raw.maxTokens);
  const percent = maxTokens && maxTokens > 0
    ? Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100))
    : undefined;
  return {
    status: 'available',
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(num(raw.inputTokens) !== undefined ? { inputTokens: num(raw.inputTokens) } : {}),
    ...(num(raw.cachedInputTokens) !== undefined ? { cachedInputTokens: num(raw.cachedInputTokens) } : {}),
    ...(num(raw.outputTokens) !== undefined ? { outputTokens: num(raw.outputTokens) } : {}),
    ...(num(raw.reasoningOutputTokens) !== undefined ? { reasoningOutputTokens: num(raw.reasoningOutputTokens) } : {}),
    ...(percent !== undefined ? { percent } : {}),
    source,
    ...(str(raw.updatedAt) ? { updatedAt: str(raw.updatedAt) } : {}),
  };
}

function findLatestTurnUsage(turns: unknown[], filterPtId?: string): ContextUsageSnapshot | undefined {
  let latestTurnUsage: ContextUsageSnapshot | undefined;
  let latestUpdatedMs = -1;
  for (const rawTurn of turns) {
    const turn = record(rawTurn);
    if (filterPtId && str(turn.providerThreadId) && str(turn.providerThreadId) !== filterPtId) continue;
    if (!turn.tokenUsage) continue;
    const snap = buildContextSnapshot(record(turn.tokenUsage), 'providerTurn');
    if (!snap) continue;
    const ts = snap.updatedAt ? Date.parse(snap.updatedAt) : 0;
    const orderKey = Number.isNaN(ts) ? 0 : ts;
    if (orderKey >= latestUpdatedMs) {
      latestUpdatedMs = orderKey;
      latestTurnUsage = snap;
    }
  }
  return latestTurnUsage;
}

/**
 * Extracts context window usage strictly matching `packages/client-runtime/src/state/contextWindow.ts`:
 * 1) active provider thread's latest `providerTurns[].tokenUsage` (falling back to any turn with tokenUsage),
 * 2) `providerThreads[].contextUsage`,
 * 3) latest compaction turnItem's `afterTokenCount`.
 */
export function extractContextUsage(projectionRaw: unknown): ContextUsageSnapshot {
  const proj = record(projectionRaw);
  const thread = record(proj.thread);
  const activePtId = str(thread.activeProviderThreadId);
  const turns = Array.isArray(proj.providerTurns) ? proj.providerTurns : [];

  const latestTurnUsage = findLatestTurnUsage(turns, activePtId)
    ?? (activePtId ? findLatestTurnUsage(turns) : undefined);
  if (latestTurnUsage) return latestTurnUsage;

  const transfers = Array.isArray(proj.contextTransfers) ? proj.contextTransfers : [];
  for (let i = transfers.length - 1; i >= 0; i--) {
    const tr = record(transfers[i]);
    if (tr.sourceTokenUsage) {
      const snap = buildContextSnapshot(record(tr.sourceTokenUsage), 'providerTurn');
      if (snap) return snap;
    }
  }

  const pThreads = Array.isArray(proj.providerThreads) ? proj.providerThreads : [];
  for (let i = pThreads.length - 1; i >= 0; i--) {
    const pt = record(pThreads[i]);
    if (activePtId && str(pt.id) && str(pt.id) !== activePtId) continue;
    if (pt.contextUsage) {
      const snap = buildContextSnapshot(record(pt.contextUsage), 'providerThread');
      if (snap) return snap;
    }
  }

  const items = Array.isArray(proj.turnItems) ? proj.turnItems : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = record(items[i]);
    if (item.type !== 'compaction') continue;
    const afterTokens = num(item.afterTokenCount);
    if (afterTokens !== undefined) {
      return { status: 'available', usedTokens: afterTokens, source: 'compaction' };
    }
  }

  return { status: 'unknown' };
}

function parseV2Message(raw: unknown): Message | undefined {
  const m = record(raw);
  const id = str(m.id);
  if (!id || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') return undefined;
  return {
    id,
    role: m.role,
    text: m.text,
    streaming: m.streaming === true,
  };
}

function parseTurnItem(raw: unknown): TurnItemSummary | undefined {
  const item = record(raw);
  const id = str(item.id);
  const type = str(item.type);
  if (!id || !type) return undefined;
  return {
    id,
    type,
    ...(str(item.runId) ? { runId: str(item.runId) } : {}),
    ...(str(item.title) ?? str(item.toolName) ? { title: str(item.title) ?? str(item.toolName) } : {}),
    ...(str(item.status) ? { status: str(item.status) } : {}),
    ...(str(item.command) ? { detail: str(item.command) } : {}),
  };
}

function parseRuntimeRequest(raw: unknown, threadId: string): RuntimeRequestItem | undefined {
  const req = record(raw);
  const id = str(req.id);
  const kind = str(req.kind) ?? 'command';
  const status = str(req.status);
  if (!id || !status) return undefined;
  const cap = record(req.responseCapability);
  const detail = record(req.detail);
  const detailText = str(detail.description) ?? str(detail.prompt);
  const supportsFeedback = cap.type === 'live' && cap.supportsFeedback === true;
  return {
    id,
    threadId,
    kind,
    status,
    ...(str(req.title) ?? str(detail.title) ? { title: str(req.title) ?? str(detail.title) } : {}),
    ...(str(detail.command) ? { command: str(detail.command) } : {}),
    ...(detailText ? { detail: detailText } : {}),
    supportsFeedback,
    ...(str(req.decision) ? { decision: str(req.decision) } : {}),
    ...(str(req.createdAt) ? { createdAt: str(req.createdAt) } : {}),
  };
}

/** Parses `/api/orchestration/threads/:id/bounded` or WS `subscribeThread` snapshot payload. */
export function parseThreadSnapshot(raw: unknown, fallbackThreadId?: string): {
  detail: ThreadDetail;
  rawProjection: Record<string, unknown>;
} {
  const outer = record(raw);
  const rawProjection = outer.projection ? record(outer.projection) : outer;
  const thread = parseV2Thread(rawProjection.thread) ?? {
    threadId: fallbackThreadId ?? 'unknown',
    title: '未命名会话',
    status: 'idle',
  };
  const messages = (Array.isArray(rawProjection.messages) ? rawProjection.messages : []).flatMap(m => {
    const parsed = parseV2Message(m);
    return parsed ? [parsed] : [];
  });
  const turnItems = (Array.isArray(rawProjection.turnItems) ? rawProjection.turnItems : []).flatMap(item => {
    const parsed = parseTurnItem(item);
    return parsed ? [parsed] : [];
  });
  const runtimeRequests = (Array.isArray(rawProjection.runtimeRequests) ? rawProjection.runtimeRequests : []).flatMap(req => {
    const parsed = parseRuntimeRequest(req, thread.threadId);
    return parsed ? [parsed] : [];
  });
  const runs = Array.isArray(rawProjection.runs) ? rawProjection.runs : [];
  const runIds = runs.flatMap(r => {
    const id = str(record(r).id);
    return id ? [id] : [];
  });
  const pendingCount = runtimeRequests.filter(r => r.status === 'pending').length;
  const hydratedThread: CliThread = pendingCount > 0 ? { ...thread, pendingRequestCount: pendingCount } : thread;
  const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
  const fallbackActiveRun = runs.find(r => {
    const rr = record(r);
    return typeof rr.id === 'string' && typeof rr.status === 'string' && activeStatuses.has(rr.status);
  });
  const activeRunId = str(record(rawProjection.thread).activeRunId) ?? str(record(fallbackActiveRun).id);
  const latestRunId = str(record(rawProjection.thread).latestRunId) ?? runIds[runIds.length - 1];

  return {
    rawProjection,
    detail: {
      thread: hydratedThread,
      messages,
      turnItems,
      runtimeRequests,
      contextUsage: extractContextUsage(rawProjection),
      ...(activeRunId ? { activeRunId } : {}),
      ...(latestRunId ? { latestRunId } : {}),
      runIds,
      lastSequence: num(outer.snapshotSequence) ?? 0,
      synchronized: false,
    },
  };
}

function isQueuedProviderThreadPlaceholder(raw: Record<string, unknown>): boolean {
  return (
    raw.status === 'not_loaded'
    && raw.firstRunOrdinal === null
    && raw.nativeThreadRef === null
    && raw.providerSessionId === null
  );
}

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const idx = list.findIndex(existing => existing.id === item.id);
  if (idx < 0) return [...list, item];
  const copy = [...list];
  copy[idx] = item;
  return copy;
}

export interface ThreadStreamAccumulator {
  detail?: ThreadDetail;
  rawProjection: Record<string, unknown>;
  seenEventIds: Set<string>;
}

/**
 * Reduces a single `orchestration.subscribeThread` chunk item (`snapshot`, `event`, `unknown-event`, `synchronized`)
 * with sequence deduplication, gap detection, and forward-compatible cursor advancement.
 */
export function reduceThreadStreamItem(
  acc: ThreadStreamAccumulator,
  rawItem: unknown,
  fallbackThreadId: string,
): { acc: ThreadStreamAccumulator; detail?: ThreadDetail; resyncRequired: boolean } {
  const item = record(rawItem);
  const kind = str(item.kind);

  if (kind === 'snapshot') {
    const parsed = parseThreadSnapshot(item, fallbackThreadId);
    acc.rawProjection = parsed.rawProjection;
    acc.detail = { ...parsed.detail, synchronized: false };
    acc.seenEventIds.clear();
    return { acc, detail: acc.detail, resyncRequired: false };
  }

  if (!acc.detail) {
    return { acc, resyncRequired: false };
  }

  if (kind === 'synchronized') {
    acc.detail = { ...acc.detail, synchronized: true };
    return { acc, detail: acc.detail, resyncRequired: false };
  }

  if (kind === 'snapshot-required') {
    return { acc, resyncRequired: true };
  }

  const seq = num(item.sequence);
  if (seq !== undefined && seq <= acc.detail.lastSequence) {
    return { acc, resyncRequired: false };
  }

  if (kind === 'unknown-event') {
    if (seq !== undefined) acc.detail = { ...acc.detail, lastSequence: seq };
    return { acc, detail: acc.detail, resyncRequired: false };
  }

  if (kind !== 'event') {
    return { acc, resyncRequired: false };
  }

  const ev = record(item.event);
  const eventId = str(ev.id);
  if (eventId) {
    if (acc.seenEventIds.has(eventId)) return { acc, resyncRequired: false };
    acc.seenEventIds.add(eventId);
  }

  const evType = str(ev.type) ?? '';
  const payload = record(ev.payload);
  let nextDetail: ThreadDetail = {
    ...acc.detail,
    ...(seq !== undefined ? { lastSequence: seq } : {}),
  };

  if (evType === 'message.updated' || evType === 'message.created') {
    const msg = parseV2Message(payload);
    if (msg) nextDetail = { ...nextDetail, messages: upsertById(nextDetail.messages, msg) };
  } else if (evType === 'turn-item.updated') {
    const ti = parseTurnItem(payload);
    if (ti) nextDetail = { ...nextDetail, turnItems: upsertById(nextDetail.turnItems, ti) };
  } else if (evType === 'runtime-request.updated') {
    const rr = parseRuntimeRequest(payload, nextDetail.thread.threadId);
    if (rr) {
      const runtimeRequests = upsertById(nextDetail.runtimeRequests, rr);
      const pendingCount = runtimeRequests.filter(r => r.status === 'pending').length;
      nextDetail = {
        ...nextDetail,
        runtimeRequests,
        thread: { ...nextDetail.thread, pendingRequestCount: pendingCount },
      };
    }
  } else if (evType === 'run.created' || evType === 'run.updated') {
    const runId = str(payload.id);
    const runStatus = str(payload.status);
    const runIds = runId && !nextDetail.runIds.includes(runId) ? [...nextDetail.runIds, runId] : nextDetail.runIds;
    const nextThread = runStatus ? { ...nextDetail.thread, status: runStatus } : nextDetail.thread;
    const isActiveRun = Boolean(runStatus && ['running', 'starting', 'queued', 'waiting', 'preparing'].includes(runStatus));
    const clearedActiveRun = Boolean(
      runStatus
      && !isActiveRun
      && (!nextDetail.activeRunId || nextDetail.activeRunId === runId),
    );
    nextDetail = {
      ...nextDetail,
      thread: nextThread,
      runIds,
      ...(runId ? { latestRunId: runId } : {}),
      ...(isActiveRun
        ? { activeRunId: runId ?? nextDetail.activeRunId }
        : clearedActiveRun ? { activeRunId: undefined } : {}),
    };
  } else if (evType === 'provider-turn.updated') {
    const id = str(payload.id);
    const existingTurns = (Array.isArray(acc.rawProjection.providerTurns) ? acc.rawProjection.providerTurns : [])
      .map(t => record(t));
    const prevTurn = id ? existingTurns.find(t => str(t.id) === id) : undefined;
    const mergedPayload = payload.tokenUsage === undefined && prevTurn?.tokenUsage !== undefined
      ? { ...payload, tokenUsage: prevTurn.tokenUsage }
      : payload;
    const nextTurns = id
      ? upsertById(existingTurns as Array<{ id: string }>, mergedPayload as { id: string })
      : [...existingTurns, mergedPayload];
    acc.rawProjection = { ...acc.rawProjection, providerTurns: nextTurns };
    nextDetail = { ...nextDetail, contextUsage: extractContextUsage(acc.rawProjection) };
  } else if (evType === 'provider-thread.updated') {
    const id = str(payload.id);
    const existing = Array.isArray(acc.rawProjection.providerThreads) ? acc.rawProjection.providerThreads : [];
    const nextPts = id ? upsertById(existing.map(t => record(t)) as Array<{ id: string }>, payload as { id: string }) : [...existing, payload];
    const nextThread = id && str(payload.appThreadId) === nextDetail.thread.threadId && !isQueuedProviderThreadPlaceholder(payload)
      ? { ...record(acc.rawProjection.thread), activeProviderThreadId: id }
      : acc.rawProjection.thread;
    acc.rawProjection = {
      ...acc.rawProjection,
      ...(nextThread ? { thread: nextThread } : {}),
      providerThreads: nextPts,
    };
    nextDetail = { ...nextDetail, contextUsage: extractContextUsage(acc.rawProjection) };
  } else if (evType.startsWith('thread.')) {
    const prevRawThread = record(acc.rawProjection.thread);
    const mergedRawThread = { ...prevRawThread, ...payload };
    const updated = parseV2Thread(mergedRawThread);
    if (updated) {
      acc.rawProjection = { ...acc.rawProjection, thread: mergedRawThread };
      nextDetail = {
        ...nextDetail,
        thread: {
          ...nextDetail.thread,
          ...updated,
          pendingRequestCount: nextDetail.runtimeRequests.filter(r => r.status === 'pending').length,
        },
      };
    }
  }

  acc.detail = nextDetail;
  return { acc, detail: nextDetail, resyncRequired: false };
}
