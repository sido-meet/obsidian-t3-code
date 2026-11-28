import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { cliInvocation } from './cli';
import { parseT3CmdLauncher, validateLoopbackOrigin } from './discovery';
import { record, redactSensitiveText } from './rpc';
export { redactSensitiveText };

const REQUIRED_SCOPES = ['orchestration:read', 'orchestration:operate'] as const;
const RENEW_MARGIN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 5_000;
const MAX_CLI_STDOUT_BYTES = 1_000_000;

export interface AuthSession {
  token: string;
  sessionId?: string;
  environmentId: string;
  origin: string;
  expiresAt?: number;
  issuedByCli: boolean;
}

export interface AuthDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  existsFn?: (path: string) => boolean;
  readFileFn?: (path: string) => string;
  runCli?: (executable: string, args: string[], envOverrides?: Record<string, string>, timeoutMs?: number) => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
}


function resolveCliCommand(cliPath: string, args: string[], deps: AuthDeps): {
  executable: string;
  args: string[];
  verbatim: boolean;
  envOverrides?: Record<string, string>;
} {
  const platform = deps.platform ?? process.platform;
  const exists = deps.existsFn ?? existsSync;
  const readFn = deps.readFileFn ?? (p => readFileSync(p, 'utf8'));

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    if (!exists(cliPath)) {
      throw new Error('指定的 T3 .cmd 启动器不存在。');
    }
    const parsed = parseT3CmdLauncher(cliPath, readFn);
    return {
      executable: parsed.executable,
      args: [...parsed.baseArgs, ...args],
      verbatim: false,
      envOverrides: parsed.envOverrides,
    };
  }
  return cliInvocation(cliPath, args, platform);
}

