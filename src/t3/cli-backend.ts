import { configuredModels, type Settings } from '../settings';
import { CliChat, cliRunner, type CliThread, type ModelSelection } from './cli';
import {
  CLI_BACKEND_CAPABILITIES,
  type ApprovalResponseInput,
  type BackendCapabilities,
  type BackendEvent,
  type BackendModelSelection,
  type ProviderDescriptor,
  type ProviderModelDescriptor,
  type SendMessageInput,
  type T3Backend,
} from './backend';

const ACTIVE_CLI_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting', 'working']);
const DEFAULT_CLI_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];

export interface CliBackendOptions {
  getSettings: () => Pick<Settings, 'cliPath' | 'provider' | 'model' | 'modelPresets'>;
  createRunner?: typeof cliRunner;
  pollIntervalMs?: number;
}

function toCliSelection(sel?: BackendModelSelection): ModelSelection | undefined {
  if (!sel) return undefined;
  const firstOpt = sel.options?.[0];
  const option = firstOpt ? `${firstOpt.id}=${String(firstOpt.value)}` : undefined;
  return { provider: sel.instanceId, model: sel.model, ...(option ? { option } : {}) };
}

/**
 * Fallback backend wrapping the official `t3 thread list/start/send/show` CLI commands.
 * Honest capability boundary: no live server catalog, context usage, quota, streaming deltas, stop, or inline approvals.
 */
export class CliBackend implements T3Backend {
  readonly mode = 'cli' as const;
  private controller?: AbortController;
  private workspacePath = '';

  constructor(private readonly options: CliBackendOptions) {}

  private newChat(signal?: AbortSignal, selection?: ModelSelection): CliChat {
    const { cliPath } = this.options.getSettings();
    const runnerFactory = this.options.createRunner ?? cliRunner;
    return new CliChat(runnerFactory(cliPath, signal ?? new AbortController().signal), selection);
  }

  async connect(projectWorkspacePath: string, _projectId: string): Promise<BackendCapabilities> {
    this.workspacePath = projectWorkspacePath;
    this.controller?.abort();
    this.controller = new AbortController();
    const chat = this.newChat(this.controller.signal);
    await chat.check(projectWorkspacePath);
    return { ...CLI_BACKEND_CAPABILITIES };
  }

  async disconnect(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
  }

  async getProviders(): Promise<ProviderDescriptor[]> {
    const entries = configuredModels(this.options.getSettings());
    const byProvider = new Map<string, Map<string, ProviderModelDescriptor>>();

    for (const entry of entries) {
      let models = byProvider.get(entry.provider);
      if (!models) {
        models = new Map();
        byProvider.set(entry.provider, models);
      }
      let modelDesc = models.get(entry.model);
      if (!modelDesc) {
        modelDesc = {
          providerId: entry.provider,
          slug: entry.model,
          name: entry.model,
          extraOptions: [],
        };
        models.set(entry.model, modelDesc);
      }
      if (entry.option) {
        const sep = entry.option.indexOf('=');
        if (sep > 0) {
          const optId = entry.option.slice(0, sep);
          const optVal = entry.option.slice(sep + 1);
          const existing = modelDesc.reasoningOption;
          const choices = [...(existing?.options ?? [])];
          if (!choices.some(c => c.id === optVal)) {
            choices.push({ id: optVal, label: optVal });
          }
          modelDesc.reasoningOption = {
            id: existing?.id ?? optId,
            type: 'select',
            label: existing?.label ?? optId,
            role: 'reasoning',
            options: choices,
          };
        }
      }
    }

    return [...byProvider.entries()].map(([providerId, models]) => ({
      instanceId: providerId,
      driver: providerId,
      displayName: providerId,
      enabled: true,
      installed: true,
      status: 'ready' as const,
      reportsContextWindow: false,
      supportedRuntimeModes: [...DEFAULT_CLI_MODES],
      showInteractionModeToggle: false,
      models: [...models.values()],
      quota: {
        status: 'unsupported',
        reason: 'CLI 降级模式不提供 Provider 额度查询。',
        windows: [],
      },
    }));
  }

  async listThreads(projectId: string): Promise<CliThread[]> {
    const chat = this.newChat(this.controller?.signal);
    return chat.list(projectId || this.workspacePath);
  }

  async openThread(threadId: string, onEvent: (event: BackendEvent) => void): Promise<{ unsubscribe: () => void }> {
    const ac = new AbortController();
    const chat = this.newChat(ac.signal);
    chat.threadId = threadId;
    const intervalMs = this.options.pollIntervalMs ?? 1600;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const poll = async (): Promise<void> => {
      if (closed || ac.signal.aborted) return;
      try {
        const snapshot = await chat.read();
        if (closed || ac.signal.aborted || !snapshot) return;
        onEvent({
          type: 'thread.detail',
          detail: {
            thread: snapshot.thread,
            messages: snapshot.messages,
            turnItems: [],
            runtimeRequests: [],
            contextUsage: { status: 'unknown' },
            latestRunId: snapshot.latestRunId,
            runIds: snapshot.runIds,
            lastSequence: 0,
            synchronized: true,
          },
        });
        if (ACTIVE_CLI_STATUSES.has(snapshot.status) && !closed) {
          timer = setTimeout(() => void poll(), intervalMs);
        }
      } catch (error) {
        if (closed || ac.signal.aborted) return;
        onEvent({ type: 'error', message: error instanceof Error ? error.message : '无法读取会话。' });
      }
    };

    await poll();
    return {
      unsubscribe: () => {
        closed = true;
        clearTimeout(timer);
        ac.abort();
      },
    };
  }

  async sendMessage(input: SendMessageInput): Promise<{ threadId: string; runId?: string }> {
    const chat = this.newChat(this.controller?.signal, toCliSelection(input.modelSelection));
    chat.threadId = input.threadId;
    const runId = await chat.send(input.projectId, input.text);
    if (!chat.threadId) throw new Error('T3 CLI 未返回会话 ID。');
    return { threadId: chat.threadId, ...(runId ? { runId } : {}) };
  }

  async stopThread(): Promise<void> {
    throw new Error('CLI 降级模式不支持停止正在运行的任务，请在 T3 Code 中处理。');
  }

  async setModelSelection(): Promise<void> {
    throw new Error('CLI 降级模式不支持在已有会话中切换模型。');
  }

  async setRuntimeMode(): Promise<void> {
    throw new Error('CLI 降级模式不支持修改会话运行权限，请在 T3 Code 中调整。');
  }

  async setInteractionMode(): Promise<void> {
    throw new Error('CLI 降级模式不支持切换交互模式。');
  }

  async respondRuntimeRequest(_input: ApprovalResponseInput): Promise<void> {
    throw new Error('CLI 降级模式不支持在侧栏响应审批，请在 T3 Code 中确认。');
  }
}
