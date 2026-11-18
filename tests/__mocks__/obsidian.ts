import type { WorkspaceLeaf } from 'obsidian';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
}

export class Workspace {
  readonly detachedViewTypes: string[] = [];

  detachLeavesOfType(type: string): void {
    this.detachedViewTypes.push(type);
  }
}

export class App {
  workspace = new Workspace();
}

export class ItemView {
  constructor(public leaf: WorkspaceLeaf) {}
}

export class Plugin {
  readonly registeredViews: { type: string; factory: unknown }[] = [];
  readonly ribbonIcons: { icon: string; title: string; callback: () => void }[] = [];
  readonly commands: unknown[] = [];
  readonly settingsTabs: unknown[] = [];

  constructor(public app: App, public manifest: PluginManifest) {}

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(data: unknown): Promise<void> {
    void data;
  }

  registerView(type: string, factory: unknown): void {
    this.registeredViews.push({ type, factory });
  }

  addRibbonIcon(icon: string, title: string, callback: () => void): unknown {
    const ribbonIcon = { icon, title, callback };
    this.ribbonIcons.push(ribbonIcon);
    return ribbonIcon;
  }

  addCommand(command: unknown): unknown {
    this.commands.push(command);
    return command;
  }

  registerSettingsTab(tab: unknown): void {
    this.settingsTabs.push(tab);
  }

  async onload(): Promise<void> {}

  async onunload(): Promise<void> {}
}
