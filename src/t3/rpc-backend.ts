import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Settings } from '../settings';
import { redactSensitiveText, T3AuthManager } from './auth';
import type {
  ApprovalResponseInput,
  BackendCapabilities,
  BackendEvent,
  BackendModelSelection,
  ProviderDescriptor,
  SendMessageInput,
  T3Backend,
  ThreadDetail,
} from './backend';
import type { CliThread } from './cli';
import { discoverCliPath, discoverLocalServer, resolveT3Home, type DiscoveredServer } from './discovery';
import {
  parseServerProviders,
  parseShellSnapshot,
  parseThreadSnapshot,
  parseV2Thread,
  reduceThreadStreamItem,
  type ThreadStreamAccumulator,
} from './protocol-v2';
import { record, T3Rpc } from './rpc';
import type { T3Store } from './store';

const MAX_RECONNECT_ATTEMPTS = 5;
const WS_CONNECT_TIMEOUT_MS = 10_000;

export class UncertainWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UncertainWriteError';
  }
}

export interface RpcSocketLike extends EventTarget {
  send(data: string): void;
  close(): void;
}

export interface RpcBackendOptions {
  getSettings: () => Pick<Settings, 'cliPath' | 'provider' | 'model' | 'modelPresets'> & { serverUrl?: string };
  auth?: T3AuthManager;
  store?: T3Store;
  discoverFn?: typeof discoverLocalServer;
  discoverCliFn?: typeof discoverCliPath;
  resolveT3HomeFn?: typeof resolveT3Home;
  realpathFn?: (path: string) => Promise<string>;
  fetcher?: typeof fetch;
  createWebSocket?: (url: string) => RpcSocketLike;
  createRpc?: (socket: RpcSocketLike) => T3Rpc;
  randomId?: () => string;
  randomFn?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  onReconnectExhausted?: (reason: string) => void;
}

interface ThreadSubscriptionState {
  threadId: string;
  acc: ThreadStreamAccumulator;
  listeners: Set<(event: BackendEvent) => void>;
  streamHandle?: { unsubscribe: () => void };
  resyncing: boolean;
}

function toBackendCapabilities(caps: Record<string, unknown>): BackendCapabilities {
  return {
    mode: 'rpc',
    supportsLiveCatalog: true,
    supportsProviderRefresh: caps.modelCatalogRefresh === true,
    supportsStreaming: true,
    supportsStop: caps.threadStop === true || caps.threadForceStop === true,
    supportsMidThreadModelSwitch: true,
    supportsRuntimeModeSwitch: true,
    supportsInteractionModeSwitch: true,
    supportsApprovals: true,
    supportsContextUsage: true,
    supportsQuotaUsage: true,
  };
}

function toWireModelSelection(sel: BackendModelSelection): Record<string, unknown> {
  return {
    instanceId: sel.instanceId,
    model: sel.model,
    ...(sel.options && sel.options.length > 0 ? { options: sel.options } : {}),
  };
}

function canonicalPath(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isTransportFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('连接') || msg.includes('发送') || msg.includes('超时') || msg.includes('中断');
}

/**
 * Primary RPC First backend talking directly to the local T3 Code server over
 * WebSocket Effect RPC + HTTP v2 with bounded incremental reconnect recovery.
 */
export class RpcBackend implements T3Backend {
  readonly mode = 'rpc' as const;

  private readonly auth: T3AuthManager;
  private readonly fetcher: typeof fetch;
  private readonly randomId: () => string;
  private readonly randomFn: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  private server?: DiscoveredServer;
  private capabilities: BackendCapabilities = toBackendCapabilities({});
  private serverCapabilities: Record<string, unknown> = {};
  private rpc?: T3Rpc;
  private shellSub?: { unsubscribe: () => void };
  private configSub?: { unsubscribe: () => void };

  private workspacePath = '';
  private requestedProjectId = '';
  private resolvedProjectId = '';
  private resolvedProjectWorkspaceRoot?: string;
  private shellSequence = 0;
  private shellLoaded = false;
  private shellProjects: Array<{ id: string; title: string; workspaceRoot: string }> = [];
  private shellThreads: CliThread[] = [];
  private providers: ProviderDescriptor[] = [];

