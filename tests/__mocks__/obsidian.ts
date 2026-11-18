import type { PluginManifest, WorkspaceLeaf } from 'obsidian';

export class WorkspaceLeafStub {
  constructor(private readonly workspace: Workspace) {}

  async setViewState(viewState: { type: string }): Promise<void> {
    this.workspace.activatedViewTypes.push(viewState.type);
  }
}

export class Workspace {
  readonly activatedViewTypes: string[] = [];
  readonly detachedViewTypes: string[] = [];

  getRightLeaf(_split: boolean): WorkspaceLeafStub | null {
    return new WorkspaceLeafStub(this);
  }

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
  readonly registeredIntervals: number[] = [];
  readonly registeredEvents: unknown[] = [];
  readonly registeredCallbacks: (() => unknown)[] = [];

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

  addSettingTab(tab: unknown): void {
    this.settingsTabs.push(tab);
  }

  register(callback: () => unknown): void {
    this.registeredCallbacks.push(callback);
  }

  registerEvent(eventRef: unknown): void {
    this.registeredEvents.push(eventRef);
  }

  registerDomEvent(): void {}

  registerInterval(id: number): number {
    this.registeredIntervals.push(id);
    return id;
  }

  async onload(): Promise<void> {}

  onunload(): void {
    this.registeredIntervals.length = 0;
    this.registeredEvents.length = 0;
    this.registeredCallbacks.length = 0;
  }
}
