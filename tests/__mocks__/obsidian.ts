import type { PluginManifest, WorkspaceLeaf } from 'obsidian';

export class WorkspaceLeafStub {
  constructor(private readonly workspace: Workspace) {}

  async setViewState(viewState: { type: string }): Promise<void> {
    this.workspace.activatedViewTypes.push(viewState.type);
    this.workspace.leaves.set(viewState.type, this);
  }
}

export class Workspace {
  readonly activatedViewTypes: string[] = [];
  readonly detachedViewTypes: string[] = [];
  readonly revealedLeaves: WorkspaceLeafStub[] = [];
  readonly leaves = new Map<string, WorkspaceLeafStub>();
  rightLeafAvailable = true;

  getLeavesOfType(type: string): WorkspaceLeafStub[] {
    const leaf = this.leaves.get(type);
    return leaf ? [leaf] : [];
  }

  async revealLeaf(leaf: WorkspaceLeafStub): Promise<void> {
    this.revealedLeaves.push(leaf);
  }

  getRightLeaf(_split: boolean): WorkspaceLeafStub | null {
    return this.rightLeafAvailable ? new WorkspaceLeafStub(this) : null;
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

export class PluginSettingTab {
  constructor(public app: App, public plugin: Plugin) {}
}

export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}
  getBasePath(): string { return this.basePath; }
}

export class MarkdownView {
  file?: { path: string; name: string; basename: string };
  editor = {
    getSelection: () => '',
    getValue: () => '',
    getCursor: () => ({ line: 0, ch: 0 }),
    replaceRange: (_text: string, _pos: unknown) => undefined,
  };
}

export class FuzzySuggestModal<T> {
  constructor(public app: App) {}
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ''; }
  onChooseItem(_item: T): void {}
  open(): void {}
}

export class Notice {
  constructor(public message: string) {}
}

export function setIcon(el: HTMLElement, name: string): void {
  el.setAttribute('data-icon', name);
}