  private readonly threadSubs = new Map<string, ThreadSubscriptionState>();
  private readonly pendingCreateThreads = new Map<string, string>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private intentionalClose = true;

  constructor(private readonly options: RpcBackendOptions) {
    this.auth = options.auth ?? new T3AuthManager({ fetcher: options.fetcher });
    this.fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.randomId = options.randomId ?? (() => randomUUID());
    this.randomFn = options.randomFn ?? Math.random;
    this.setTimer = options.setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = options.clearTimeoutFn ?? (id => globalThis.clearTimeout(id));
  }

  private getCliContext(): { cliPath?: string; t3Home?: string } {
    const configured = this.options.getSettings().cliPath;
    const discoverCli = this.options.discoverCliFn ?? discoverCliPath;
    const resolveHome = this.options.resolveT3HomeFn ?? resolveT3Home;
    const cliPath = discoverCli(configured);
    const t3Home = resolveHome(cliPath);
    return { cliPath, t3Home };
  }

  private async normalizeFsPath(p: string): Promise<string> {
    const trimmed = p.trim();
    if (!trimmed) return '';
    const rf = this.options.realpathFn ?? realpath;
    try {
      return canonicalPath(await rf(trimmed));
    } catch {
      return canonicalPath(resolve(trimmed));
    }
  }

  private async ensureSession(): Promise<{ origin: string; environmentId: string; token: string }> {
    if (!this.server) throw new Error('尚未连接到本地 T3 Code 服务。');
    const { cliPath, t3Home } = this.getCliContext();
    const session = await this.auth.ensureSession({
      origin: this.server.origin,
      environmentId: this.server.environmentId,
      cliPath,
      t3Home,
    });
    return { origin: session.origin, environmentId: session.environmentId, token: session.token };
  }

