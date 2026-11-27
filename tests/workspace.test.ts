import { expect, it } from 'vitest';
import { resolveWorkspacePath, workspacesOverlap } from '../src/t3/workspace';

it('rejects a project equal to, above, or inside the Vault', () => {
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox/project')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox-project')).toBe(false);
});

it('defaults to the current Vault and accepts an explicit project override', () => {
  expect(resolveWorkspacePath('', '/vault')).toBe('/vault');
  expect(resolveWorkspacePath('/different/project', '/vault')).toBe('/different/project');
});