function defaultRunCli(
  cliPath: string,
  args: string[],
  deps: AuthDeps,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd: ReturnType<typeof resolveCliCommand>;
    try {
      cmd = resolveCliCommand(cliPath, args, deps);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('T3 CLI 启动器校验失败。'));
      return;
    }
    const child = spawn(cmd.executable, cmd.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: cmd.verbatim,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cmd.envOverrides
        ? {
            env: {
              ...cmd.envOverrides,
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              T3CODE_DESKTOP_CLI_LAUNCHER: '1',
            },
          }
        : {}),
    });

    let stdout = '';
    const kill = (message: string) => {
      clearTimeout(timer);
      if (process.platform === 'win32' && child.pid && child.exitCode === null) {
        const taskkill = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
          if (child.exitCode === null) child.kill();
        });
      } else {
        child.kill();
      }
      reject(new Error(message));
    };

    const timer = setTimeout(() => kill('T3 鉴权命令超时。'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_CLI_STDOUT_BYTES) kill('T3 鉴权输出超过大小限制。');
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动 T3 CLI 进行鉴权。'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('T3 CLI 签发短期会话失败。请确认本地 T3 Code 服务正在运行。'));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Memory-only scoped credential manager for `T3-Codian` RPC access.
 * Credentials are NEVER persisted to `data.json`, Obsidian Vault, localStorage, or logs.
 */
export class T3AuthManager {
  private session?: AuthSession;
  private inflight?: Promise<AuthSession>;
  private lastFailureAt?: number;

  constructor(private readonly deps: AuthDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private fetcher(): typeof fetch {
    return this.deps.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  }

  getCachedSession(): Readonly<AuthSession> | undefined {
    return this.session;
  }

  private isUsable(session: AuthSession, origin: string, environmentId: string): boolean {
    if (session.origin !== origin || session.environmentId !== environmentId) return false;
    if (session.expiresAt === undefined) return true;
    return session.expiresAt - this.now() > RENEW_MARGIN_MS;
  }

  private async verifyHttpSession(origin: string, token: string): Promise<{ expiresAt?: number }> {
    const res = await this.fetcher()(new URL('/api/auth/session', origin), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`会话校验失败（HTTP ${res.status}）。`);
    }
    const body = record(await res.json());
    if (body.authenticated !== true) {
      throw new Error('本地 T3 服务未认可签发的会话凭据。');
    }
    const granted = new Set([
      ...(Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : []),
      ...(Array.isArray(body.permissions) ? body.permissions.filter((s): s is string => typeof s === 'string') : []),
    ]);
    if (granted.size > 0 && !granted.has('orchestration:read')) {
      throw new Error('会话凭据缺少 orchestration:read 权限。');
    }
    const parsedExp = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : Number.NaN;
    return Number.isNaN(parsedExp) ? {} : { expiresAt: parsedExp };
  }

  private async execCli(cliPath: string, args: string[], timeoutMs?: number): Promise<string> {
    if (this.deps.runCli) {
      const cmd = resolveCliCommand(cliPath, args, this.deps);
      return this.deps.runCli(cmd.executable, cmd.args, cmd.envOverrides, timeoutMs);
    }
    return defaultRunCli(cliPath, args, this.deps, timeoutMs);
  }

  async ensureSession(options: {
    origin: string;
    environmentId: string;
    cliPath?: string;
    t3Home?: string;
  }): Promise<AuthSession> {
    const origin = validateLoopbackOrigin(options.origin);
    if (this.session && this.isUsable(this.session, origin, options.environmentId)) {
      return this.session;
    }
    if (this.inflight) return this.inflight;
    if (this.lastFailureAt !== undefined && this.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) {
      throw new Error('短期会话签发冷却中，请稍后重试。');
    }

    const cliPath = options.cliPath?.trim();
    if (!cliPath) {
      throw new Error('未找到可用的 T3 CLI，无法自动签发短期会话；请在设置中使用配对码授权。');
    }

    const work = (async (): Promise<AuthSession> => {
      const scopeArgs = REQUIRED_SCOPES.flatMap(scope => ['--scope', scope]);
      const baseDirArgs = options.t3Home ? ['--base-dir', options.t3Home] : [];
      const args = ['auth', 'session', 'issue', ...baseDirArgs, '--ttl', '30m', ...scopeArgs, '--label', 't3-codian', '--json'];
      const raw = await this.execCli(cliPath, args);
      const parsed = record(JSON.parse(raw));
      if (typeof parsed.token !== 'string' || !parsed.token) {
        throw new Error('T3 CLI 未返回有效的短期访问凭据。');
      }
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
      let verified: { expiresAt?: number };
      try {
        verified = await this.verifyHttpSession(origin, parsed.token);
      } catch (verifyErr) {
        if (sessionId) {
          void this.revokeCliSession(cliPath, sessionId, options.t3Home);
        }
        throw verifyErr;
      }
      const cliExp = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN;
      const expiresAt = verified.expiresAt ?? (Number.isNaN(cliExp) ? this.now() + 25 * 60_000 : cliExp);
      const next: AuthSession = {
        token: parsed.token,
        sessionId,
        environmentId: options.environmentId,
        origin,
        expiresAt,
        issuedByCli: true,
      };
      this.session = next;
      this.lastFailureAt = undefined;
      return next;
    })().catch(error => {
      this.lastFailureAt = this.now();
      throw new Error(redactSensitiveText(error instanceof Error ? error.message : 'T3 自动鉴权失败。'));
    }).finally(() => {
      this.inflight = undefined;
    });

    this.inflight = work;
    return work;
  }

  /** Exchanges a user-supplied one-time pairing code via `POST /oauth/token` and keeps the token strictly in memory. */
  async pairWithCode(options: {
    origin: string;
    environmentId: string;
    pairingCode: string;
  }): Promise<AuthSession> {
    const origin = validateLoopbackOrigin(options.origin);
    const code = options.pairingCode.trim();
    if (!code) throw new Error('请输入配对码。');

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: code,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: REQUIRED_SCOPES.join(' '),
      client_label: 'T3-Codian',
    });

    try {
      const res = await this.fetcher()(new URL('/oauth/token', origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`配对码兑换失败（HTTP ${res.status}）。请重新在 T3 Code 生成配对码。`);
      }
      const reply = record(await res.json());
      if (reply.token_type !== 'Bearer' || typeof reply.access_token !== 'string' || !reply.access_token) {
        throw new Error('T3 Code 未返回有效的 Bearer 访问凭据。');
      }
      const verified = await this.verifyHttpSession(origin, reply.access_token);
      const ttlMs = typeof reply.expires_in === 'number' && reply.expires_in > 0 ? reply.expires_in * 1000 : undefined;
      const next: AuthSession = {
        token: reply.access_token,
        environmentId: options.environmentId,
        origin,
        expiresAt: verified.expiresAt ?? (ttlMs ? this.now() + ttlMs : undefined),
        issuedByCli: false,
      };
      this.session = next;
      this.lastFailureAt = undefined;
      return next;
    } catch (error) {
      throw new Error(redactSensitiveText(error instanceof Error ? error.message : '配对码兑换失败。'), { cause: error });
    }
  }

  async renewOnUnauthorized(options: {
    origin: string;
    environmentId: string;
    cliPath?: string;
    t3Home?: string;
  }): Promise<AuthSession> {
    const prev = this.session;
    this.session = undefined;
    if (prev?.issuedByCli && prev.sessionId && options.cliPath) {
      void this.revokeCliSession(options.cliPath, prev.sessionId, options.t3Home);
    }
    return this.ensureSession(options);
  }

  async revokeAndClear(cliPath?: string, t3Home?: string): Promise<void> {
    const prev = this.session;
    this.session = undefined;
    if (prev?.issuedByCli && prev.sessionId && cliPath) {
      await this.revokeCliSession(cliPath, prev.sessionId, t3Home);
    }
  }

  private async revokeCliSession(cliPath: string, sessionId: string, t3Home?: string): Promise<void> {
    const args = ['auth', 'session', 'revoke', ...(t3Home ? ['--base-dir', t3Home] : []), sessionId];
    await this.execCli(cliPath, args, 5_000).catch(() => undefined);
  }
}
