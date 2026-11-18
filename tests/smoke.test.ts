import T3CodianPlugin from '../src/main';
import { App } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import { describe, expect, it } from 'vitest';

interface RegisteredView {
  type: string;
  factory: (leaf: unknown) => { getViewType(): string };
}

const getRegisteredViews = (plugin: T3CodianPlugin): RegisteredView[] =>
  (plugin as unknown as { registeredViews: RegisteredView[] }).registeredViews;

const manifest: PluginManifest = {
  id: 't3-codian',
  name: 'T3-Codian',
  version: '0.1.0',
  minAppVersion: '1.5.0',
  description: 'T3 Code Agent integration for Obsidian',
  author: 'T3-Codian Team',
  isDesktopOnly: true,
};

describe('T3-Codian plugin', () => {
  it('exports a plugin class that can be instantiated', () => {
    const plugin = new T3CodianPlugin(new App(), manifest);

    expect(plugin.manifest.id).toBe('t3-codian');
  });

  it('completes onload without throwing', async () => {
    const plugin = new T3CodianPlugin(new App(), manifest);

    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(plugin).toHaveProperty('registeredViews', expect.arrayContaining([
      { type: 't3-codian-chat-view', factory: expect.any(Function) },
    ]));
    expect(plugin).toHaveProperty('commands', expect.arrayContaining([
      {
        id: 't3-codian-open-chat',
        name: '打开 T3-Codian 聊天面板',
        callback: expect.any(Function),
      },
    ]));
  });

  it('registers a chat view factory that produces the registered view type', async () => {
    const plugin = new T3CodianPlugin(new App(), manifest);
    await plugin.onload();

    const [registeredView] = getRegisteredViews(plugin);

    expect(registeredView.type).toBe('t3-codian-chat-view');
    expect(registeredView.factory({}).getViewType()).toBe('t3-codian-chat-view');
  });

  it('detaches its chat view on unload', async () => {
    const plugin = new T3CodianPlugin(new App(), manifest);
    await plugin.onload();

    await expect(plugin.onunload()).resolves.toBeUndefined();
    expect(plugin.app.workspace).toHaveProperty(
      'detachedViewTypes',
      expect.arrayContaining(['t3-codian-chat-view']),
    );
  });
});
