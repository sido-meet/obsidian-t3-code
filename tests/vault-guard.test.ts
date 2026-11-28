import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VaultSafetyGuard } from '../src/t3/vault-guard';

describe('VaultSafetyGuard', () => {
  it('blocks non-approval-required sends and privilege escalation when workspace overlaps Vault', async () => {
    const guard = new VaultSafetyGuard();
    const mockVault = join(tmpdir(), 'mock-vault');
    const ctx = { vaultPath: mockVault, projectWorkspacePath: join(mockVault, 'notes') };

    expect(await guard.isOverlapping(ctx.vaultPath, ctx.projectWorkspacePath)).toBe(true);
    await expect(guard.assertCanSend(ctx, 'approval-required')).resolves.toBeUndefined();
    await expect(guard.assertCanSend(ctx, 'auto')).rejects.toThrow('approval-required');
    await expect(guard.assertCanSend(ctx, 'full-access')).rejects.toThrow('approval-required');
    await expect(guard.assertCanSend(ctx, undefined)).rejects.toThrow('approval-required');

    await expect(guard.assertCanSetRuntimeMode(ctx, 'approval-required')).resolves.toBeUndefined();
    await expect(guard.assertCanSetRuntimeMode(ctx, 'full-access')).rejects.toThrow('禁止');
    await expect(guard.assertCanSetRuntimeMode(ctx, 'auto-accept-edits')).rejects.toThrow('禁止');
  });

  it('allows any runtimeMode when workspace is disjoint from Vault', async () => {
    const guard = new VaultSafetyGuard();
    const ctx = { vaultPath: join(tmpdir(), 'mock-vault'), projectWorkspacePath: join(tmpdir(), 'code', 'my-repo') };

    expect(await guard.isOverlapping(ctx.vaultPath, ctx.projectWorkspacePath)).toBe(false);
    await expect(guard.assertCanSend(ctx, 'full-access')).resolves.toBeUndefined();
    await expect(guard.assertCanSetRuntimeMode(ctx, 'auto')).resolves.toBeUndefined();
  });

  it('detects symlinked/junctioned workspace aliases pointing into the Vault via realpath', async () => {
    const root = mkdtempSync(join(tmpdir(), 't3-vault-guard-'));
    try {
      const vault = join(root, 'vault');
      const vaultSub = join(vault, 'sub');
      const alias = join(root, 'alias-project');
      mkdirSync(vaultSub, { recursive: true });
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(vaultSub, alias, linkType);

      const guard = new VaultSafetyGuard();
      expect(await guard.isOverlapping(vault, alias)).toBe(true);
      await expect(guard.assertCanSend({ vaultPath: vault, projectWorkspacePath: alias }, 'full-access'))
        .rejects.toThrow('approval-required');
      await expect(guard.assertCanSetRuntimeMode({ vaultPath: vault, projectWorkspacePath: alias }, 'full-access'))
        .rejects.toThrow('禁止');
      const nonExistentNested = join(alias, 'nested', 'missing-dir');
      expect(await guard.isOverlapping(vault, nonExistentNested)).toBe(true);
      await expect(guard.assertCanSend({ vaultPath: vault, projectWorkspacePath: nonExistentNested }, 'auto'))
        .rejects.toThrow('approval-required');
      await expect(guard.assertCanSend({ vaultPath: vault, projectWorkspacePath: alias }, 'approval-required'))
        .resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
