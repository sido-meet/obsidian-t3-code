import {
  CLI_BACKEND_CAPABILITIES,
  type BackendCapabilities,
  type BackendModelSelection,
  type ConnectionPhase,
  type ProviderDescriptor,
  type ThreadDetail,
} from './backend';
import type { CliThread } from './cli';

export interface PendingDispatch {
  commandId: string;
  messageId: string;
  threadId?: string;
  createdNewThread?: boolean;
  projectId: string;
  text: string;
  runtimeMode?: string;
  modelSelection?: BackendModelSelection;
  interactionMode?: 'default' | 'plan';
  status: 'sending' | 'uncertain';
  createdAt: number;
}

export interface T3StoreState {
  connectionPhase: ConnectionPhase;
  connectionError?: string;
  capabilities: BackendCapabilities;
  providers: ProviderDescriptor[];
  threads: CliThread[];
  activeThreadDetails: ReadonlyMap<string, ThreadDetail>;
  pendingDispatches: ReadonlyMap<string, PendingDispatch>;
}

export type StoreListener = (state: T3StoreState) => void;

/**
 * Single client-side projection cache holding backend connection state, providers,
 * shell thread list, on-demand open thread details, and in-flight idempotent dispatches.
 */
export class T3Store {
  private readonly listeners = new Set<StoreListener>();
  private state: T3StoreState = {
    connectionPhase: 'idle',
    capabilities: { ...CLI_BACKEND_CAPABILITIES },
    providers: [],
    threads: [],
    activeThreadDetails: new Map(),
    pendingDispatches: new Map(),
  };

  getSnapshot(): T3StoreState {
    return this.state;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private commit(patch: Partial<T3StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }

  setConnection(connectionPhase: ConnectionPhase, capabilities?: BackendCapabilities, connectionError?: string): void {
    this.commit({
      connectionPhase,
      ...(capabilities ? { capabilities } : {}),
      connectionError,
    });
  }

  setProviders(providers: ProviderDescriptor[]): void {
    this.commit({ providers: [...providers] });
  }

  setThreads(threads: CliThread[]): void {
    this.commit({ threads: [...threads] });
  }

  setThreadDetail(threadId: string, detail: ThreadDetail): void {
    const next = new Map(this.state.activeThreadDetails);
    next.set(threadId, detail);
    this.commit({ activeThreadDetails: next });
  }

  removeThreadDetail(threadId: string): void {
    if (!this.state.activeThreadDetails.has(threadId)) return;
    const next = new Map(this.state.activeThreadDetails);
    next.delete(threadId);
    this.commit({ activeThreadDetails: next });
  }

  upsertPendingDispatch(pending: PendingDispatch): void {
    const next = new Map(this.state.pendingDispatches);
    next.set(pending.commandId, pending);
    this.commit({ pendingDispatches: next });
  }

  clearPendingDispatch(commandId: string): void {
    if (!this.state.pendingDispatches.has(commandId)) return;
    const next = new Map(this.state.pendingDispatches);
    next.delete(commandId);
    this.commit({ pendingDispatches: next });
  }

  reset(clearDispatches = false): void {
    this.commit({
      connectionPhase: 'idle',
      connectionError: undefined,
      capabilities: { ...CLI_BACKEND_CAPABILITIES },
      providers: [],
      threads: [],
      activeThreadDetails: new Map(),
      ...(clearDispatches ? { pendingDispatches: new Map() } : {}),
    });
  }
}
