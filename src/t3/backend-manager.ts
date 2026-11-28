import { randomUUID } from 'node:crypto';
import type { Settings } from '../settings';
import { redactSensitiveText, T3AuthManager } from './auth';
import {
  CLI_BACKEND_CAPABILITIES,
  type ApprovalResponseInput,
  type BackendCapabilities,
  type BackendEvent,
  type BackendModelSelection,
  type ProviderDescriptor,
  type SendMessageInput,
  type T3Backend,
} from './backend';
import type { CliThread } from './cli';
import { CliBackend } from './cli-backend';
import { discoverLocalServer } from './discovery';
import { RpcBackend, UncertainWriteError } from './rpc-backend';
import { T3Store } from './store';
import { VaultSafetyGuard } from './vault-guard';
import { resolveWorkspacePath } from './workspace';

export type BackendManagerSettings = Pick<Settings, 'cliPath' | 'provider' | 'model' | 'modelPresets'> & {
  serverUrl?: string;
  backendPreference?: 'auto' | 'cli';
};

export interface BackendManagerOptions {
  getSettings: () => BackendManagerSettings;
  store?: T3Store;
  auth?: T3AuthManager;
  vaultGuard?: VaultSafetyGuard;
  rpcBackend?: RpcBackend;
  cliBackend?: CliBackend;
  discoverFn?: typeof discoverLocalServer;
  randomId?: () => string;
  now?: () => number;
}

/** Thrown when configured workspace path conflicts with Vault security boundaries. */
export class VaultSecurityError extends Error {}

/**
 * Coordinates RPC First + CLI Fallback lifecycle, Vault path security enforcement,
 * and idempotent pending-write tracking across reconnects.
 */
export class T3BackendManager {
  readonly store: T3Store;
  private readonly auth: T3AuthManager;
  private readonly vaultGuard: VaultSafetyGuard;
  private readonly rpcBackend: RpcBackend;
  private readonly cliBackend: CliBackend;
  private readonly discoverFn: typeof discoverLocalServer;
  private readonly randomId: () => string;
  private readonly now: () => number;

  private activeBackend: T3Backend;
  private vaultPath = '';
  private configuredProjectPath = '';
  private configuredProjectId = '';
  private workspacePath = '';
  private resolvedServerRoot?: string;

  constructor(private readonly options: BackendManagerOptions) {
    this.store = options.store ?? new T3Store();
    this.auth = options.auth ?? new T3AuthManager();
    this.vaultGuard = options.vaultGuard ?? new VaultSafetyGuard();
    this.discoverFn = options.discoverFn ?? discoverLocalServer;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.now = options.now ?? Date.now;

    this.rpcBackend = options.rpcBackend ?? new RpcBackend({
      getSettings: () => this.options.getSettings(),
      auth: this.auth,
      store: this.store,
      randomId: this.randomId,
      onReconnectExhausted: reason => {
        void this.handleRpcDropped(reason);
      },
    });
    this.cliBackend = options.cliBackend ?? new CliBackend({
      getSettings: () => this.options.getSettings(),
    });
    this.activeBackend = this.cliBackend;
  }

  get activeMode(): 'rpc' | 'cli' {
    return this.activeBackend.mode;
  }

  async isVaultOverlapping(): Promise<boolean> {
    if (await this.vaultGuard.isOverlapping(this.vaultPath, this.workspacePath)) return true;
    if (this.resolvedServerRoot && await this.vaultGuard.isOverlapping(this.vaultPath, this.resolvedServerRoot)) {
      return true;
    }
    return false;
  }

  private async getGuardContexts(): Promise<Array<{ vaultPath: string; projectWorkspacePath: string }>> {
    const contexts = [{ vaultPath: this.vaultPath, projectWorkspacePath: this.workspacePath }];
    if (this.resolvedServerRoot && this.resolvedServerRoot !== this.workspacePath) {
      contexts.push({ vaultPath: this.vaultPath, projectWorkspacePath: this.resolvedServerRoot });
    }
    return contexts;
  }

