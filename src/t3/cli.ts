import { execFile, spawn } from 'node:child_process';
import { win32 } from 'node:path';
import type { Message } from './transcript';
import { record } from './rpc';

type RunCli = (args: string[], stdin?: string) => Promise<unknown>;

export function cliInvocation(executable: string, args: string[], platform = process.platform,
                              commandProcessor = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { executable, args, verbatim: false };
  }
  if (!win32.isAbsolute(executable) || [executable, ...args].some(arg => /["%&|<>^!\r\n]/.test(arg))) {
    throw new Error('T3 CLI 路径或参数包含 Windows 批处理不支持的字符。');
  }
  const quoted = [executable, ...args].map(arg => '"' + arg + '"').join(' ');
  return {
    executable: commandProcessor,
    args: ['/d', '/v:off', '/s', '/c', '"' + quoted + '"'],
    verbatim: true,
  };
}

export function cliRunner(executable: string, signal: AbortSignal, baseDir?: string): RunCli {
  return (args, stdin) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('T3 CLI 请求已取消。'));
      return;
    }
    const command = cliInvocation(executable, baseDir ? [...args, '--base-dir', baseDir] : args);
    const child = spawn(command.executable, command.args, {
      windowsHide: true, windowsVerbatimArguments: command.verbatim,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stop = (message: string) => {
      cleanup();
      const pid = child.pid;
      if (process.platform === 'win32' && pid && child.exitCode === null) {
        const taskkill = win32.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
          if (error && child.exitCode === null) child.kill();
        });
      } else child.kill();
      child.stdout.destroy();
      child.stdin.destroy();
      reject(new Error(message));
    };
    const cancel = () => stop('T3 CLI 请求已取消。');
    const timeout = setTimeout(() => stop('T3 CLI 响应超时。请在 T3 Code 中核对任务状态后重试。'), 20000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      output += text;
      if (output.length > 4_000_000) stop('T3 CLI 返回的内容过大。');
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '', 'utf8');
    child.once('error', () => {
      cleanup();
      reject(new Error('无法运行 T3 CLI，请检查插件设置中的 CLI 路径。'));
    });
    child.once('close', code => {
      cleanup();
      if (code !== 0) {
        reject(new Error('T3 CLI 请求失败。请确认 T3 Code 正在运行、项目已注册，再在 T3 Code 中核对任务状态。'));
        return;
      }
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error('T3 CLI 返回的内容无法解析。请确认 CLI 与本地 T3 Code 的版本兼容。')); }
    });
  });
}
export interface ModelSelection {
  provider: string;
  model: string;
  option?: string;
}

export interface CliThread {
  threadId: string;
  title: string;
  projectId?: string;
  status: string;
  providerInstanceId?: string;
  model?: string;
  runtimeMode?: string;
  interactionMode?: string;
  link?: string;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readThread(value: unknown, fallbackId?: string): CliThread | undefined {
  const thread = record(value);
  const threadId = optionalText(thread.threadId) ?? fallbackId;
  if (!threadId || typeof thread.status !== 'string') return;
  return {
    threadId,
    title: optionalText(thread.title) ?? '未命名会话',
    status: thread.status,
    projectId: optionalText(thread.projectId),
    providerInstanceId: optionalText(thread.providerInstanceId),
    model: optionalText(thread.model),
    runtimeMode: optionalText(thread.runtimeMode),
    interactionMode: optionalText(thread.interactionMode),
    link: optionalText(thread.link),
  };
}

export class CliChat {
  threadId?: string;

  constructor(private readonly run: RunCli, private readonly selection?: ModelSelection) {}

  async list(project: string): Promise<CliThread[]> {
    const threads = await this.run(['thread', 'list', '--json', '--project', project]);
    if (!Array.isArray(threads)) throw new Error('T3 CLI 未返回项目会话列表。');
    return threads.flatMap(value => {
      const thread = readThread(value);
      return thread ? [thread] : [];
    });
  }

  async check(project: string): Promise<void> { await this.list(project); }

  async send(project: string, text: string, selection = this.selection): Promise<string | undefined> {
    const modelArgs = selection ? ['--provider', selection.provider, '--model', selection.model] : [];
    if (selection?.option) modelArgs.push('--option', selection.option);
    const args = this.threadId
      ? ['thread', 'send', '--json', this.threadId, '-']
      : ['thread', 'start', '--json', ...modelArgs, project, '-'];
    const result = record(await this.run(args, text));
    if (!this.threadId) {
      this.threadId = optionalText(result.threadId);
      if (!this.threadId) throw new Error('T3 CLI 未返回会话 ID。');
    }
    return optionalText(result.runId);
  }

  async read(): Promise<{ status: string; thread: CliThread; messages: Message[]; latestRunId?: string; runIds: string[] } | undefined> {
    const threadId = this.threadId;
    if (!threadId) return;
    const value = record(await this.run(['thread', 'show', '--json', '--messages', '50', threadId]));
    const thread = readThread(value.thread, threadId);
    if (!thread || thread.threadId !== threadId || !Array.isArray(value.messages)) {
      throw new Error('T3 CLI 未返回会话状态。');
    }
    const runIds = new Set<string>();
    const messages = value.messages.flatMap((value, index): Message[] => {
      const row = record(value);
      if (typeof row.runId === 'string') runIds.add(row.runId);
      if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') return [];
      return [{ id: String(index), role: row.role, text: row.text, streaming: false }];
    });
    return { status: thread.status, thread, messages, latestRunId: optionalText(record(value.thread).latestRunId), runIds: [...runIds] };
  }
}
