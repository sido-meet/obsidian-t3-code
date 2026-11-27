import { expect, it } from 'vitest';
import { workspacesOverlap } from '../src/t3/workspace';

it('rejects a project equal to, above, or inside the Vault', () => {
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox/project')).toBe(true);
  expect(workspacesOverlap('/home/sandbox', '/home/sandbox-project')).toBe(false);
});
