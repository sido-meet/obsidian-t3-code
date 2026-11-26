import type { T3Project } from './connection';
import type { T3Rpc } from './rpc';
import { record } from './rpc';
import { Transcript } from './transcript';

const created = { createdBy: 'user', creationSource: 'web' };
const commandId = () => crypto.randomUUID();

function messageCommand(threadId: string, text: string, messageId: string) {
  return {
    ...created, type: 'message.dispatch', commandId: commandId(), threadId, messageId,
    text, attachments: [], deliveryIntent: 'auto', dispatchMode: { type: 'start_immediately' },
  };
}

export function initialCommands(threadId: string, project: T3Project, text: string, messageId: string) {
  return [{
    ...created, type: 'thread.create', commandId: commandId(), threadId, projectId: project.id,
    title: text.split('\n')[0].slice(0, 80).trim() || 'Obsidian 对话',
    modelSelection: { instanceId: 'codex', model: project.model ?? 'gpt-6-astra' },
    runtimeMode: 'approval-required', interactionMode: 'default', branch: null, worktreePath: null,
  }, messageCommand(threadId, text, messageId)] as const;
}

export function interruptCommand(threadId: string, runId: string) {
  return { type: 'run.interrupt', commandId: commandId(), threadId, runId, holdQueue: true };
}

export class ChatSession {
  transcript = new Transcript();
  threadId?: string;
  projectId?: string;
  private pendingMessage?: string;
  private rpc?: T3Rpc;
  private stopWatching?: () => void;
  private sending = false;
  private ready = true;

  constructor(private readonly changed: () => void, private readonly report: (message: string) => void) {}

  get busy(): boolean {
    return this.sending || !this.ready || this.pendingMessage !== undefined || this.transcript.activeRun !== undefined;
  }

  attach(rpc: T3Rpc): void {
    this.stopWatching?.();
    this.rpc = rpc;
    if (this.threadId) this.watch(this.threadId, true);
  }

  reset(): void {
    if (this.sending) return;
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.threadId = undefined;
    this.projectId = undefined;
    this.pendingMessage = undefined;
    this.ready = true;
    this.transcript = new Transcript();
    this.changed();
  }

  private watch(threadId: string, recovering = false): void {
    const rpc = this.rpc;
    if (!rpc) return;
    this.ready = false;
    const stream = rpc.request('orchestration.subscribeThread', { threadId }, item => {
      this.transcript.receive(item);
      const entry = record(item);
      if (entry.kind === 'snapshot') {
        this.ready = true;
        if (recovering && !this.sending) this.pendingMessage = undefined;
      }
      if (this.pendingMessage && this.transcript.hasRunFor(this.pendingMessage)) this.pendingMessage = undefined;
      const event = record(entry.event);
      const payload = record(event.payload);
      if (event.type === 'run.updated' && payload.status === 'failed') {
        this.report('Codex 执行失败。请在 T3 Code 中查看该会话的错误详情。');
      }
      if (event.type === 'runtime-request.updated' && payload.status === 'pending') {
        this.report('Codex 正在等待操作，请在 T3 Code 中处理。');
      }
      this.changed();
    });
    const cancel = stream.cancel;
    this.stopWatching = cancel;
    void stream.result.then(() => {
      if (this.stopWatching === cancel) rpc.close();
    }, () => {
      if (this.stopWatching === cancel) rpc.close();
    });
  }

  async send(project: T3Project, text: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.busy) throw new Error('当前会话无法发送消息。');
    this.sending = true;
    const messageId = crypto.randomUUID();
    const threadId = this.threadId ?? crypto.randomUUID();
    this.changed();
    try {
      let dispatch = messageCommand(threadId, text, messageId);
      if (!this.threadId) {
        const [create, first] = initialCommands(threadId, project, text, messageId);
        await rpc.request('orchestration.dispatchCommand', create).result;
        this.threadId = threadId;
        this.projectId = project.id;
        this.watch(threadId);
        dispatch = first;
      }
      this.pendingMessage = messageId;
      await rpc.request('orchestration.dispatchCommand', dispatch).result;
    } catch (error) {
      this.pendingMessage = undefined;
      throw error;
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  async stop(): Promise<void> {
    const run = this.transcript.activeRun;
    if (this.rpc && this.threadId && run) {
      await this.rpc.request('orchestration.dispatchCommand', interruptCommand(this.threadId, run.id)).result;
    }
  }
}
