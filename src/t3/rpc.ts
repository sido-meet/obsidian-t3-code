type WireObject = Record<string, unknown>;

export function record(value: unknown): WireObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as WireObject : {};
}

/** Redacts bearer tokens, DPoP tokens, WS tickets, and auth URL/JSON parameters from errors and diagnostics. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(Bearer|DPoP)\s+[^\s"'`<>?&]+/gi, '$1 [REDACTED]')
    .replace(/([?&]|\b)((?:wsTicket|ticket|token|access_token|subject_token|refresh_token|pairingCode|code|secret)=)[^&\s#"']+/gi, '$1$2[REDACTED]')
    .replace(/("(?:token|access_token|subject_token|wsTicket|ticket|secret|pairingCode|refresh_token)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(\\"(?:token|access_token|subject_token|wsTicket|ticket|secret|pairingCode|refresh_token)\\"\s*:\s*\\")[^"\\]+(\\")/gi, '$1[REDACTED]$2');
}

function extractFailureMessage(exit: WireObject): string {
  const causeObj = record(exit.cause);
  const nodes = Array.isArray(exit.cause)
    ? exit.cause
    : Array.isArray(causeObj.reasons) ? causeObj.reasons : [exit.cause];
  for (const item of nodes) {
    const node = record(item);
    const err = record(node.error);
    const raw = node._tag === 'Fail' ? (err.detail ?? err.message) : undefined;
    if (typeof raw === 'string' && raw) return redactSensitiveText(raw);
  }
  return 'T3 拒绝了请求。请检查项目、Codex 配置和配对权限。';
}

interface RpcSocket extends EventTarget {
  send(data: string): void;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  chunk?: (value: unknown) => void;
}

export class T3Rpc {
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private stop?: () => void;
  private pongDeadline?: ReturnType<typeof setTimeout>;
  readonly disconnected: Promise<void>;

  constructor(private readonly socket: RpcSocket) {
    this.disconnected = new Promise(resolve => {
      const heartbeat = setInterval(() => {
        try {
          this.send({ _tag: 'Ping' });
          this.pongDeadline = setTimeout(() => this.close(), 10000);
        } catch { this.close(); }
      }, 15000);
      const stop = () => {
        clearInterval(heartbeat);
        clearTimeout(this.pongDeadline);
        if (this.closed) return;
        this.closed = true;
        for (const call of this.pending.values()) call.reject(new Error('T3 连接已中断。'));
        this.pending.clear();
        resolve();
      };
      this.stop = stop;
      socket.addEventListener('close', stop);
      socket.addEventListener('error', () => { stop(); socket.close(); });
    });
    socket.addEventListener('message', (event: Event) => {
      try {
        if (!(event instanceof MessageEvent) || typeof event.data !== 'string') throw new Error();
        const decoded: unknown = JSON.parse(event.data);
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) this.receive(record(frame));
      } catch {
        this.close();
      }
    });
  }

  private send(frame: WireObject): void {
    this.socket.send(JSON.stringify(frame));
  }

  private receive(frame: WireObject): void {
    if (frame._tag === 'Pong') clearTimeout(this.pongDeadline);
    if (frame._tag === 'Ping') this.send({ _tag: 'Pong' });
    if (frame._tag === 'Defect') throw new Error();
    const requestId = String(frame.requestId);
    const call = this.pending.get(requestId);
    if (!call) return;
    if (frame._tag === 'Chunk') {
      if (!Array.isArray(frame.values)) throw new Error();
      for (const value of frame.values) call.chunk?.(value);
      this.send({ _tag: 'Ack', requestId });
    }
    if (frame._tag === 'Exit') {
      this.pending.delete(requestId);
      const exit = record(frame.exit);
      if (exit._tag === 'Success') call.resolve(exit.value);
      else call.reject(new Error(extractFailureMessage(exit)));
    }
  }

  request(tag: string, payload: unknown, chunk?: Pending['chunk']): {
    result: Promise<unknown>; cancel: () => void;
  } {
    const id = String(++this.nextId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      call.reject(new Error('T3 请求已取消或超时。'));
      try { this.send({ _tag: 'Interrupt', requestId: id }); } catch { this.close(); }
    };
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('T3 连接已中断。'));
        return;
      }
      this.pending.set(id, { resolve, reject, chunk });
      try {
        this.send({ _tag: 'Request', id, tag, payload, headers: [] });
      } catch {
        this.pending.delete(id);
        reject(new Error('无法发送 T3 请求。'));
        return;
      }
      if (!chunk) timer = setTimeout(cancel, 15000);
    }).finally(() => clearTimeout(timer));
    return { result, cancel };
  }

  subscribe(tag: string, payload: unknown, onChunk: (value: unknown) => void): {
    result: Promise<unknown>; unsubscribe: () => void;
  } {
    const { result, cancel } = this.request(tag, payload, onChunk);
    return { result, unsubscribe: cancel };
  }

  close(): void {
    if (this.closed) return;
    this.stop?.();
    this.socket.close();
  }
}
