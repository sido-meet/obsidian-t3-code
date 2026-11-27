export interface Settings {
  origin: string;
  includeNote: boolean;
}

export const DEFAULT_ORIGIN = 'http://127.0.0.1:3425';

export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入本地 T3 服务地址，例如 http://127.0.0.1:3425。');
  }
  return url.origin;
}

export function normalizeSettings(value: unknown): Settings {
  const saved = value as Partial<Settings> | null | undefined;
  let origin = DEFAULT_ORIGIN;
  if (typeof saved?.origin === 'string') {
    try { origin = loopbackOrigin(saved.origin); } catch { /* Keep the local default. */ }
  }
  return { origin, includeNote: saved?.includeNote === true };
}