  private async handleRpcDropped(reason: string): Promise<void> {
    if (this.activeBackend !== this.rpcBackend) return;
    await this.rpcBackend.disconnect().catch(() => undefined);
    try {
      await this.cliBackend.connect(this.workspacePath, this.configuredProjectId);
      if (this.configuredProjectId && typeof this.cliBackend.verifyWorkspaceProjectBinding === 'function') {
        await this.cliBackend.verifyWorkspaceProjectBinding(this.configuredProjectId);
      }
      this.activeBackend = this.cliBackend;
      this.store.setConnection('fallback-cli', { ...CLI_BACKEND_CAPABILITIES }, redactSensitiveText(reason));
      const [providers, threads] = await Promise.all([
        this.cliBackend.getProviders(),
        this.cliBackend.listThreads(this.configuredProjectId),
      ]);
      this.store.setProviders(providers);
      this.store.setThreads(threads);
    } catch {
      this.store.setConnection('disconnected', { ...CLI_BACKEND_CAPABILITIES }, redactSensitiveText(reason));
    }
  }

  async connect(vaultPath: string, configuredProjectPath: string, configuredProjectId: string): Promise<BackendCapabilities> {
    this.vaultPath = vaultPath.trim();
    this.configuredProjectPath = configuredProjectPath.trim();
    this.configuredProjectId = configuredProjectId.trim();
    this.workspacePath = resolveWorkspacePath(this.configuredProjectPath, this.vaultPath);
    this.resolvedServerRoot = undefined;

    this.store.setConnection('connecting');
    const settings = this.options.getSettings();

    if (settings.backendPreference === 'cli') {
      return this.connectCliOnly();
    }

    try {
      const caps = await this.rpcBackend.connect(this.workspacePath, this.configuredProjectId);
      const serverRoot = typeof this.rpcBackend.getResolvedProjectWorkspaceRoot === 'function'
        ? this.rpcBackend.getResolvedProjectWorkspaceRoot()
        : undefined;
      this.resolvedServerRoot = serverRoot;
      if (
        serverRoot
        && this.configuredProjectPath
        && await this.vaultGuard.isOverlapping(this.vaultPath, serverRoot)
        && !(await this.vaultGuard.isOverlapping(this.vaultPath, this.workspacePath))
      ) {
        const msg = '配置的项目 ID 在服务端指向当前知识库目录，但与所填项目目录不一致；请对齐后再连接。';
        await Promise.allSettled([
          this.rpcBackend.disconnect(),
          this.cliBackend.disconnect(),
        ]);
        this.activeBackend = this.cliBackend;
        this.store.setConnection('disconnected', { ...CLI_BACKEND_CAPABILITIES }, msg);
        throw new VaultSecurityError(msg);
      }
      this.activeBackend = this.rpcBackend;
      this.store.setConnection('connected-rpc', caps);
      const [providers, threads] = await Promise.all([
        this.rpcBackend.getProviders(false),
        this.rpcBackend.listThreads(this.configuredProjectId),
      ]);
      this.store.setProviders(providers);
      this.store.setThreads(threads);
      return caps;
    } catch (rpcErr) {
      if (rpcErr instanceof VaultSecurityError) throw rpcErr;
      await this.rpcBackend.disconnect().catch(() => undefined);
      const rpcReason = redactSensitiveText(rpcErr instanceof Error ? rpcErr.message : '无法连接本地 T3 Code RPC 服务。');
      return this.connectCliOnly(rpcReason);
    }
  }

  private async connectCliOnly(fallbackReason?: string): Promise<BackendCapabilities> {
    try {
      const caps = await this.cliBackend.connect(this.workspacePath, this.configuredProjectId);
      if (this.configuredProjectId && typeof this.cliBackend.verifyWorkspaceProjectBinding === 'function') {
        await this.cliBackend.verifyWorkspaceProjectBinding(this.configuredProjectId);
      }
      this.activeBackend = this.cliBackend;
      this.store.setConnection('fallback-cli', caps, fallbackReason);
      const [providers, threads] = await Promise.all([
        this.cliBackend.getProviders(),
        this.cliBackend.listThreads(this.configuredProjectId),
      ]);
      this.store.setProviders(providers);
      this.store.setThreads(threads);
      return caps;
    } catch (cliErr) {
      const cliReason = redactSensitiveText(cliErr instanceof Error ? cliErr.message : 'T3 CLI 不可用。');
      const combined = fallbackReason ? `${fallbackReason} CLI 降级同样不可用：${cliReason}` : cliReason;
      this.activeBackend = this.cliBackend;
      this.store.setConnection('disconnected', { ...CLI_BACKEND_CAPABILITIES }, combined);
      throw new Error(combined, { cause: cliErr });
    }
  }

