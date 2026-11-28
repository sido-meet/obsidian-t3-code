import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { workspacesOverlap } from './workspace';

export interface VaultGuardContext {
  vaultPath: string;
  projectWorkspacePath: string;
}

export interface VaultGuardDeps {
  realpathFn?: (targetPath: string) => Promise<string>;
}

/**
 * Resolves real filesystem paths (following symlinks/junctions) so security boundaries
 * against the active Obsidian Vault cannot be bypassed through aliased project folders.
 */
export class VaultSafetyGuard {
  constructor(private readonly deps: VaultGuardDeps = {}) {}

  private async normalizePath(targetPath: string): Promise<string> {
    const trimmed = targetPath.trim();
    if (!trimmed) return '';
    const rf = this.deps.realpathFn ?? realpath;
    try {
      return await rf(trimmed);
    } catch {
      return resolve(trimmed);
    }
  }

  async isOverlapping(vaultPath: string, projectWorkspacePath: string): Promise<boolean> {
    const [normVault, normProject] = await Promise.all([
      this.normalizePath(vaultPath),
      this.normalizePath(projectWorkspacePath),
    ]);
    if (!normVault || !normProject) return false;
    return workspacesOverlap(normVault, normProject);
  }

  async assertCanSend(ctx: VaultGuardContext, runtimeMode?: string): Promise<void> {
    if (!(await this.isOverlapping(ctx.vaultPath, ctx.projectWorkspacePath))) return;
    if (runtimeMode !== 'approval-required') {
      throw new Error('知识库目录安全保护：当项目目录与当前知识库重叠时，仅允许在「需要审批 (approval-required)」模式下发送消息。');
    }
  }

  async assertCanSetRuntimeMode(ctx: VaultGuardContext, runtimeMode: string): Promise<void> {
    if (!(await this.isOverlapping(ctx.vaultPath, ctx.projectWorkspacePath))) return;
    if (runtimeMode !== 'approval-required') {
      throw new Error('知识库目录安全保护：禁止将与当前知识库重叠的会话权限切换为非「需要审批」模式。');
    }
  }
}
