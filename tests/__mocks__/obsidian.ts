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
  legacyRevealLeaf = false;

  getLeavesOfType(type: string): WorkspaceLeafStub[] {
    const leaf = this.leaves.get(type);
    return leaf ? [leaf] : [];
  }

  revealLeaf(leaf: WorkspaceLeafStub): Promise<void> | void {
    this.revealedLeaves.push(leaf);
    if (!this.legacyRevealLeaf) return Promise.resolve();
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

export class Component {
  readonly children: Component[] = [];
  unloaded = false;

  load(): void {
    this.unloaded = false;
  }

  unload(): void {
    this.unloaded = true;
    for (const child of [...this.children]) child.unload();
    this.children.length = 0;
  }

  addChild<T extends Component>(child: T): T {
    if (!this.children.includes(child)) this.children.push(child);
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    return child;
  }
}

export class ItemView extends Component {
  readonly titleEl = { setText(): void {} };

  constructor(public leaf: WorkspaceLeaf) {
    super();
  }
}

export const MarkdownRenderer = {
  async render(_app: App, markdown: string, el: HTMLElement, _sourcePath: string, _component: Component): Promise<void> {
    const doc = el.ownerDocument;
    if (!doc) return;
    const pre = doc.createElement('div');
    pre.className = 't3c-mock-rendered';
    // Lightweight mock reflecting lines, headings, links, and raw HTML for security unit tests.
    for (const line of markdown.split(/\r?\n/)) {
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const h = doc.createElement(`h${heading[1].length}`);
        h.textContent = heading[2];
        pre.appendChild(h);
        continue;
      }
      const p = doc.createElement('p');
      p.textContent = line;
      pre.appendChild(p);
    }
    el.appendChild(pre);
  },
};

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
  containerEl: HTMLElement = { empty: () => undefined } as unknown as HTMLElement;
  constructor(public app: App, public plugin: Plugin) {}
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(cb: (comp: { inputEl: HTMLInputElement; setValue(v: string): unknown; setPlaceholder(p: string): unknown; onChange(fn: (v: string) => void): unknown }) => void): this {
    const comp = {
      inputEl: { type: 'text' } as HTMLInputElement,
      setValue() { return comp; },
      setPlaceholder() { return comp; },
      onChange() { return comp; },
    };
    cb(comp);
    return this;
  }
  addTextArea(cb: (comp: { setValue(v: string): unknown; onChange(fn: (v: string) => void): unknown }) => void): this {
    const comp = { setValue() { return comp; }, onChange() { return comp; } };
    cb(comp);
    return this;
  }
  addDropdown(cb: (comp: { addOption(k: string, l: string): unknown; setValue(v: string): unknown; onChange(fn: (v: string) => void): unknown }) => void): this {
    const comp = {
      addOption() { return comp; },
      setValue() { return comp; },
      onChange() { return comp; },
    };
    cb(comp);
    return this;
  }
  addButton(cb: (comp: { setButtonText(t: string): unknown; setDisabled(d: boolean): unknown; onClick(fn: () => void): unknown }) => void): this {
    const comp = { setButtonText() { return comp; }, setDisabled() { return comp; }, onClick() { return comp; } };
    cb(comp);
    return this;
  }
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
