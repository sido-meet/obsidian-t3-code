import { record, T3Rpc } from './rpc';

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入本地 T3 服务地址，例如 http://127.0.0.1:3425。');
  }
  return url.origin;
}

export interface T3Project {
  id: string;
  title: string;
  root: string;
  model?: string;
}

export class T3Connection {
  private readonly origin: string;
  private credential?: { environment: string; token: string };

  constructor(origin: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    this.origin = loopbackOrigin(origin);
  }

  private async json(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set('x-t3-orchestration-protocol', '2');
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        ...options, headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error('无法连接本地 T3 服务。请确认服务已启动。');
    }
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? 'T3 配对无效或权限不足，请重新配对。' : '本地 T3 服务拒绝了请求。');
    }
    return record(await response.json());
  }

  private async discover(): Promise<string> {
    const descriptor = await this.json('/.well-known/t3/environment');
    if (descriptor.orchestrationProtocolVersion !== 2 || typeof descriptor.environmentId !== 'string') {
      throw new Error('本地服务需要支持 T3 Orchestrator v2。');
    }
    return descriptor.environmentId;
  }

  async pair(code: string): Promise<void> {
    const environment = await this.discover();
    const reply = await this.json('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: code.trim(),
        subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'orchestration:read orchestration:operate',
        client_label: 'T3-Codian',
      }),
    });
    if (reply.token_type !== 'Bearer' || typeof reply.access_token !== 'string' || !reply.access_token) {
      throw new Error('T3 未返回可用的配对凭据。');
    }
    this.credential = { environment, token: reply.access_token };
  }

  private async authorized(path: string, options: RequestInit = {}) {
    const credential = this.credential;
    if (!credential || await this.discover() !== credential.environment) {
      throw new Error('本地 T3 环境已变化，请重新配对。');
    }
    const headers = new Headers(options.headers);
    headers.set('Authorization', 'Bearer ' + credential.token);
    return this.json(path, { ...options, headers });
  }

  async socketUrl(): Promise<URL> {
    const reply = await this.authorized('/api/auth/websocket-ticket', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (typeof reply.ticket !== 'string' || !reply.ticket) throw new Error('T3 未签发连接票据。');
    const url = new URL('/ws', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('wsTicket', reply.ticket);
    url.searchParams.set('orchestrationProtocol', '2');
    return url;
  }

  async projects(): Promise<T3Project[]> {
    const reply = await this.authorized('/api/orchestration/shell');
    if (!Array.isArray(reply.projects)) throw new Error('T3 未返回项目列表。');
    return reply.projects.flatMap(value => {
      const project = record(value);
      const model = record(project.defaultModelSelection);
      if (typeof project.id !== 'string' || typeof project.title !== 'string' || typeof project.workspaceRoot !== 'string' || project.archivedAt) return [];
      return [{
        id: project.id, title: project.title, root: project.workspaceRoot,
        model: model.instanceId === 'codex' && typeof model.model === 'string' ? model.model : undefined,
      }];
    });
  }

  async open(): Promise<T3Rpc> {
    const socket = new WebSocket(await this.socketUrl());
    const rpc = new T3Rpc(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => rpc.close(), 8000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      void rpc.disconnected.then(() => {
        clearTimeout(timer);
        reject(new Error('T3 WebSocket 未连接或连接已中断。'));
      });
    });
    return rpc;
  }
}
