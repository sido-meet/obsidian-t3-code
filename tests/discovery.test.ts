import { describe, expect, it, vi } from 'vitest';
import {
  discoverCliPath,
  discoverLocalServer,
  isProcessAlive,
  parseT3CmdLauncher,
  resolveT3Home,
  validateLoopbackOrigin,
} from '../src/t3/discovery';

const VALID_CMD_LINES = [
  '@echo off',
  "rem Written by T3 Code: runs the desktop app's bundled t3 CLI.",
  'setlocal EnableExtensions DisableDelayedExpansion',
  'set "T3CODE_CLI_PATH=C:\\Users\\Alice\\.t3\\bin\\t3.cmd"',
  'if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\Alice\\.t3"',
  'set "ELECTRON_RUN_AS_NODE=1"',
  'set "T3CODE_DESKTOP_CLI_LAUNCHER=1"',
  'if exist "C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe" goto run',
  'echo Error: missing binary',
  'exit /b 1',
  ':run',
  '"C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe" "C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\resources\\server.asar\\apps\\server\\dist\\bin.mjs" %*',
  'set "T3_EXIT=%ERRORLEVEL%"',
  'exit /b %T3_EXIT%',
];

describe('discovery', () => {
  it('validates loopback origins strictly and rejects remote or parameterized URLs', () => {
    expect(validateLoopbackOrigin('http://127.0.0.1:3773/')).toBe('http://127.0.0.1:3773');
    expect(validateLoopbackOrigin('https://localhost:8443')).toBe('https://localhost:8443');
    expect(validateLoopbackOrigin('http://[::1]:3773')).toBe('http://[::1]:3773');

    expect(() => validateLoopbackOrigin('http://192.168.1.2:3773')).toThrow('回环地址');
    expect(() => validateLoopbackOrigin('ws://127.0.0.1:3773')).toThrow('回环地址');
    expect(() => validateLoopbackOrigin('http://user:pass@127.0.0.1:3773')).toThrow('回环地址');
    expect(() => validateLoopbackOrigin('http://127.0.0.1:3773/subpath')).toThrow('回环地址');
    expect(() => validateLoopbackOrigin('http://127.0.0.1:3773/?a=1')).toThrow('回环地址');
  });

  it('checks process liveness safely', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('discovers CLI path without falling back to Electron GUI executables', () => {
    expect(discoverCliPath('C:\\custom\\t3.cmd')).toBe('C:\\custom\\t3.cmd');

    const guiOnlyPaths = new Set([
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code.exe',
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe',
    ]);
    expect(discoverCliPath('t3', {
      platform: 'win32',
      homeDir: 'C:\\Users\\Alice',
      env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local', PATH: '' },
      existsFn: p => guiOnlyPaths.has(p),
    })).toBe('t3');

    const cmdPath = 'C:\\Users\\Alice\\.t3\\bin\\t3.cmd';
    expect(discoverCliPath('', {
      platform: 'win32',
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: p => p === cmdPath,
    })).toBe(cmdPath);

    expect(discoverCliPath('', {
      platform: 'linux',
      homeDir: '/home/alice',
      env: { PATH: '/opt/custom/bin' },
      existsFn: p => p === '/opt/custom/bin/t3',
    })).toBe('/opt/custom/bin/t3');
  });

  it('strictly parses valid 14-line Windows T3 .cmd launchers and rejects tampered ones', () => {
    const parsed = parseT3CmdLauncher('mock.cmd', () => VALID_CMD_LINES.join('\r\n'));
    expect(parsed).toEqual({
      executable: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe',
      baseArgs: ['C:\\Users\\Alice\\AppData\\Local\\Programs\\t3code\\resources\\server.asar\\apps\\server\\dist\\bin.mjs'],
      envOverrides: {
        ELECTRON_RUN_AS_NODE: '1',
        T3CODE_DESKTOP_CLI_LAUNCHER: '1',
        T3CODE_CLI_PATH: 'C:\\Users\\Alice\\.t3\\bin\\t3.cmd',
        T3CODE_HOME: 'C:\\Users\\Alice\\.t3',
      },
    });

    expect(() => parseT3CmdLauncher('mock.cmd', () => 'x'.repeat(70_000))).toThrow('过大');
    expect(() => parseT3CmdLauncher('mock.cmd', () => '@echo off\nexit /b 0')).toThrow('未识别');

    const badEcho = [...VALID_CMD_LINES];
    badEcho[8] = 'powershell -Command calc.exe';
    expect(() => parseT3CmdLauncher('mock.cmd', () => badEcho.join('\n'))).toThrow('执行模板');

    const mismatched = [...VALID_CMD_LINES];
    mismatched[11] = '"C:\\Other\\t3.exe" "C:\\Other\\bin.mjs" %*';
    expect(() => parseT3CmdLauncher('mock.cmd', () => mismatched.join('\n'))).toThrow('不一致');

    const unsafeChar = [...VALID_CMD_LINES];
    unsafeChar[4] = 'if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\%BAD%\\.t3"';
    expect(() => parseT3CmdLauncher('mock.cmd', () => unsafeChar.join('\n'))).toThrow('非法字符');
  });

  it('resolves T3CODE_HOME from env, validated .cmd launcher, or default home directory', () => {
    expect(resolveT3Home(undefined, { env: { T3CODE_HOME: 'D:\\t3-home' } })).toBe('D:\\t3-home');
    expect(resolveT3Home('C:\\Users\\Alice\\.t3\\bin\\t3.cmd', {
      env: {},
      existsFn: () => true,
      readFileFn: () => VALID_CMD_LINES.join('\n'),
    })).toBe('C:\\Users\\Alice\\.t3');
    expect(resolveT3Home('C:\\bad.cmd', {
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: () => true,
      readFileFn: () => 'corrupt',
    })).toBe('C:\\Users\\Alice\\.t3');
  });

  it('discovers local protocol v2 server and enforces PID liveness, JSON validity, and version checks', async () => {
    const runtimePath = 'C:\\Users\\Alice\\.t3\\userdata\\server-runtime.json';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      environmentId: 'env-1',
      serverVersion: '0.1.13',
      orchestrationProtocolVersion: 2,
      capabilities: { threadStop: true },
    }), { status: 200 }));

    const server = await discoverLocalServer({}, {
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: p => p === runtimePath,
      readFileFn: () => JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:3773', serverVersion: '0.1.13' }),
      isAliveFn: () => true,
      fetcher,
    });
    expect(server).toEqual({
      origin: 'http://127.0.0.1:3773',
      environmentId: 'env-1',
      serverVersion: '0.1.13',
      orchestrationProtocolVersion: 2,
      capabilities: { threadStop: true },
    });

    await expect(discoverLocalServer({}, {
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: p => p === runtimePath,
      readFileFn: () => '{bad-json',
    })).rejects.toThrow('损坏');

    await expect(discoverLocalServer({}, {
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: p => p === runtimePath,
      readFileFn: () => JSON.stringify({ pid: 999999, origin: 'http://127.0.0.1:3773' }),
      isAliveFn: () => false,
    })).rejects.toThrow('过期');

    const v1Fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      environmentId: 'env-1',
      serverVersion: '0.1.0',
      orchestrationProtocolVersion: 1,
    }), { status: 200 }));
    await expect(discoverLocalServer({ serverUrl: 'http://127.0.0.1:3773' }, { fetcher: v1Fetcher }))
      .rejects.toThrow('协议 v2');

    const mismatchFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      environmentId: 'env-1',
      serverVersion: '0.9.9',
      orchestrationProtocolVersion: 2,
    }), { status: 200 }));
    await expect(discoverLocalServer({}, {
      homeDir: 'C:\\Users\\Alice',
      env: {},
      existsFn: p => p === runtimePath,
      readFileFn: () => JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:3773', serverVersion: '0.1.13' }),
      isAliveFn: () => true,
      fetcher: mismatchFetcher,
    })).rejects.toThrow('版本与运行时文件不匹配');

    // Non-200 HTTP and network errors + .cmd header/mode-flag/exit-line tampering
    await expect(discoverLocalServer({ serverUrl: 'http://127.0.0.1:3773' }, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
    })).rejects.toThrow('HTTP 503');
    await expect(discoverLocalServer({ serverUrl: 'http://127.0.0.1:3773' }, {
      fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')),
    })).rejects.toThrow('无法探测');

    const badHeader = [...VALID_CMD_LINES];
    badHeader[1] = 'rem untrusted launcher';
    expect(() => parseT3CmdLauncher('mock.cmd', () => badHeader.join('\n'))).toThrow('头部校验');
    const badModeFlag = [...VALID_CMD_LINES];
    badModeFlag[5] = 'set "OTHER=1"';
    expect(() => parseT3CmdLauncher('mock.cmd', () => badModeFlag.join('\n'))).toThrow('运行模式标志');
    const badExit = [...VALID_CMD_LINES];
    badExit[13] = 'exit /b 0';
    expect(() => parseT3CmdLauncher('mock.cmd', () => badExit.join('\n'))).toThrow('执行模板');
  });
});
