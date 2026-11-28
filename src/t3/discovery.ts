import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { record } from './rpc';

const LAUNCHER_MAX_BYTES = 64 * 1024;
const UNSAFE_LAUNCHER_CHARS = /["%<>|?*\r\n]/;

export interface ParsedCmdLauncher {
  executable: string;
  baseArgs: string[];
  envOverrides: Record<string, string>;
}

export interface DiscoveredServer {
  origin: string;
  environmentId: string;
  serverVersion: string;
  orchestrationProtocolVersion: number;
  capabilities: Record<string, unknown>;
}

export interface DiscoveryDeps {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  existsFn?: (path: string) => boolean;
  readFileFn?: (path: string) => string;
  isAliveFn?: (pid: number) => boolean;
  fetcher?: typeof fetch;
}

/** Validates that a T3 Server URL is strictly local loopback with no credentials, path, query, or fragment. */
export function validateLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('仅允许连接本机回环地址（127.0.0.1 / localhost / [::1]）的 T3 Code 服务。');
  }
  return url.origin;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Discovers the local `t3` CLI binary across configured path, official T3 directories, and PATH. */
export function discoverCliPath(configuredPath?: string, deps: DiscoveryDeps = {}): string {
  const trimmed = configuredPath?.trim();
  const exists = deps.existsFn ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const pathJoin = platform === 'win32' ? win32.join : posix.join;
  const home = deps.homeDir ?? homedir();
  const env = deps.env ?? process.env;

  if (trimmed && trimmed !== 't3') {
    return trimmed;
  }

  const candidates = platform === 'win32'
    ? [
        pathJoin(home, '.t3', 'bin', 't3.cmd'),
        pathJoin(home, '.t3', 'bin', 't3.exe'),
        ...(env.LOCALAPPDATA
          ? [
              pathJoin(env.LOCALAPPDATA, 'Programs', 't3-code-desktop', 'resources', 't3.exe'),
            ]
          : []),
      ]
    : [
        pathJoin(home, '.local', 'bin', 't3'),
        '/usr/local/bin/t3',
        '/opt/homebrew/bin/t3',
      ];

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const pathVar = env.PATH ?? env.Path ?? '';
  const pathNames = platform === 'win32' ? ['t3.cmd', 't3.exe'] : ['t3'];
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const file of pathNames) {
      const full = pathJoin(dir, file);
      if (exists(full)) return full;
    }
  }

  return 't3';
}

function unquoteExact(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    throw new Error('T3 CLI 启动器格式无效。');
  }
  const inner = raw.slice(1, -1);
  if (!win32.isAbsolute(inner) || UNSAFE_LAUNCHER_CHARS.test(inner)) {
    throw new Error('T3 CLI 启动器包含非法的绝对路径或受限字符。');
  }
  return inner;
}

/**
 * Strictly parses the 14-line T3-generated Windows `.cmd` launcher so Electron/Node can be invoked
 * directly with `shell: false` instead of interpolating batch commands through `cmd.exe`.
 */
