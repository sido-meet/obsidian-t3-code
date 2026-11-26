import { record } from './rpc';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming: boolean;
}

const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

export class Transcript {
  private readonly rows = new Map<string, Message>();
  private readonly runs = new Map<string, { id: string; userMessageId: string; status: string }>();
  private readonly messageRuns = new Map<string, string>();

  get messages(): Message[] { return [...this.rows.values()]; }
  get activeRun() { return [...this.runs.values()].reverse().find(run => activeStatuses.has(run.status)); }

  hasRunFor(messageId: string): boolean {
    return [...this.runs.values()].some(run => run.userMessageId === messageId);
  }

  private message(value: unknown, item = false): void {
    const row = record(value);
    const id = item ? row.messageId : row.id;
    const role = item ? 'assistant' : row.role;
    if (typeof id !== 'string' || (role !== 'user' && role !== 'assistant') || typeof row.text !== 'string') return;
    if (typeof row.runId === 'string') this.messageRuns.set(id, row.runId);
    const run = typeof row.runId === 'string' ? this.runs.get(row.runId) : undefined;
    const streaming = item ? !run || activeStatuses.has(run.status) : row.streaming === true;
    const existing = this.rows.get(id);
    if (item && existing && !existing.streaming && streaming) return;
    this.rows.set(id, { id, role, text: row.text, streaming });
  }

  private run(value: unknown): void {
    const run = record(value);
    if (typeof run.id !== 'string' || typeof run.userMessageId !== 'string' || typeof run.status !== 'string') return;
    this.runs.set(run.id, { id: run.id, userMessageId: run.userMessageId, status: run.status });
    if (!activeStatuses.has(run.status)) {
      for (const [id, row] of this.rows) {
        if (this.messageRuns.get(id) === run.id && row.streaming) this.rows.set(id, { ...row, streaming: false });
      }
    }
  }

  receive(value: unknown): void {
    const item = record(value);
    if (item.kind === 'snapshot') {
      const projection = record(item.projection);
      this.rows.clear();
      this.runs.clear();
      this.messageRuns.clear();
      if (Array.isArray(projection.runs)) for (const run of projection.runs) this.run(run);
      if (Array.isArray(projection.messages)) for (const row of projection.messages) this.message(row);
    }
    if (item.kind === 'event') {
      const event = record(item.event);
      if (event.type === 'message.updated') this.message(event.payload);
      if (event.type === 'turn-item.updated' && record(event.payload).type === 'assistant_message') {
        this.message(event.payload, true);
      }
      if (event.type === 'run.created' || event.type === 'run.updated') this.run(event.payload);
    }
  }
}
