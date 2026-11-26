import { expect, it } from 'vitest';
import { CliChat, cliInvocation, cliRunner } from '../src/t3/cli';

it('sends note text only through stdin and reuses the returned thread ID', async () => {
  const calls: unknown[] = [];
  const chat = new CliChat(async (args, stdin) => {
    calls.push([args, stdin]);
    if (args[1] === 'start') return { threadId: 'thread-one' };
    return {};
  });
  await chat.send('D:/Work/project', '中文和 % ! & |');
  await chat.send('D:/Work/project', '继续');
  expect(calls).toEqual([
    [['thread', 'start', '--json', 'D:/Work/project', '-'], '中文和 % ! & |'],
    [['thread', 'send', '--json', 'thread-one', '-'], '继续'],
  ]);
});

it('maps a thread snapshot to chat rows and the current state', async () => {
  const chat = new CliChat(async args => args[1] === 'start' ? { threadId: 'one' } : {
    thread: { status: 'running' },
    messages: [{ role: 'user', text: '第一条' }, { role: 'assistant', text: '答复' }],
  });
  await chat.send('D:/Work/project', '第一条');
  const snapshot = await chat.read();
  expect(snapshot?.status).toBe('running');
  expect(snapshot?.messages.map(item => [item.role, item.text])).toEqual([
    ['user', '第一条'], ['assistant', '答复'],
  ]);
});

it('safely invokes the installed Windows batch wrapper', () => {
  expect(cliInvocation('C:\\Program Files\\T3\\t3.cmd', ['thread', 'show', 'abc'], 'win32').args.at(-1))
    .toContain('"C:\\Program Files\\T3\\t3.cmd"');
  expect(() => cliInvocation('C:\\t3.cmd', ['thread', 'show', 'x&whoami'], 'win32')).toThrow();
  expect(cliInvocation('/usr/local/bin/t3', ['thread', 'show', 'abc'], 'linux').args)
    .toEqual(['thread', 'show', 'abc']);
});

it('loads the project sessions and reads the effective provider and permissions', async () => {
  const thread = {
    threadId: 'thread-one', title: 'Notes', status: 'waiting',
    providerInstanceId: 'codex-personal', model: 'gpt-6.2-sol',
    runtimeMode: 'approval-required', interactionMode: 'plan',
    link: 'https://app.t3.codes/threads/local/thread-one',
  };
  const chat = new CliChat(async args => args[1] === 'list' ? [thread] : { thread, messages: [] });
  expect(await chat.list('/vault')).toEqual([thread]);
  chat.threadId = thread.threadId;
  expect((await chat.read())?.thread).toEqual(thread);
});

it('passes selected effort only on first send', async () => {
  const seen: string[][] = [];
  const chat = new CliChat(async args => { seen.push(args); return { threadId: 'new' }; });
  await chat.send('/vault', 'prompt', { provider: 'claude', model: 'sonnet', option: 'effort=high' });
  await chat.send('/vault', 'follow-up', { provider: 'codex', model: 'other', option: 'reasoningEffort=low' });
  expect(seen[0]).toEqual(['thread', 'start', '--json', '--provider', 'claude', '--model', 'sonnet', '--option', 'effort=high', '/vault', '-']);
  expect(seen[1]).toEqual(['thread', 'send', '--json', 'new', '-']);
});

it('does not launch a CLI command after the view has already closed', async () => {
  const controller = new AbortController();
  controller.abort();
  const run = cliRunner('missing-executable', controller.signal);
  await expect(run(['thread', 'list'])).rejects.toThrow('请求已取消');
});