export function parseT3CmdLauncher(cmdPath: string, readFileFn: (p: string) => string = p => readFileSync(p, 'utf8')): ParsedCmdLauncher {
  const raw = readFileFn(cmdPath);
  if (raw.length > LAUNCHER_MAX_BYTES) {
    throw new Error('T3 CLI 启动器文件过大。');
  }
  const lines = raw.split(/\r?\n/).map(line => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== 14) {
    throw new Error('未识别的 T3 .cmd 启动器结构，拒绝以 Shell 执行。');
  }

  const header0 = lines[0].toLowerCase() === '@echo off';
  const header1 = lines[1].toLowerCase() === "rem written by t3 code: runs the desktop app's bundled t3 cli.";
  const header2 = lines[2].toLowerCase() === 'setlocal enableextensions disabledelayedexpansion';
  if (!header0 || !header1 || !header2) {
    throw new Error('未通过 T3 .cmd 启动器头部校验。');
  }

  const cliMatch = lines[3].match(/^set "T3CODE_CLI_PATH=(.+)"$/i);
  const homeMatch = lines[4].match(/^if not defined T3CODE_HOME set "T3CODE_HOME=(.+)"$/i);
  if (!cliMatch || !homeMatch) {
    throw new Error('T3 .cmd 环境变量定义无效。');
  }
  if (
    lines[5].toLowerCase() !== 'set "electron_run_as_node=1"'
    || lines[6].toLowerCase() !== 'set "t3code_desktop_cli_launcher=1"'
  ) {
    throw new Error('T3 .cmd 运行模式标志校验失败。');
  }

  const ifMatch = lines[7].match(/^if exist ("[^"]+") goto run$/i);
  const runLine = lines[11].match(/^("[^"]+") ("[^"]+") %\*\s*$/);
  if (
    !ifMatch
    || !lines[8].toLowerCase().startsWith('echo ')
    || !lines[9].toLowerCase().startsWith('exit /b ')
    || lines[10].toLowerCase() !== ':run'
    || !runLine
    || lines[12].toLowerCase() !== 'set "t3_exit=%errorlevel%"'
    || lines[13].toLowerCase() !== 'exit /b %t3_exit%'
  ) {
    throw new Error('T3 .cmd 执行模板校验失败。');
  }

  const existExe = unquoteExact(ifMatch[1]);
  const executable = unquoteExact(runLine[1]);
  const entryScript = unquoteExact(runLine[2]);
  if (existExe.toLowerCase() !== executable.toLowerCase()) {
    throw new Error('T3 .cmd 可执行路径不一致。');
  }

  const cliEnvPath = cliMatch[1];
  const homeDir = homeMatch[1];
  if (
    !win32.isAbsolute(cliEnvPath)
    || !win32.isAbsolute(homeDir)
    || UNSAFE_LAUNCHER_CHARS.test(cliEnvPath)
    || UNSAFE_LAUNCHER_CHARS.test(homeDir)
  ) {
    throw new Error('T3 .cmd 环境路径包含非法字符。');
  }

  return {
    executable,
    baseArgs: [entryScript],
    envOverrides: {
      ELECTRON_RUN_AS_NODE: '1',
      T3CODE_DESKTOP_CLI_LAUNCHER: '1',
      T3CODE_CLI_PATH: cliEnvPath,
      T3CODE_HOME: homeDir,
    },
  };
}

export function resolveT3Home(cliPath: string | undefined, deps: DiscoveryDeps = {}): string {
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const exists = deps.existsFn ?? existsSync;
  const readFn = deps.readFileFn ?? (p => readFileSync(p, 'utf8'));

  if (env.T3CODE_HOME && isAbsolute(env.T3CODE_HOME)) {
    return env.T3CODE_HOME;
  }
  if (cliPath && /\.cmd$/i.test(cliPath) && exists(cliPath)) {
    try {
      const parsed = parseT3CmdLauncher(cliPath, readFn);
      if (parsed.envOverrides.T3CODE_HOME) return parsed.envOverrides.T3CODE_HOME;
    } catch {
      // Fall back to standard ~/.t3 directory when launcher format differs
    }
  }
  return join(home, '.t3');
}

/**
 * Discovers a running local T3 Code server from `serverUrl` or `<T3CODE_HOME>/userdata/server-runtime.json`,
 * verifies process liveness & loopback origin, and checks `/.well-known/t3/environment` protocol v2 identity.
 */
export async function discoverLocalServer(
  options: { serverUrl?: string; cliPath?: string; timeoutMs?: number } = {},
  deps: DiscoveryDeps = {},
): Promise<DiscoveredServer> {
  const exists = deps.existsFn ?? existsSync;
  const readFn = deps.readFileFn ?? (p => readFileSync(p, 'utf8'));
  const isAlive = deps.isAliveFn ?? isProcessAlive;
  const fetcher = deps.fetcher ?? ((input: URL | string, init?: RequestInit) => globalThis.fetch(input, init));

  let origin: string;
  let expectedServerVersion: string | undefined;

  if (options.serverUrl?.trim()) {
    origin = validateLoopbackOrigin(options.serverUrl.trim());
  } else {
    const t3Home = resolveT3Home(options.cliPath, deps);
    const candidates = [
      join(t3Home, 'userdata', 'server-runtime.json'),
      join(t3Home, 'userdata', 'dev', 'server-runtime.json'),
    ];
    const runtimePath = candidates.find(candidate => exists(candidate));
    if (!runtimePath) {
      throw new Error('未发现本机运行中的 T3 Code 服务（缺少 server-runtime.json）。');
    }
    let runtime: Record<string, unknown>;
    try {
      runtime = record(JSON.parse(readFn(runtimePath)));
    } catch {
      throw new Error('server-runtime.json 格式损坏。');
    }
    if (typeof runtime.pid !== 'number' || !isAlive(runtime.pid)) {
      throw new Error('本机 T3 Code 服务进程未运行（server-runtime.json 已过期）。');
    }
    if (typeof runtime.origin !== 'string' || !runtime.origin) {
      throw new Error('server-runtime.json 缺少合法的 origin 字段。');
    }
    origin = validateLoopbackOrigin(runtime.origin);
    if (typeof runtime.serverVersion === 'string') {
      expectedServerVersion = runtime.serverVersion;
    }
  }

  let response: Response;
  try {
    response = await fetcher(new URL('/.well-known/t3/environment', origin), {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 2500),
    });
  } catch {
    throw new Error('无法探测本地 T3 Code 服务（/.well-known/t3/environment）。');
  }

  if (!response.ok) {
    throw new Error(`本地 T3 Code 服务探测失败（HTTP ${response.status}）。`);
  }

  const descriptor = record(await response.json());
  if (
    descriptor.orchestrationProtocolVersion !== 2
    || typeof descriptor.environmentId !== 'string'
    || !descriptor.environmentId
    || typeof descriptor.serverVersion !== 'string'
  ) {
    throw new Error('本地 T3 Code 服务不支持 Orchestrator 协议 v2。');
  }
  if (expectedServerVersion && descriptor.serverVersion !== expectedServerVersion) {
    throw new Error('本地 T3 Code 服务版本与运行时文件不匹配，拒绝连接。');
  }

  return {
    origin,
    environmentId: descriptor.environmentId,
    serverVersion: descriptor.serverVersion,
    orchestrationProtocolVersion: 2,
    capabilities: record(descriptor.capabilities),
  };
}
