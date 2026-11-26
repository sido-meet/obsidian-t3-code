import { expect, it } from 'vitest';
import { initialCommands, interruptCommand } from '../src/t3/session';

it('creates a read-only Codex thread and dispatches to that same thread', () => {
  const [create, dispatch] = initialCommands('thread', { id: 'project', title: 'Test', root: 'X:/sandbox', model: 'custom-model' }, 'Hello', 'message');
  expect(create).toMatchObject({
    type: 'thread.create', threadId: 'thread', projectId: 'project',
    modelSelection: { instanceId: 'codex', model: 'custom-model' }, runtimeMode: 'approval-required',
  });
  expect(dispatch).toMatchObject({
    type: 'message.dispatch', threadId: 'thread', messageId: 'message', text: 'Hello',
    dispatchMode: { type: 'start_immediately' },
  });
  expect(create.commandId).not.toBe(dispatch.commandId);
});

it('targets the active run by ID when stopping', () => {
  expect(interruptCommand('thread', 'running')).toMatchObject({
    type: 'run.interrupt', threadId: 'thread', runId: 'running', holdQueue: true,
  });
});