  async retryRpc(): Promise<BackendCapabilities> {
    return this.connect(this.vaultPath, this.configuredProjectPath, this.configuredProjectId);
  }

  async pairWithCode(pairingCode: string): Promise<BackendCapabilities> {
    const server = await this.discoverFn({
      serverUrl: this.options.getSettings().serverUrl?.trim() || undefined,
      cliPath: this.options.getSettings().cliPath,
    });
    await this.auth.pairWithCode({
      origin: server.origin,
      environmentId: server.environmentId,
      pairingCode,
    });
    return this.retryRpc();
  }

  async refreshProviders(): Promise<ProviderDescriptor[]> {
    const providers = await this.activeBackend.getProviders(true);
    this.store.setProviders(providers);
    return providers;
  }

  async refreshThreads(): Promise<CliThread[]> {
    const threads = await this.activeBackend.listThreads(this.configuredProjectId);
    this.store.setThreads(threads);
    return threads;
  }

  async openThread(threadId: string, onEvent?: (event: BackendEvent) => void): Promise<{ unsubscribe: () => void }> {
    const backend = this.activeBackend;
    return backend.openThread(threadId, event => {
      if (event.type === 'thread.detail' && backend.mode !== 'rpc') {
        this.store.setThreadDetail(threadId, event.detail);
      }
      onEvent?.(event);
    });
  }

  private async executeSend(
    targetBackend: T3Backend,
    input: SendMessageInput & { knownRuntimeMode?: string },
    flags: { createdNewThread: boolean },
  ): Promise<{ threadId: string; runId?: string; sequence?: number }> {
    const state = this.store.getSnapshot();
    const storeThread = input.threadId
      ? (state.activeThreadDetails.get(input.threadId)?.thread ?? state.threads.find(t => t.threadId === input.threadId))
      : undefined;
    const existingThread = Boolean(input.threadId && !flags.createdNewThread);
    const effectiveRuntimeMode = existingThread
      ? (storeThread?.runtimeMode ?? input.knownRuntimeMode)
      : (input.runtimeMode ?? input.knownRuntimeMode);

    for (const ctx of await this.getGuardContexts()) {
      await this.vaultGuard.assertCanSend(ctx, effectiveRuntimeMode);
    }

    this.store.upsertPendingDispatch({
      commandId: input.commandId,
      messageId: input.messageId,
      threadId: input.threadId,
      createdNewThread: flags.createdNewThread,
      projectId: input.projectId,
      text: input.text,
      runtimeMode: effectiveRuntimeMode,
      modelSelection: input.modelSelection,
      interactionMode: input.interactionMode,
      status: 'sending',
      createdAt: this.now(),
    });

    try {
      const result = await targetBackend.sendMessage(input);
      this.store.clearPendingDispatch(input.commandId);
      return result;
    } catch (error) {
      if (error instanceof UncertainWriteError) {
        const createdThreadId = this.rpcBackend.getPendingThreadIdForCommand(input.commandId);
        this.store.upsertPendingDispatch({
          commandId: input.commandId,
          messageId: input.messageId,
          threadId: input.threadId ?? createdThreadId,
          createdNewThread: flags.createdNewThread,
          projectId: input.projectId,
          text: input.text,
          runtimeMode: effectiveRuntimeMode,
          modelSelection: input.modelSelection,
          interactionMode: input.interactionMode,
          status: 'uncertain',
          createdAt: this.now(),
        });
        throw error;
      }
      this.store.clearPendingDispatch(input.commandId);
      throw error;
    }
  }

