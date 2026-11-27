import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Record<string, unknown>;

const manifest = readJson('../manifest.json');
const packageJson = readJson('../package.json');

describe('Obsidian plugin manifest', () => {
  it('keeps manifest and package versions in sync', () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it('declares the required Obsidian manifest fields', () => {
    expect(manifest.id).toBe('t3-codian');
    expect(manifest.id).toBe(packageJson.name);
    expect(manifest.name).toBe('T3-Codian');
    expect(manifest.minAppVersion).toBe('1.5.0');
    expect(manifest.isDesktopOnly).toBe(true);
    expect(manifest.description).toMatch(/\.$/);

    for (const field of ['id', 'name', 'description', 'author'] as const) {
      expect(String(manifest[field])).not.toMatch(/obsidian/i);
    }

    for (const field of ['name', 'version', 'description', 'author'] as const) {
      expect(manifest[field]).toBeTypeOf('string');
      expect((manifest[field] as string).length).toBeGreaterThan(0);
    }
  });
});
