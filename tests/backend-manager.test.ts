import { describe, expect, it, vi } from 'vitest';
import { T3AuthManager } from '../src/t3/auth';
import { CLI_BACKEND_CAPABILITIES, type BackendCapabilities } from '../src/t3/backend';
import { T3BackendManager, type BackendManagerSettings } from '../src/t3/backend-manager';
import { CliBackend } from '../src/t3/cli-backend';
import { RpcBackend, UncertainWriteError } from '../src/t3/rpc-backend';
import { T3Store } from '../src/t3/store';

function makeSettings(overrides: Partial<BackendManagerSettings> = {}): BackendManagerSettings {
  return {
    cliPath: '/usr/bin/t3',
    provider: 'codex',
    model: 'gpt-5',
    modelPresets: 'claudeAgent | claude-sonnet | reasoningEffort=high',
    serverUrl: '',
    backendPreference: 'auto',
    ...overrides,
  };
}

describe('T3BackendManager', () => {
  it('connects to RpcBackend first and falls back to CliBackend when RPC discovery/connection fails', async () => {
    const store = new T3Store();
    const rpcCaps: BackendCapabilities = { ...CLI_BACKEND_CAPABILITIES, mode: 'rpc', supportsLiveCatalog: true, supportsStreaming: true, supportsStop: true };
    let rpcShouldFail = false;

    const rpcBackend = {
      mode: 'rpc',
      connect: vi.fn(async () => {
        if (rpcShouldFail) throw new Error('Failed with Bearer secret-abc');
        return rpcCaps;
      }),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => [{
        instanceId: 'codex', driver: 'codex', displayName: 'Codex', enabled: true, installed: true,
        status: 'ready' as const, reportsContextWindow: true, supportedRuntimeModes: ['approval-required'],
        showInteractionModeToggle: true, models: [], quota: { status: 'unsupported' as const, windows: [] },
      }]),
      listThreads: vi.fn(async () => [{ threadId: 't-rpc', title: 'RPC Thread', status: 'idle', runtimeMode: 'approval-required' }]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: vi.fn(async () => ({ threadId: 't-rpc' })),
      stopThread: vi.fn(async () => undefined),
      setModelSelection: vi.fn(async () => undefined),
      setRuntimeMode: vi.fn(async () => undefined),
      setInteractionMode: vi.fn(async () => undefined),
      respondRuntimeRequest: vi.fn(async () => undefined),
      hasMessageOnServer: vi.fn(async () => false),
      getPendingThreadIdForCommand: vi.fn(() => undefined),
    } as unknown as RpcBackend;

    const cliBackend = {
      mode: 'cli',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [{ threadId: 't-cli', title: 'CLI Thread', status: 'idle' }]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: vi.fn(async () => ({ threadId: 't-cli' })),
      stopThread: vi.fn(async () => undefined),
      setModelSelection: vi.fn(async () => undefined),
      setRuntimeMode: vi.fn(async () => undefined),
      setInteractionMode: vi.fn(async () => undefined),
      respondRuntimeRequest: vi.fn(async () => undefined),
    } as unknown as CliBackend;

    const mgr = new T3BackendManager({
      getSettings: () => makeSettings(),
      store,
      rpcBackend,
      cliBackend,
    });

    await mgr.connect('E:\\Vault', 'E:\\CodeRepo', 'proj-1');
    expect(mgr.activeMode).toBe('rpc');
    expect(store.getSnapshot().connectionPhase).toBe('connected-rpc');
    expect(store.getSnapshot().threads[0].threadId).toBe('t-rpc');

    // Fall back to CLI when RPC fails, redacting tokens in the error banner
    rpcShouldFail = true;
    await mgr.retryRpc();
    expect(mgr.activeMode).toBe('cli');
    expect(store.getSnapshot().connectionPhase).toBe('fallback-cli');
    expect(store.getSnapshot().connectionError).toContain('Bearer [REDACTED]');
    expect(store.getSnapshot().connectionError).not.toContain('secret-abc');
    expect(store.getSnapshot().threads[0].threadId).toBe('t-cli');
  });

  it('enforces VaultSafetyGuard uniformly across both RPC and CLI backends', async () => {
    const store = new T3Store();
    const rpcSend = vi.fn(async () => ({ threadId: 'th-1' }));
    const rpcSetMode = vi.fn(async () => undefined);
    const cliSend = vi.fn(async () => ({ threadId: 'th-1' }));

    const rpcBackend = {
      mode: 'rpc',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES, mode: 'rpc' as const })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [{ threadId: 'th-1', title: 'Vault Thread', status: 'idle', runtimeMode: 'full-access' }]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: rpcSend,
      stopThread: vi.fn(async () => undefined),
      setModelSelection: vi.fn(async () => undefined),
      setRuntimeMode: rpcSetMode,
      setInteractionMode: vi.fn(async () => undefined),
      respondRuntimeRequest: vi.fn(async () => undefined),
      hasMessageOnServer: vi.fn(async () => false),
      getPendingThreadIdForCommand: vi.fn(() => undefined),
    } as unknown as RpcBackend;

    const cliBackend = {
      mode: 'cli',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [{ threadId: 'th-1', title: 'Vault Thread', status: 'idle', runtimeMode: 'full-access' }]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: cliSend,
    } as unknown as CliBackend;

    let preference: 'auto' | 'cli' = 'auto';
    const mgr = new T3BackendManager({
      getSettings: () => makeSettings({ backendPreference: preference }),
      store,
      rpcBackend,
      cliBackend,
    });

    // Project empty -> defaults to Vault path -> overlapping!
    await mgr.connect('E:\\MyVault', '', 'proj-vault');
    expect(await mgr.isVaultOverlapping()).toBe(true);

    await expect(mgr.sendMessage({ projectId: 'proj-vault', threadId: 'th-1', text: 'hi' })).rejects.toThrow('approval-required');
    await expect(mgr.setRuntimeMode('th-1', 'full-access')).rejects.toThrow('禁止');
    expect(rpcSend).not.toHaveBeenCalled();
    expect(rpcSetMode).not.toHaveBeenCalled();

    // Switching to CLI backend also preserves Vault block
    preference = 'cli';
    await mgr.connect('E:\\MyVault', '', 'proj-vault');
    await expect(mgr.sendMessage({ projectId: 'proj-vault', threadId: 'th-1', text: 'hi' })).rejects.toThrow('approval-required');
    expect(cliSend).not.toHaveBeenCalled();
  });

  it('never replays an uncertain RPC write via CLI and deduplicates committed writes on retry', async () => {
    const store = new T3Store();
    const cliSend = vi.fn(async () => ({ threadId: 'th-dup' }));
    let serverAlreadyHasMessage = false;
    let shouldDrop = true;
    let idSeq = 0;

    const rpcBackend = {
      mode: 'rpc',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES, mode: 'rpc' as const })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: vi.fn(async (input: { threadId?: string }) => {
        if (shouldDrop) throw new UncertainWriteError('socket dropped mid-flight');
        return { threadId: input.threadId ?? 'th-created' };
      }),
      hasMessageOnServer: vi.fn(async () => serverAlreadyHasMessage),
      getPendingThreadIdForCommand: vi.fn(() => 'th-created'),
    } as unknown as RpcBackend;

    const cliBackend = {
      mode: 'cli',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
      sendMessage: cliSend,
    } as unknown as CliBackend;

    let preference: 'auto' | 'cli' = 'auto';
    const mgr = new T3BackendManager({
      getSettings: () => makeSettings({ backendPreference: preference }),
      store,
      rpcBackend,
      cliBackend,
      randomId: () => `id-${++idSeq}`,
    });

    await mgr.connect('E:\\Vault', 'E:\\CodeRepo', 'proj-1');
    await expect(mgr.sendMessage({ projectId: 'proj-1', text: 'Do not duplicate', runtimeMode: 'approval-required' }))
      .rejects.toBeInstanceOf(UncertainWriteError);

    const pending = store.getSnapshot().pendingDispatches.get('id-1');
    expect(pending).toMatchObject({
      commandId: 'id-1',
      messageId: 'id-2',
      threadId: 'th-created',
      status: 'uncertain',
    });

    // While degraded to CLI, retry MUST refuse to resend on CLI
    preference = 'cli';
    await mgr.connect('E:\\Vault', 'E:\\CodeRepo', 'proj-1');
    await expect(mgr.retryPendingDispatch('id-1')).rejects.toThrow('CLI');
    expect(cliSend).not.toHaveBeenCalled();

    // Back on RPC: if server already committed messageId -> deduplicate cleanly without resending
    preference = 'auto';
    await mgr.connect('E:\\Vault', 'E:\\CodeRepo', 'proj-1');
    serverAlreadyHasMessage = true;
    const deduped = await mgr.retryPendingDispatch('id-1');
    expect(deduped).toEqual({ threadId: 'th-created', deduplicated: true });
    expect(store.getSnapshot().pendingDispatches.size).toBe(0);

    // If not yet committed -> replay with exact same commandId & messageId
    shouldDrop = true;
    idSeq = 10;
    await expect(mgr.sendMessage({ projectId: 'proj-1', text: 'Second attempt', runtimeMode: 'approval-required' }))
      .rejects.toBeInstanceOf(UncertainWriteError);
    serverAlreadyHasMessage = false;
    shouldDrop = false;
    const rpcSendSpy = rpcBackend.sendMessage as ReturnType<typeof vi.fn>;
    const replayed = await mgr.retryPendingDispatch('id-11');
    expect(replayed).toEqual({ threadId: 'th-created', deduplicated: false });
    expect(rpcSendSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      commandId: 'id-11',
      messageId: 'id-12',
      threadId: 'th-created',
      runtimeMode: 'approval-required',
    }));
  });

  it('prevents runtimeMode shadowing, handles missing 404 thread retry, blocks TOCTOU CLI replay, and rejects mismatched Vault projectId', async () => {
    const store = new T3Store();
    const rpcSend = vi.fn(async (input: { threadId?: string }) => ({ threadId: input.threadId ?? 'th-recreated' }));
    let inspectStatus: 'committed' | 'thread-only' | 'missing' | 'unknown' = 'missing';
    let flipToCliDuringInspect = false;
    let idSeq = 0;

    const mgrHolder: { mgr?: T3BackendManager } = {};
    const rpcBackend = {
      mode: 'rpc',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES, mode: 'rpc' as const })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [{ threadId: 'th-full', title: 'Full', status: 'idle', runtimeMode: 'full-access' }]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      sendMessage: rpcSend,
      inspectPendingWrite: vi.fn(async () => {
        if (flipToCliDuringInspect && mgrHolder.mgr) {
          (mgrHolder.mgr as unknown as { activeBackend: unknown }).activeBackend = cliBackend;
        }
        return inspectStatus;
      }),
      getPendingThreadIdForCommand: vi.fn(() => 'th-lost'),
      getResolvedProjectWorkspaceRoot: vi.fn(() => 'E:\\RealVault'),
    } as unknown as RpcBackend;

    const cliBackend = {
      mode: 'cli',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ threadId: 'th-cli' })),
      setRuntimeMode: vi.fn(async () => { throw new Error('CLI 不支持'); }),
    } as unknown as CliBackend;

    let settings = makeSettings();
    const mgrRef = new T3BackendManager({
      getSettings: () => settings,
      store,
      rpcBackend,
      cliBackend,
      randomId: () => `m-${++idSeq}`,
    });
    mgrHolder.mgr = mgrRef;

    // Mismatched projectPath outside Vault + projectId pointing inside Vault falls back fail-closed instead of bypassing Vault
    await mgrRef.connect('E:\\RealVault', 'E:\\Outside', 'proj-vault-id');
    expect(rpcBackend.disconnect).toHaveBeenCalled();
    expect(mgrRef.activeMode).toBe('cli');
    expect(store.getSnapshot().connectionError).toContain('不一致');

    // Valid Vault connection: existing full-access thread CANNOT be shadowed by passing runtimeMode: 'approval-required'
    (rpcBackend.getResolvedProjectWorkspaceRoot as ReturnType<typeof vi.fn>).mockReturnValue('E:\\RealVault');
    await mgrRef.connect('E:\\RealVault', 'E:\\RealVault', 'proj-vault-id');
    await expect(mgrRef.sendMessage({
      projectId: 'proj-vault-id',
      threadId: 'th-full',
      runtimeMode: 'approval-required',
      text: 'bypass attempt',
    })).rejects.toThrow('approval-required');
    expect(rpcSend).not.toHaveBeenCalled();

    // Brand-new Vault thread hitting UncertainWriteError retains approval-required and clears threadId on 404 'missing' retry
    rpcSend.mockRejectedValueOnce(new UncertainWriteError('dropped during thread.create'));
    await expect(mgrRef.sendMessage({
      projectId: 'proj-vault-id',
      runtimeMode: 'approval-required',
      text: 'retry new vault thread',
    })).rejects.toBeInstanceOf(UncertainWriteError);

    inspectStatus = 'missing';
    const recreated = await mgrRef.retryPendingDispatch('m-3');
    expect(recreated).toEqual({ threadId: 'th-recreated', deduplicated: false });
    expect(rpcSend).toHaveBeenLastCalledWith(expect.objectContaining({
      commandId: 'm-3',
      messageId: 'm-4',
      threadId: undefined,
      runtimeMode: 'approval-required',
    }));

    // TOCTOU race: if backend falls back to CLI while inspectPendingWrite is in flight, replay is aborted
    rpcSend.mockRejectedValueOnce(new UncertainWriteError('dropped mid-flight'));
    await expect(mgrRef.sendMessage({
      projectId: 'proj-vault-id',
      runtimeMode: 'approval-required',
      text: 'toctou guard',
    })).rejects.toBeInstanceOf(UncertainWriteError);
    inspectStatus = 'thread-only';
    flipToCliDuringInspect = true;
    await expect(mgrRef.retryPendingDispatch('m-5')).rejects.toThrow('RPC 连接已断开');
    expect(cliBackend.sendMessage).not.toHaveBeenCalled();

    // Verify both-backends-fail -> 'disconnected' and setRuntimeMode delegation in CLI mode
    settings = makeSettings({ backendPreference: 'cli' });
    (cliBackend.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('cli missing'));
    await expect(mgrRef.connect('E:\\RealVault', 'E:\\RealVault', 'p')).rejects.toThrow('cli missing');
    expect(store.getSnapshot().connectionPhase).toBe('disconnected');
    await expect(mgrRef.setRuntimeMode('th-1', 'approval-required')).rejects.toThrow('CLI 不支持');
  });

  it('pairs via memory-only OAuth token exchange and disposes sessions cleanly', async () => {
    const auth = {
      pairWithCode: vi.fn(async () => ({ token: 'p-1', environmentId: 'env-1', origin: 'http://127.0.0.1:3773', issuedByCli: false })),
    } as unknown as T3AuthManager;
    const rpcBackend = {
      mode: 'rpc',
      connect: vi.fn(async () => ({ ...CLI_BACKEND_CAPABILITIES, mode: 'rpc' as const })),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => []),
    } as unknown as RpcBackend;
    const cliBackend = {
      mode: 'cli',
      disconnect: vi.fn(async () => undefined),
    } as unknown as CliBackend;

    const mgr = new T3BackendManager({
      getSettings: () => makeSettings(),
      auth,
      rpcBackend,
      cliBackend,
      discoverFn: async () => ({
        origin: 'http://127.0.0.1:3773',
        environmentId: 'env-1',
        serverVersion: '0.1.13',
        orchestrationProtocolVersion: 2,
        capabilities: {},
      }),
    });

    await mgr.pairWithCode('bootstrap-code');
    expect(auth.pairWithCode).toHaveBeenCalledWith({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      pairingCode: 'bootstrap-code',
    });
    expect(mgr.activeMode).toBe('rpc');

    await mgr.dispose();
    expect(rpcBackend.disconnect).toHaveBeenCalled();
    expect(cliBackend.disconnect).toHaveBeenCalled();
  });
});
