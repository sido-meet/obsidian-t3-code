import { expect, it, vi } from 'vitest';
import { T3Connection } from '../src/t3/connection';

it('requests only orchestration scopes and obtains an authenticated socket ticket', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ environmentId: 'env', orchestrationProtocolVersion: 2 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'fixture', token_type: 'Bearer' }))
    .mockResolvedValueOnce(Response.json({ environmentId: 'env', orchestrationProtocolVersion: 2 }))
    .mockResolvedValueOnce(Response.json({ ticket: 'one-time' }));
  const connection = new T3Connection('http://127.0.0.1:3425', fetcher);
  await connection.pair('code');
  const url = await connection.socketUrl();
  expect(url.href).toBe('ws://127.0.0.1:3425/ws?wsTicket=one-time&orchestrationProtocol=2');
  const body = fetcher.mock.calls[1][1]?.body as URLSearchParams;
  expect(body.get('scope')).toBe('orchestration:read orchestration:operate');
  expect(new Headers(fetcher.mock.calls[3][1]?.headers).get('authorization')).toBe('Bearer fixture');
});

it('withholds the credential if the local port now serves another environment', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ environmentId: 'env', orchestrationProtocolVersion: 2 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'fixture', token_type: 'Bearer' }))
    .mockResolvedValueOnce(Response.json({ environmentId: 'other', orchestrationProtocolVersion: 2 }));
  const connection = new T3Connection('http://127.0.0.1:3425', fetcher);
  await connection.pair('code');
  await expect(connection.socketUrl()).rejects.toThrow('重新配对');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('calls the browser fetch through its original receiver', async () => {
  const validReceivers: boolean[] = [];
  vi.stubGlobal('fetch', function (this: unknown, input: URL | string) {
    validReceivers.push(this === globalThis);
    return Promise.resolve(new URL(input).pathname === '/.well-known/t3/environment'
      ? Response.json({ environmentId: 'env', orchestrationProtocolVersion: 2 })
      : Response.json({ access_token: 'fixture', token_type: 'Bearer' }));
  });
  try {
    const connection = new T3Connection('http://127.0.0.1:3425');
    await connection.pair('code');
    expect(validReceivers).toEqual([true, true]);
  } finally { vi.unstubAllGlobals(); }
});