  async sendMessage(
    input: Omit<SendMessageInput, 'commandId' | 'messageId'> & {
      commandId?: string;
      messageId?: string;
      knownRuntimeMode?: string;
    },
  ): Promise<{ threadId: string; runId?: string; sequence?: number }> {
    const commandId = input.commandId ?? this.randomId();
    const messageId = input.messageId ?? this.randomId();
    const priorPending = this.store.getSnapshot().pendingDispatches.get(commandId);
    if (priorPending?.status === 'uncertain' && this.activeBackend.mode !== 'rpc') {
      throw new Error('当前处于 CLI 降级模式，禁止通过 CLI 重放未确认的 RPC 消息；请先恢复 RPC 连接。');
    }
    return this.executeSend(
      this.activeBackend,
      { ...input, commandId, messageId },
      { createdNewThread: priorPending?.createdNewThread ?? !input.threadId },
    );
  }

  /**
   * Re-checks whether an uncertain RPC write already committed on the server before replaying
   * with the exact same `commandId` and `messageId`. NEVER replays an uncertain RPC write on CLI.
   */
  async retryPendingDispatch(commandId: string): Promise<{ threadId: string; deduplicated: boolean }> {
    const pending = this.store.getSnapshot().pendingDispatches.get(commandId);
    if (!pending) {
      throw new Error('未找到需要重试的待确认发送记录。');
    }
    if (this.activeBackend !== this.rpcBackend || this.activeBackend.mode !== 'rpc') {
      throw new Error('当前处于 CLI 降级模式，禁止通过 CLI 重放未确认的 RPC 消息；请先恢复 RPC 连接。');
    }

    let status: 'committed' | 'thread-only' | 'missing' | 'unknown' = 'missing';
    if (pending.threadId) {
      if (typeof this.rpcBackend.inspectPendingWrite === 'function') {
        status = await this.rpcBackend.inspectPendingWrite(pending.threadId, pending.messageId);
      } else {
        status = (await this.rpcBackend.hasMessageOnServer(pending.threadId, pending.messageId))
          ? 'committed'
          : 'thread-only';
      }
      if (status === 'committed') {
        this.store.clearPendingDispatch(commandId);
        await this.refreshThreads().catch(() => undefined);
        return { threadId: pending.threadId, deduplicated: true };
      }
      if (status === 'unknown') {
        throw new Error('无法核对服务端消息状态，请稍后重试。');
      }
    }

    if (this.activeBackend !== this.rpcBackend || this.activeBackend.mode !== 'rpc') {
      throw new Error('等待校验期间 RPC 连接已断开，已阻止降级重发。');
    }

    const replayThreadId = status === 'missing' ? undefined : pending.threadId;
    const res = await this.executeSend(
      this.rpcBackend,
      {
        projectId: pending.projectId,
        threadId: replayThreadId,
        commandId: pending.commandId,
        messageId: pending.messageId,
        text: pending.text,
        ...(pending.modelSelection ? { modelSelection: pending.modelSelection } : {}),
        ...(pending.runtimeMode ? { runtimeMode: pending.runtimeMode, knownRuntimeMode: pending.runtimeMode } : {}),
        ...(pending.interactionMode ? { interactionMode: pending.interactionMode } : {}),
      },
      { createdNewThread: !replayThreadId || Boolean(pending.createdNewThread) },
    );
    return { threadId: res.threadId, deduplicated: false };
  }

  async stopThread(threadId: string, activeRunId?: string): Promise<void> {
    await this.activeBackend.stopThread(threadId, this.randomId(), activeRunId);
  }

  async setModelSelection(threadId: string, selection: BackendModelSelection): Promise<void> {
    await this.activeBackend.setModelSelection(threadId, this.randomId(), selection);
  }

  async setRuntimeMode(threadId: string, runtimeMode: string): Promise<void> {
    for (const ctx of await this.getGuardContexts()) {
      await this.vaultGuard.assertCanSetRuntimeMode(ctx, runtimeMode);
    }
    await this.activeBackend.setRuntimeMode(threadId, this.randomId(), runtimeMode);
  }

  async setInteractionMode(threadId: string, mode: 'default' | 'plan'): Promise<void> {
    await this.activeBackend.setInteractionMode(threadId, this.randomId(), mode);
  }

  async respondRuntimeRequest(input: Omit<ApprovalResponseInput, 'commandId'> & { commandId?: string }): Promise<void> {
    await this.activeBackend.respondRuntimeRequest({
      ...input,
      commandId: input.commandId ?? this.randomId(),
    });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.rpcBackend.disconnect(),
      this.cliBackend.disconnect(),
    ]);
    this.store.reset(true);
  }
}
