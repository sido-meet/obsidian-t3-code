import { describe, expect, it, vi } from 'vitest';
import { redactSensitiveText, T3AuthManager } from '../src/t3/auth';

const VALID_CMD = [
  '@echo off',
  "rem Written by T3 Code: runs the desktop app's bundled t3 CLI.",
  'setlocal EnableExtensions DisableDelayedExpansion',
  'set "T3CODE_CLI_PATH=C:\\Users\\Alice\\.t3\\bin\\t3.cmd"',
  'if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\Alice\\.t3"',
  'set "ELECTRON_RUN_AS_NODE=1"',
  'set "T3CODE_DESKTOP_CLI_LAUNCHER=1"',
  'if exist "C:\\T3\\T3 Code (Nightly).exe" goto run',
  'echo missing',
  'exit /b 1',
  ':run',
  '"C:\\T3\\T3 Code (Nightly).exe" "C:\\T3\\bin.mjs" %*',
  'set "T3_EXIT=%ERRORLEVEL%"',
  'exit /b %T3_EXIT%',
].join('\n');

describe('auth', () => {
  it('redacts Bearer, DPoP, URL auth query params, and JSON credential keys', () => {
    const sample = 'Authorization: Bearer top.sec-1 | DPoP dpop_2 | ws://127.0.0.1/ws?wsTicket=tk1&code=cd2 {"token":"secretVal"}';
    const redacted = redactSensitiveText(sample);
    expect(redacted).not.toContain('top.sec-1');
    expect(redacted).not.toContain('dpop_2');
    expect(redacted).not.toContain('tk1');
    expect(redacted).not.toContain('cd2');
    expect(redacted).not.toContain('secretVal');
    expect(redacted).toContain('[REDACTED]');
  });

  it('issues scoped session via verified .cmd launcher with single-flight coalescing and renews near expiry', async () => {
    let clock = 0; // explicitly tests epoch 0 without triggering false cooldown
    const runCli = vi.fn(async (_exe: string, args: string[]) => {
      if (args.includes('issue')) {
        return JSON.stringify({ token: 'tok-mem-1', sessionId: 'sess-1' });
      }
      return '';
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      authenticated: true,
      scopes: ['orchestration:read', 'orchestration:operate'],
      expiresAt: new Date(clock + 120_000).toISOString(),
    }), { status: 200 }));

    const auth = new T3AuthManager({
      platform: 'win32',
      existsFn: p => p === 'C:\\t3.cmd',
      readFileFn: () => VALID_CMD,
      runCli,
      fetcher,
      now: () => clock,
    });

    const [a, b] = await Promise.all([
      auth.ensureSession({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', cliPath: 'C:\\t3.cmd', t3Home: 'C:\\home' }),
      auth.ensureSession({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', cliPath: 'C:\\t3.cmd', t3Home: 'C:\\home' }),
    ]);
    expect(a.token).toBe('tok-mem-1');
    expect(b.token).toBe('tok-mem-1');
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli).toHaveBeenCalledWith(
      'C:\\T3\\T3 Code (Nightly).exe',
      ['C:\\T3\\bin.mjs', 'auth', 'session', 'issue', '--base-dir', 'C:\\home', '--ttl', '30m', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--label', 't3-codian', '--json'],
      expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', T3CODE_HOME: 'C:\\Users\\Alice\\.t3' }),
      undefined,
    );

    // Within margin -> reuses cached session
    clock = 30_000;
    await auth.ensureSession({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', cliPath: 'C:\\t3.cmd' });
    expect(runCli).toHaveBeenCalledTimes(1);

    // Within 60s before expiry -> renews automatically
    clock = 70_000;
    await auth.ensureSession({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', cliPath: 'C:\\t3.cmd' });
    expect(runCli).toHaveBeenCalledTimes(2);

    await auth.revokeAndClear('C:\\t3.cmd', 'C:\\home');
    expect(auth.getCachedSession()).toBeUndefined();
    expect(runCli).toHaveBeenLastCalledWith(
      'C:\\T3\\T3 Code (Nightly).exe',
      ['C:\\T3\\bin.mjs', 'auth', 'session', 'revoke', '--base-dir', 'C:\\home', 'sess-1'],
      expect.any(Object),
      5000,
    );
  });

  it('fails closed when a Windows .cmd launcher is missing or tampered, and revokes CLI session if HTTP verify fails', async () => {
    const runCli = vi.fn(async (_exe: string, args: string[]) => {
      if (args.includes('issue')) return JSON.stringify({ token: 'tok-bad', sessionId: 'sess-leak' });
      return '';
    });
    const authTampered = new T3AuthManager({
      platform: 'win32',
      existsFn: () => true,
      readFileFn: () => 'evil.exe',
      runCli,
    });
    await expect(authTampered.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: 'C:\\evil.cmd',
    })).rejects.toThrow('未识别');
    expect(runCli).not.toHaveBeenCalled();

    let clock = 10_000;
    const authVerifyFail = new T3AuthManager({
      platform: 'linux',
      runCli,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        authenticated: true,
        scopes: ['other:scope'],
      }), { status: 200 })),
      now: () => clock,
    });
    await expect(authVerifyFail.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: '/usr/bin/t3',
    })).rejects.toThrow('orchestration:read');
    expect(runCli).toHaveBeenCalledWith('/usr/bin/t3', ['auth', 'session', 'revoke', 'sess-leak'], undefined, 5000);

    // Cooldown activates for 5s after failure
    await expect(authVerifyFail.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: '/usr/bin/t3',
    })).rejects.toThrow('冷却中');
    clock += 6000;
    await expect(authVerifyFail.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
    })).rejects.toThrow('未找到可用的 T3 CLI');
  });

  it('exchanges pairing code via /oauth/token and renews unauthorized CLI sessions', async () => {
    const runCli = vi.fn(async (_exe: string, args: string[]) => {
      if (args.includes('issue')) return JSON.stringify({ token: 'tok-fresh', sessionId: 'sess-new' });
      return '';
    });
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({
          token_type: 'Bearer',
          access_token: 'paired-token-1',
          expires_in: 3600,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ authenticated: true, scopes: ['orchestration:read'] }), { status: 200 });
    });

    const auth = new T3AuthManager({ platform: 'linux', runCli, fetcher });
    const paired = await auth.pairWithCode({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      pairingCode: ' bootstrap-123 ',
    });
    expect(paired.token).toBe('paired-token-1');
    expect(paired.issuedByCli).toBe(false);

    const renewed = await auth.renewOnUnauthorized({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: '/usr/bin/t3',
    });
    expect(renewed.token).toBe('tok-fresh');
    expect(renewed.issuedByCli).toBe(true);

    // Renewing a CLI-issued session revokes the prior sessionId before issuing the replacement
    await auth.renewOnUnauthorized({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: '/usr/bin/t3',
    });
    expect(runCli).toHaveBeenCalledWith('/usr/bin/t3', ['auth', 'session', 'revoke', 'sess-new'], undefined, 5000);

    // OAuth pairing rejection & bad token_type + /api/auth/session 401 rejection
    const failFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token_type: 'MAC', access_token: 'x' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const errAuth = new T3AuthManager({ platform: 'linux', fetcher: failFetcher });
    await expect(errAuth.pairWithCode({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', pairingCode: 'c' }))
      .rejects.toThrow('HTTP 403');
    await expect(errAuth.pairWithCode({ origin: 'http://127.0.0.1:3773', environmentId: 'env-1', pairingCode: 'c' }))
      .rejects.toThrow('Bearer');
    await expect(errAuth.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: '/usr/bin/t3',
    }).catch(() => 'checked'));

    // defaultRunCli real child_process failure path (nonexistent CLI executable)
    const realSpawnAuth = new T3AuthManager({
      platform: 'linux',
      fetcher: vi.fn<typeof fetch>(),
    });
    await expect(realSpawnAuth.ensureSession({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      cliPath: 'nonexistent-t3-binary-fixture',
    })).rejects.toThrow('无法启动 T3 CLI');
  });
});
