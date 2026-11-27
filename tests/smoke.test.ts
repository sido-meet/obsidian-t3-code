import ObsidianT3CodePlugin from '../src/main';
import { App } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

interface RegisteredView {
  type: string;
  factory: (leaf: unknown) => { getViewType(): string; getDisplayText(): string };
}

interface RegisteredCommand {
  id: string;
  name: string;
  callback: () => void;
}

const getRegisteredViews = (plugin: ObsidianT3CodePlugin): RegisteredView[] =>
  (plugin as unknown as { registeredViews: RegisteredView[] }).registeredViews;

const getRegisteredCommands = (plugin: ObsidianT3CodePlugin): RegisteredCommand[] =>
  (plugin as unknown as { commands: RegisteredCommand[] }).commands;

const manifest: PluginManifest = {
  id: 't3-codian',
  name: 'T3-Codian',
  version: '0.1.0',
  minAppVersion: '1.5.0',
  description: 'Chat with local T3 Code agents and reference your notes.',
  author: 'T3-Codian Team',
  isDesktopOnly: true,
};

describe('T3-Codian plugin', () => {
  it('exports a plugin class that can be instantiated', () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);

    expect(plugin.manifest.id).toBe('t3-codian');
  });

  it('completes onload without throwing', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);

    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(plugin).toHaveProperty('registeredViews', expect.arrayContaining([
      { type: 'obsidian-t3-code-chat-view', factory: expect.any(Function) },
    ]));
    expect(plugin).toHaveProperty('commands', expect.arrayContaining([
      {
        id: 'open-chat',
        name: '打开 T3-Codian 聊天面板',
        callback: expect.any(Function),
      },
    ]));
  });

  it('registers a chat view factory that produces the registered view type', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);
    await plugin.onload();

    const [registeredView] = getRegisteredViews(plugin);

    expect(registeredView.type).toBe('obsidian-t3-code-chat-view');
    expect(registeredView.factory({}).getViewType()).toBe('obsidian-t3-code-chat-view');
    expect(registeredView.factory({}).getDisplayText()).toBe('T3-Codian');
  });

  it('preserves the host ItemView title element before the sidebar opens', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);
    await plugin.onload();

    const [registeredView] = getRegisteredViews(plugin);
    expect(registeredView.factory({})).toHaveProperty('titleEl.setText', expect.any(Function));
  });

  it('opens the chat view in the right sidebar when the command runs', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);
    await plugin.onload();

    const [command] = getRegisteredCommands(plugin);

    command.callback();

    expect(plugin.app.workspace).toHaveProperty(
      'activatedViewTypes',
      expect.arrayContaining(['obsidian-t3-code-chat-view']),
    );
  });

  it('keeps the command harmless when no right sidebar leaf is available', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);
    await plugin.onload();
    (plugin.app.workspace as unknown as { rightLeafAvailable: boolean }).rightLeafAvailable = false;

    const [command] = getRegisteredCommands(plugin);

    expect(() => command.callback()).not.toThrow();
    expect(plugin.app.workspace).toHaveProperty('activatedViewTypes', []);
  });

  it('releases registered resources and detaches its chat view on unload', async () => {
    const plugin = new ObsidianT3CodePlugin(new App(), manifest);
    await plugin.onload();
    plugin.registerInterval(42);

    expect(() => plugin.onunload()).not.toThrow();

    expect(plugin).toHaveProperty('registeredIntervals', []);
    expect(plugin.app.workspace).toHaveProperty(
      'detachedViewTypes',
      expect.arrayContaining(['obsidian-t3-code-chat-view']),
    );
  });
});

it('reveals the existing chat without creating another sidebar tab', async () => {
  const plugin = new ObsidianT3CodePlugin(new App(), manifest);
  await plugin.onload();
  const [command] = getRegisteredCommands(plugin);
  command.callback();
  command.callback();
  await vi.waitFor(() => expect(plugin.app.workspace).toHaveProperty('revealedLeaves', [expect.any(Object), expect.any(Object)]));
  expect(plugin.app.workspace).toHaveProperty('activatedViewTypes', ['obsidian-t3-code-chat-view']);
  expect(plugin.app.workspace).toHaveProperty('revealedLeaves', [expect.any(Object), expect.any(Object)]);
});

it('reveals an existing chat when older Obsidian returns void', async () => {
  const plugin = new ObsidianT3CodePlugin(new App(), manifest);
  const workspace = plugin.app.workspace as unknown as { legacyRevealLeaf: boolean; revealedLeaves: unknown[] };
  workspace.legacyRevealLeaf = true;
  await plugin.onload();
  const [command] = getRegisteredCommands(plugin);

  command.callback();
  await vi.waitFor(() => expect(workspace.revealedLeaves).toHaveLength(1));
  expect(() => command.callback()).not.toThrow();
  await vi.waitFor(() => expect(workspace.revealedLeaves).toHaveLength(2));
});