  private async httpRequest(
    path: string,
    init: RequestInit & { isOrchestration?: boolean } = {},
  ): Promise<Response> {
    if (!this.server) throw new Error('尚未连接到本地 T3 Code 服务。');
    const { cliPath, t3Home } = this.getCliContext();
    const doFetch = async (token: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (init.isOrchestration) {
        headers.set('x-t3-orchestration-protocol', '2');
      }
      return this.fetcher(new URL(path, this.server!.origin), {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
    };

    const session = await this.ensureSession();
    let res = await doFetch(session.token);
    if (res.status === 401) {
      const renewed = await this.auth.renewOnUnauthorized({
        origin: this.server.origin,
        environmentId: this.server.environmentId,
        cliPath,
        t3Home,
      });
      res = await doFetch(renewed.token);
    }
    return res;
  }

  private async httpJson(path: string, init: RequestInit & { isOrchestration?: boolean } = {}): Promise<unknown> {
    const res = await this.httpRequest(path, init);
    if (!res.ok) {
      throw new Error(redactSensitiveText(`T3 HTTP v2 请求失败（HTTP ${res.status}）。`));
    }
    return res.json();
  }

  private async mintWsTicket(): Promise<string> {
    let res = await this.httpRequest('/api/auth/websocket-ticket/rpc', { method: 'POST' });
    if (res.status === 404) {
      res = await this.httpRequest('/api/auth/websocket-ticket', { method: 'POST' });
    }
    if (!res.ok) {
      throw new Error(redactSensitiveText(`无法获取 T3 WebSocket Ticket（HTTP ${res.status}）。`));
    }
    const body = record(await res.json());
    if (typeof body.ticket !== 'string' || !body.ticket) {
      throw new Error('T3 Code 返回了无效的 WebSocket Ticket。');
    }
    return body.ticket;
  }

  private async openRpcSocket(ticket: string): Promise<T3Rpc> {
    if (!this.server) throw new Error('尚未发现本地 T3 Code 服务。');
    const wsUrl = new URL('/ws', this.server.origin);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('orchestrationProtocol', '2');
    wsUrl.searchParams.set('wsTicket', ticket);

    const socketFactory = this.options.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as RpcSocketLike);
    const socket = socketFactory(wsUrl.toString());

    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        rejectReady(new Error('连接本地 T3 WebSocket 超时。'));
      }, WS_CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        this.clearTimer(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onErr);
        socket.removeEventListener('close', onClose);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveReady();
      };
      const onErr = () => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        rejectReady(new Error('无法建立 T3 WebSocket RPC 连接。'));
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectReady(new Error('T3 WebSocket 在握手完成前关闭。'));
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onErr);
      socket.addEventListener('close', onClose);
    });

    return (this.options.createRpc ?? (s => new T3Rpc(s)))(socket);
  }

  private async resolveEffectiveProjectId(): Promise<void> {
    if (this.requestedProjectId) {
      this.resolvedProjectId = this.requestedProjectId;
      this.resolvedProjectWorkspaceRoot = this.shellProjects.find(p => p.id === this.requestedProjectId)?.workspaceRoot;
      return;
    }
    const target = await this.normalizeFsPath(this.workspacePath);
    if (!target) {
      this.resolvedProjectId = '';
      this.resolvedProjectWorkspaceRoot = undefined;
      return;
    }
    for (const proj of this.shellProjects) {
      const root = await this.normalizeFsPath(proj.workspaceRoot);
      if (root === target) {
        this.resolvedProjectId = proj.id;
        this.resolvedProjectWorkspaceRoot = proj.workspaceRoot;
        return;
      }
    }
    this.resolvedProjectId = '';
    this.resolvedProjectWorkspaceRoot = undefined;
  }

  getResolvedProjectWorkspaceRoot(): string | undefined {
    return this.resolvedProjectWorkspaceRoot;
  }

  private filteredThreads(projectIdOverride?: string): CliThread[] {
    const pid = (projectIdOverride ?? this.resolvedProjectId).trim();
    if (!pid) return [];
    return this.shellThreads.filter(t => t.projectId === pid);
  }

  private syncThreadsToStore(): void {
    this.options.store?.setThreads(this.filteredThreads());
  }

  private async fetchShellSnapshot(resumeFrom?: number): Promise<void> {
    const qs = new URLSearchParams({ omitIdleSubagents: '1', omitOlderSettled: '1' });
    if (resumeFrom !== undefined && resumeFrom > 0) {
      qs.set('resumeFrom', String(resumeFrom));
    }
    const raw = await this.httpJson(`/api/orchestration/shell?${qs.toString()}`, { isOrchestration: true });
    const parsed = parseShellSnapshot(raw);
    this.shellLoaded = true;
    if (parsed.resumable) return;
    this.shellSequence = parsed.snapshotSequence;
    this.shellProjects = parsed.projects;
    this.shellThreads = parsed.threads;
    await this.resolveEffectiveProjectId();
    this.syncThreadsToStore();
  }

  private handleShellStreamItem(rawItem: unknown): void {
    const item = record(rawItem);
    const kind = item.kind;
    if (kind === 'snapshot') {
      const parsed = parseShellSnapshot(item.snapshot);
      this.shellLoaded = true;
      this.shellSequence = parsed.snapshotSequence;
      this.shellProjects = parsed.projects;
      this.shellThreads = parsed.threads;
      void this.resolveEffectiveProjectId().then(() => this.syncThreadsToStore());
      return;
    }
    if (kind === 'snapshot-required') {
      void this.fetchShellSnapshot().catch(() => undefined);
      return;
    }
    const seq = typeof item.sequence === 'number' ? item.sequence : undefined;
    if (seq !== undefined && seq > this.shellSequence) {
      this.shellSequence = seq;
    }
    if (kind === 'thread.updated') {
      const parsed = parseV2Thread(item.thread);
      if (!parsed) return;
      const archived = item.location === 'archive' || parsed.archived === true;
      const updated: CliThread = archived ? { ...parsed, archived: true } : parsed;
      const idx = this.shellThreads.findIndex(t => t.threadId === updated.threadId);
      if (idx < 0) {
        this.shellThreads = [...this.shellThreads, updated];
      } else {
        const copy = [...this.shellThreads];
        copy[idx] = updated;
        this.shellThreads = copy;
      }
      this.syncThreadsToStore();
    } else if (kind === 'thread.removed' && typeof item.threadId === 'string') {
      this.shellThreads = this.shellThreads.filter(t => t.threadId !== item.threadId);
      this.syncThreadsToStore();
    } else if (kind === 'project.updated') {
      const p = record(item.project);
      if (typeof p.id === 'string' && typeof p.workspaceRoot === 'string') {
        const nextProj = { id: p.id, title: typeof p.title === 'string' ? p.title : p.id, workspaceRoot: p.workspaceRoot };
        const idx = this.shellProjects.findIndex(existing => existing.id === nextProj.id);
        this.shellProjects = idx < 0
          ? [...this.shellProjects, nextProj]
          : this.shellProjects.map(existing => existing.id === nextProj.id ? nextProj : existing);
        void this.resolveEffectiveProjectId().then(() => this.syncThreadsToStore());
      }
    }
  }

  private handleServerConfigStreamItem(rawItem: unknown): void {
    const ev = record(rawItem);
    const config = record(ev.config);
    const providersRaw = config.providers ?? ev.providers;
    if (Array.isArray(providersRaw)) {
      this.providers = parseServerProviders(providersRaw);
      this.options.store?.setProviders(this.providers);
      return;
    }
    if (ev.type === 'providerStatusDeltas' || ev.type === 'usageLimitSourcesUpdated') {
      void this.getProviders(false).catch(() => undefined);
    }
  }

  private async attachSubscriptions(isReconnect: boolean): Promise<void> {
    if (!this.rpc) return;
    const shellPayload: Record<string, unknown> = {
      httpSnapshotFallback: true,
      requestCompletionMarker: true,
      ...(isReconnect && this.shellSequence > 0 ? { afterSequence: this.shellSequence } : {}),
    };
    const shellHandle = this.rpc.subscribe('orchestration.subscribeShell', shellPayload, chunk => {
      this.handleShellStreamItem(chunk);
    });
    void shellHandle.result.catch(() => undefined);
    this.shellSub = { unsubscribe: shellHandle.unsubscribe };

    const cfgHandle = this.rpc.subscribe('subscribeServerConfig', { usageLimitSources: true }, chunk => {
      this.handleServerConfigStreamItem(chunk);
    });
    void cfgHandle.result.catch(() => undefined);
    this.configSub = { unsubscribe: cfgHandle.unsubscribe };

    for (const sub of this.threadSubs.values()) {
      this.startThreadStream(sub);
    }
  }

  private startThreadStream(sub: ThreadSubscriptionState): void {
    if (!this.rpc) return;
    sub.streamHandle?.unsubscribe();
    const afterSeq = sub.acc.detail?.lastSequence;
    const payload: Record<string, unknown> = {
      threadId: sub.threadId,
      acceptBoundedSnapshot: true,
      acceptCompactTurnItems: true,
      acceptDeferredWork: true,
      requestCompletionMarker: true,
      ...(afterSeq !== undefined && afterSeq > 0 ? { afterSequence: afterSeq } : {}),
    };
    const handle = this.rpc.subscribe('orchestration.subscribeThread', payload, chunk => {
      this.handleThreadChunk(sub, chunk);
    });
    void handle.result.catch(() => undefined);
    sub.streamHandle = { unsubscribe: handle.unsubscribe };
  }

  private emitThreadDetail(sub: ThreadSubscriptionState, detail: ThreadDetail): void {
    this.options.store?.setThreadDetail(sub.threadId, detail);
    const idx = this.shellThreads.findIndex(t => t.threadId === detail.thread.threadId);
    if (idx >= 0) {
      const copy = [...this.shellThreads];
      copy[idx] = { ...copy[idx], ...detail.thread };
      this.shellThreads = copy;
      this.syncThreadsToStore();
    }
    for (const listener of [...sub.listeners]) {
      listener({ type: 'thread.detail', detail });
    }
  }

  private async resyncThreadOverHttp(sub: ThreadSubscriptionState): Promise<void> {
    if (sub.resyncing) return;
    sub.resyncing = true;
    try {
      for (const listener of [...sub.listeners]) {
        listener({ type: 'thread.resync-required', threadId: sub.threadId });
      }
      const raw = await this.httpJson(
        `/api/orchestration/threads/${encodeURIComponent(sub.threadId)}/bounded?compactTurnItems=1&deferWork=1`,
        { isOrchestration: true },
      );
      const parsed = parseThreadSnapshot(raw, sub.threadId);
      sub.acc.rawProjection = parsed.rawProjection;
      sub.acc.seenEventIds.clear();
      sub.acc.detail = { ...parsed.detail, synchronized: true };
      this.emitThreadDetail(sub, sub.acc.detail);
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : '重新同步会话失败。');
      for (const listener of [...sub.listeners]) {
        listener({ type: 'error', message });
      }
    } finally {
      sub.resyncing = false;
    }
  }

  private handleThreadChunk(sub: ThreadSubscriptionState, rawChunk: unknown): void {
    const res = reduceThreadStreamItem(sub.acc, rawChunk, sub.threadId);
    if (res.resyncRequired) {
      void this.resyncThreadOverHttp(sub);
      return;
    }
    if (res.detail) {
      this.emitThreadDetail(sub, res.detail);
    }
  }

  private cleanupSocketAndSubs(): void {
    this.shellSub?.unsubscribe();
    this.shellSub = undefined;
    this.configSub?.unsubscribe();
    this.configSub = undefined;
    for (const sub of this.threadSubs.values()) {
      sub.streamHandle?.unsubscribe();
      sub.streamHandle = undefined;
    }
    this.rpc?.close();
    this.rpc = undefined;
  }

  private scheduleReconnect(attempt = 0): void {
    if (this.intentionalClose || !this.server) return;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      this.options.onReconnectExhausted?.('与本地 T3 Code 服务断线且重连次数已达上限。');
      return;
    }
    const baseMs = Math.min(1000 * (2 ** attempt), 30_000);
    const jitterMs = Math.round(baseMs * (0.5 + 0.5 * this.randomFn()));
    this.reconnectTimer = this.setTimer(() => {
      void this.attemptReconnect(attempt);
    }, jitterMs);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.intentionalClose || !this.server) return;
    try {
      await this.establishTransport(true);
    } catch {
      this.scheduleReconnect(attempt + 1);
    }
  }

  private async establishTransport(isReconnect: boolean): Promise<void> {
    this.cleanupSocketAndSubs();
    const ticket = await this.mintWsTicket();
    const rpc = await this.openRpcSocket(ticket);
    this.rpc = rpc;

    void rpc.disconnected.then(() => {
      if (this.rpc !== rpc || this.intentionalClose) return;
      this.cleanupSocketAndSubs();
      this.scheduleReconnect(0);
    });

    await Promise.all([
      this.fetchShellSnapshot(isReconnect && this.shellSequence > 0 ? this.shellSequence : undefined),
      this.getProviders(false),
    ]);
    await this.attachSubscriptions(isReconnect);
  }

  async connect(projectWorkspacePath: string, projectId: string): Promise<BackendCapabilities> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.cleanupSocketAndSubs();
    this.shellLoaded = false;
    this.shellSequence = 0;

    this.workspacePath = projectWorkspacePath.trim();
    this.requestedProjectId = projectId.trim();

    const discover = this.options.discoverFn ?? discoverLocalServer;
    const { cliPath } = this.getCliContext();
    this.server = await discover({
      serverUrl: this.options.getSettings().serverUrl?.trim() || undefined,
      cliPath,
    });
    this.serverCapabilities = this.server.capabilities;
    this.capabilities = toBackendCapabilities(this.serverCapabilities);

    await this.ensureSession();
    this.intentionalClose = false;
    await this.establishTransport(false);
    return this.capabilities;
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.cleanupSocketAndSubs();
    this.threadSubs.clear();
    this.pendingCreateThreads.clear();
    const { cliPath, t3Home } = this.getCliContext();
    await this.auth.revokeAndClear(cliPath, t3Home);
  }

  async getProviders(refresh = false): Promise<ProviderDescriptor[]> {
    if (!this.rpc) throw new Error('T3 RPC 尚未建立连接。');
    if (refresh && this.capabilities.supportsProviderRefresh) {
      await this.rpc.request('server.refreshProviders', {
        ...(this.workspacePath ? { cwd: this.workspacePath } : {}),
        fresh: true,
        refreshModels: true,
      }).result;
    }
    const raw = record(await this.rpc.request('server.getConfig', {}).result);
    this.providers = parseServerProviders(raw.providers);
    this.options.store?.setProviders(this.providers);
    return this.providers;
  }

  async listThreads(projectId: string): Promise<CliThread[]> {
    if (!this.shellLoaded) {
      await this.fetchShellSnapshot();
    }
    return this.filteredThreads(projectId || this.resolvedProjectId);
  }

  async openThread(threadId: string, onEvent: (event: BackendEvent) => void): Promise<{ unsubscribe: () => void }> {
    let sub = this.threadSubs.get(threadId);
    if (!sub) {
      sub = {
        threadId,
        acc: { rawProjection: {}, seenEventIds: new Set() },
        listeners: new Set([onEvent]),
        resyncing: false,
      };
      this.threadSubs.set(threadId, sub);
      this.startThreadStream(sub);
    } else {
      sub.listeners.add(onEvent);
      if (sub.acc.detail) {
        onEvent({ type: 'thread.detail', detail: sub.acc.detail });
      }
    }

    return {
      unsubscribe: () => {
        const entry = this.threadSubs.get(threadId);
        if (!entry) return;
        entry.listeners.delete(onEvent);
        if (entry.listeners.size === 0) {
          entry.streamHandle?.unsubscribe();
          this.threadSubs.delete(threadId);
        }
      },
    };
  }

  getPendingThreadIdForCommand(commandId: string): string | undefined {
    return this.pendingCreateThreads.get(commandId);
  }

  async inspectPendingWrite(
    threadId: string,
    messageId: string,
  ): Promise<'committed' | 'thread-only' | 'missing' | 'unknown'> {
    try {
      const res = await this.httpRequest(
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded?compactTurnItems=1&deferWork=1`,
        { isOrchestration: true },
      );
      if (res.status === 404) return 'missing';
      if (!res.ok) return 'unknown';
      const parsed = parseThreadSnapshot(await res.json(), threadId);
      return parsed.detail.messages.some(m => m.id === messageId) ? 'committed' : 'thread-only';
    } catch {
      return 'unknown';
    }
  }

  async hasMessageOnServer(threadId: string, messageId: string): Promise<boolean> {
    return (await this.inspectPendingWrite(threadId, messageId)) === 'committed';
  }

  private async dispatchCommand(command: Record<string, unknown>, markUncertainOnTransportError = false): Promise<{ sequence?: number }> {
    if (!this.rpc) {
      const msg = 'T3 WebSocket 连接已断开，无法执行写操作。';
      throw markUncertainOnTransportError ? new UncertainWriteError(msg) : new Error(msg);
    }
    try {
      const res = record(await this.rpc.request('orchestration.dispatchCommand', command).result);
      return typeof res.sequence === 'number' ? { sequence: res.sequence } : {};
    } catch (error) {
      const cleanMsg = redactSensitiveText(error instanceof Error ? error.message : 'T3 指令执行失败。');
      if (error instanceof Error) error.message = cleanMsg;
      if (markUncertainOnTransportError && isTransportFailure(error)) {
        throw new UncertainWriteError(cleanMsg || '发送状态未知，请勿自动重发。', { cause: error });
      }
      throw new Error(cleanMsg, { cause: error });
    }
  }

  async sendMessage(input: SendMessageInput): Promise<{ threadId: string; runId?: string; sequence?: number }> {
    const projectId = input.projectId.trim() || this.resolvedProjectId;
    if (!projectId) {
      throw new Error('未匹配到已注册的 T3 项目，请在设置中填写项目 ID 或先在 T3 Code 中添加该项目目录。');
    }

    let threadId = input.threadId?.trim();
    if (!threadId) {
      threadId = this.pendingCreateThreads.get(input.commandId) ?? this.randomId();
      this.pendingCreateThreads.set(input.commandId, threadId);
      const fallbackModel = this.options.getSettings();
      const wireSel = input.modelSelection
        ? toWireModelSelection(input.modelSelection)
        : { instanceId: fallbackModel.provider, model: fallbackModel.model };
      const title = input.text.trim().replace(/\s+/g, ' ').slice(0, 60) || '新会话';
      await this.dispatchCommand({
        type: 'thread.create',
        commandId: `${input.commandId}:create`,
        threadId,
        projectId,
        title,
        modelSelection: wireSel,
        runtimeMode: input.runtimeMode ?? 'approval-required',
        interactionMode: input.interactionMode ?? 'default',
        branch: null,
        worktreePath: null,
        createdBy: 'user',
        creationSource: 'web',
      }, true);
    }

    const result = await this.dispatchCommand({
      type: 'message.dispatch',
      commandId: input.commandId,
      threadId,
      messageId: input.messageId,
      text: input.text,
      attachments: [],
      ...(input.modelSelection ? { modelSelection: toWireModelSelection(input.modelSelection) } : {}),
      dispatchMode: { type: 'start_immediately' },
      createdBy: 'user',
      creationSource: 'web',
    }, true);

    this.pendingCreateThreads.delete(input.commandId);
    return { threadId, ...(result.sequence !== undefined ? { sequence: result.sequence } : {}) };
  }

  async stopThread(threadId: string, commandId: string, activeRunId?: string): Promise<void> {
    if (this.serverCapabilities.threadStop === true) {
      await this.dispatchCommand({
        type: 'thread.stop',
        commandId,
        threadId,
        reason: 'Stopped from T3-Codian',
      });
      return;
    }
    const detailRunId = activeRunId ?? this.options.store?.getSnapshot().activeThreadDetails.get(threadId)?.activeRunId;
    if (!detailRunId) {
      throw new Error('当前没有可中断的活动运行 ID。');
    }
    await this.dispatchCommand({
      type: 'run.interrupt',
      commandId,
      threadId,
      runId: detailRunId,
      reason: 'Interrupted from T3-Codian',
      holdQueue: true,
    });
  }

  async setModelSelection(threadId: string, commandId: string, selection: BackendModelSelection): Promise<void> {
    await this.dispatchCommand({
      type: 'thread.model-selection.set',
      commandId,
      threadId,
      modelSelection: toWireModelSelection(selection),
    });
  }

  async setRuntimeMode(threadId: string, commandId: string, runtimeMode: string): Promise<void> {
    await this.dispatchCommand({
      type: 'thread.runtime-mode.set',
      commandId,
      threadId,
      runtimeMode,
    });
  }

  async setInteractionMode(threadId: string, commandId: string, mode: 'default' | 'plan'): Promise<void> {
    await this.dispatchCommand({
      type: 'thread.interaction-mode.set',
      commandId,
      threadId,
      interactionMode: mode,
    });
  }

  async respondRuntimeRequest(input: ApprovalResponseInput): Promise<void> {
    const cachedReq = this.options.store?.getSnapshot().activeThreadDetails.get(input.threadId)?.runtimeRequests
      .find(r => r.id === input.requestId);
    const trimmedFeedback = input.feedback?.trim();
    const allowFeedback = Boolean(trimmedFeedback && cachedReq?.supportsFeedback === true && input.decision === 'decline');
    await this.dispatchCommand({
      type: 'runtime-request.respond',
      commandId: input.commandId,
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(allowFeedback ? { feedback: trimmedFeedback } : {}),
      ...(input.answers ? { answers: input.answers } : {}),
    });
  }
}
