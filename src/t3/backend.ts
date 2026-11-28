import type { CliThread } from './cli';
import type { Message } from './transcript';

export type BackendMode = 'rpc' | 'cli';

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected-rpc'
  | 'fallback-cli'
  | 'disconnected';

export interface BackendCapabilities {
  mode: BackendMode;
  supportsLiveCatalog: boolean;
  supportsProviderRefresh: boolean;
  supportsStreaming: boolean;
  supportsStop: boolean;
  supportsMidThreadModelSwitch: boolean;
  supportsRuntimeModeSwitch: boolean;
  supportsInteractionModeSwitch: boolean;
  supportsApprovals: boolean;
  supportsContextUsage: boolean;
  supportsQuotaUsage: boolean;
}

export const CLI_BACKEND_CAPABILITIES: BackendCapabilities = {
  mode: 'cli',
  supportsLiveCatalog: false,
  supportsProviderRefresh: false,
  supportsStreaming: false,
  supportsStop: false,
  supportsMidThreadModelSwitch: false,
  supportsRuntimeModeSwitch: false,
  supportsInteractionModeSwitch: false,
  supportsApprovals: false,
  supportsContextUsage: false,
  supportsQuotaUsage: false,
};

export interface ModelOptionChoice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ModelOptionDescriptor {
  id: string;
  type: 'select' | 'boolean';
  label: string;
  role?: string;
  currentValue?: string | boolean;
  options?: ModelOptionChoice[];
}

export interface ProviderModelDescriptor {
  providerId: string;
  slug: string;
  name: string;
  shortName?: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  reasoningOption?: ModelOptionDescriptor;
  extraOptions: ModelOptionDescriptor[];
}

export interface AccountQuotaWindow {
  id: string;
  kind: 'session' | 'weekly' | 'monthly' | 'other';
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

export interface AccountQuotaSnapshot {
  status: 'available' | 'unsupported' | 'unknown' | 'loading' | 'error';
  reason?: string;
  checkedAt?: string;
  windows: AccountQuotaWindow[];
}

export interface ProviderDescriptor {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: 'ready' | 'warning' | 'error' | 'disabled';
  reportsContextWindow: boolean;
  supportedRuntimeModes: string[];
  showInteractionModeToggle: boolean;
  models: ProviderModelDescriptor[];
  quota: AccountQuotaSnapshot;
}

export interface ContextUsageSnapshot {
  status: 'available' | 'unknown';
  usedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  percent?: number;
  source?: 'providerTurn' | 'providerThread' | 'compaction';
  updatedAt?: string;
}

export interface TurnItemSummary {
  id: string;
  runId?: string;
  type: string;
  title?: string;
  status?: string;
  detail?: string;
}

export interface RuntimeRequestItem {
  id: string;
  threadId: string;
  kind: string;
  status: string;
  title?: string;
  command?: string;
  detail?: string;
  supportsFeedback: boolean;
  decision?: string;
  createdAt?: string;
}

export interface BackendModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface ThreadDetail {
  thread: CliThread;
  messages: Message[];
  turnItems: TurnItemSummary[];
  runtimeRequests: RuntimeRequestItem[];
  contextUsage: ContextUsageSnapshot;
  activeRunId?: string;
  latestRunId?: string;
  runIds: string[];
  lastSequence: number;
  synchronized: boolean;
}

export interface SendMessageInput {
  projectId: string;
  threadId?: string;
  commandId: string;
  messageId: string;
  text: string;
  modelSelection?: BackendModelSelection;
  runtimeMode?: string;
  interactionMode?: 'default' | 'plan';
  expectedRunId?: string;
  onThreadReady?: (threadId: string) => Promise<void> | void;
}

export interface ApprovalResponseInput {
  threadId: string;
  requestId: string;
  commandId: string;
  decision?: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
  feedback?: string;
  answers?: Record<string, unknown>;
}

export type BackendEvent =
  | { type: 'thread.detail'; detail: ThreadDetail }
  | { type: 'thread.resync-required'; threadId: string }
  | { type: 'error'; message: string };

export interface T3Backend {
  readonly mode: BackendMode;
  connect(projectWorkspacePath: string, projectId: string): Promise<BackendCapabilities>;
  disconnect(): Promise<void>;
  getProviders(refresh?: boolean): Promise<ProviderDescriptor[]>;
  listThreads(projectId: string): Promise<CliThread[]>;
  openThread(threadId: string, onEvent: (event: BackendEvent) => void): Promise<{ unsubscribe: () => void }>;
  sendMessage(input: SendMessageInput): Promise<{ threadId: string; runId?: string; sequence?: number }>;
  stopThread(threadId: string, commandId: string, activeRunId?: string): Promise<void>;
  setModelSelection(threadId: string, commandId: string, selection: BackendModelSelection): Promise<void>;
  setRuntimeMode(threadId: string, commandId: string, runtimeMode: string): Promise<void>;
  setInteractionMode(threadId: string, commandId: string, mode: 'default' | 'plan'): Promise<void>;
  respondRuntimeRequest(input: ApprovalResponseInput): Promise<void>;
}

export type { CliThread, Message };
