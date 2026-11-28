import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/settings';
import type ObsidianT3CodePlugin from '../src/main';
import type { CliThread } from '../src/t3/cli';
import { App, FileSystemAdapter, MarkdownView, type WorkspaceLeaf } from 'obsidian';

const cliMocks = vi.hoisted(() => {
  return {
    capturedSignals: [] as Array<AbortSignal | undefined>,
    listThreads: vi.fn<(args: string[]) => Promise<unknown[]>>(async () => []),
    readThread: vi.fn<(args: string[]) => Promise<unknown>>(async () => null),
    startThread: vi.fn<(args: string[], stdin?: string) => Promise<unknown>>(async () => ({ threadId: 'th-new', runId: 'run-new' })),
    sendTurn: vi.fn<(args: string[], stdin?: string) => Promise<unknown>>(async () => ({ threadId: 'th-1', runId: 'run-2' })),
  };
});

vi.mock('../src/t3/cli', async () => {
  const actual = await vi.importActual<typeof import('../src/t3/cli')>('../src/t3/cli');
  return {
    ...actual,
    cliRunner: (_cliPath: string, signal?: AbortSignal) => {
      cliMocks.capturedSignals.push(signal);
      return async (args: string[], stdin?: string) => {
        if (signal?.aborted) throw new Error('Aborted');
        const cmd = args[1];
        if (cmd === 'list') return cliMocks.listThreads(args);
        if (cmd === 'show') return cliMocks.readThread(args);
        if (cmd === 'start') return cliMocks.startThread(args, stdin);
        if (cmd === 'send') return cliMocks.sendTurn(args, stdin);
        throw new Error(`Unexpected CLI command: ${args.join(' ')}`);
      };
    },
  };
});

import type { BackendCapabilities, BackendEvent, ProviderDescriptor, ThreadDetail } from '../src/t3/backend';
import { T3BackendManager } from '../src/t3/backend-manager';
import { UncertainWriteError, type RpcBackend } from '../src/t3/rpc-backend';
import { T3Store } from '../src/t3/store';
import ObsidianT3CodeView, { type BackendManagerFactory } from '../src/ui/ObsidianT3CodeView';

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  key = '';
  shiftKey = false;
  isComposing = false;
  button = 0;
  target: unknown;
  clientX = 0;

  constructor(public readonly type: string, init: Partial<FakeEvent> = {}) {
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

interface ElementCreateOpts {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
  type?: string;
  href?: string;
  title?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  prepend?: boolean;
}

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly classes = new Set<string>();
  private readonly attrMap = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void };
  readonly listeners = new Map<string, Set<Listener>>();
  hidden = false;
  disabled = false;
  readOnly = false;
  type = '';
  href = '';
  title = '';
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  placeholder = '';
  rows = 1;
  scrollHeight = 120;
  scrollTop = 0;
  clientHeight = 120;
  onclick: Listener | null = null;
  oninput: Listener | null = null;
  onkeydown: Listener | null = null;
  onpointerdown: Listener | null = null;
  private _text = '';
  private _html = '';
  private rectWidth = 420;
  private rectHeight = 700;

  constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeDocument,
  ) {
    const styleProps: Record<string, string> = {};
    this.style = Object.assign(styleProps, {
      setProperty(k: string, v: string): void {
        styleProps[k] = v;
      },
    });
  }

  setBoundingRect(width: number, height = 700): void {
    this.rectWidth = width;
    this.rectHeight = height;
  }

  getBoundingClientRect() {
    return {
      width: this.rectWidth,
      height: this.rectHeight,
      top: 0,
      left: 0,
      right: this.rectWidth,
      bottom: this.rectHeight,
      x: 0,
      y: 0,
    };
  }

  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map(c => c.textContent).join('');
  }

  set textContent(val: string) {
    this.children = [];
    this._html = '';
    this._text = val ?? '';
  }

  get innerHTML(): string {
    return this._html || this.textContent;
  }

  set innerHTML(val: string) {
    this.children = [];
    this._text = '';
    this._html = val ?? '';
  }

  get attributes() {
    return [...this.attrMap.entries()].map(([name, value]) => ({ name, value }));
  }

  get classList() {
    return {
      contains: (c: string) => this.classes.has(c),
      add: (c: string) => { this.addClass(c); },
      remove: (c: string) => { this.removeClass(c); },
    };
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(val: string) {
    this.classes.clear();
    if (val) this.addClass(val);
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx >= 0 ? (this.parentElement.children[idx + 1] ?? null) : null;
  }

  setText(text: string): this {
    this.textContent = text;
    return this;
  }

  empty(): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = '';
    this._html = '';
  }

  addClass(...names: string[]): this {
    for (const entry of names) {
      for (const token of entry.split(/\s+/)) {
        if (token) this.classes.add(token);
      }
    }
    return this;
  }

  removeClass(...names: string[]): this {
    for (const entry of names) {
      for (const token of entry.split(/\s+/)) {
        if (token) this.classes.delete(token);
      }
    }
    return this;
  }

  toggleClass(name: string, force?: boolean): boolean {
    const next = force === undefined ? !this.classes.has(name) : force;
    if (next) this.classes.add(name);
    else this.classes.delete(name);
    return next;
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  setAttribute(key: string, val: string): void {
    this.attrMap.set(key, String(val));
    if (key === 'href') this.href = String(val);
    if (key === 'title') this.title = String(val);
  }

  getAttribute(key: string): string | null {
    if (key === 'href' && this.href) return this.href;
    return this.attrMap.get(key) ?? null;
  }

  removeAttribute(key: string): void {
    this.attrMap.delete(key);
    if (key === 'href') this.href = '';
  }

  createDiv(opts?: ElementCreateOpts | string): FakeElement {
    return this.createEl('div', opts);
  }

  createSpan(opts?: ElementCreateOpts | string): FakeElement {
    return this.createEl('span', opts);
  }

  createEl(tag: string, opts?: ElementCreateOpts | string): FakeElement {
    const el = this.ownerDocument.createElement(tag);
    if (typeof opts === 'string') {
      el.addClass(opts);
    } else if (opts) {
      if (opts.cls) {
        if (Array.isArray(opts.cls)) el.addClass(...opts.cls);
        else el.addClass(opts.cls);
      }
      if (opts.text !== undefined) el.setText(opts.text);
      if (opts.type !== undefined) el.type = opts.type;
      if (opts.href !== undefined) el.href = opts.href;
      if (opts.title !== undefined) el.title = opts.title;
      if (opts.value !== undefined) el.value = opts.value;
      if (opts.placeholder !== undefined) el.placeholder = opts.placeholder;
      if (opts.rows !== undefined) el.rows = opts.rows;
      if (opts.attr) {
        for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
      }
    }
    if (typeof opts === 'object' && opts?.prepend) this.prepend(el);
    else this.append(el);
    return el;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  appendChild<T extends FakeElement>(node: T): T {
    this.append(node);
    return node;
  }

  prepend(...nodes: FakeElement[]): void {
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.parentElement = this;
      this.children.unshift(node);
    }
  }

  insertBefore(node: FakeElement, ref: FakeElement | null): void {
    node.remove();
    node.parentElement = this;
    if (!ref) {
      this.children.push(node);
      return;
    }
    const idx = this.children.indexOf(ref);
    if (idx === -1) this.children.push(node);
    else this.children.splice(idx, 0, node);
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(c => c !== this);
    this.parentElement = null;
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some(c => c.contains(other));
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: FakeEvent): boolean {
    if (ev.target === undefined) ev.target = this;
    const handler = (this as unknown as Record<string, Listener | null>)[`on${ev.type}`];
    if (typeof handler === 'function') handler(ev);
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) {
      fn(ev);
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click', { target: this }));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  private matchesSimple(selector: string): boolean {
    const trimmed = selector.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('.')) return this.classes.has(trimmed.slice(1));
    const attrMatch = trimmed.match(/^([a-z0-9-]+)?\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const got = this.getAttribute(attr);
      if (got === null) return false;
      return val === undefined ? true : got === val;
    }
    return this.tagName === trimmed.toUpperCase();
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matchesSimple(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  observed: FakeElement[] = [];

  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: FakeElement): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(width: number, height = 700): void {
    for (const el of this.observed) el.setBoundingRect(width, height);
    this.callback([{ contentRect: { width, height } }]);
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly defaultView = {
    ResizeObserver: FakeResizeObserver,
    addEventListener: (type: string, fn: Listener) => this.addEventListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => this.removeEventListener(type, fn),
  };

  constructor() {
    this.body = new FakeElement('BODY', this);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }

  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: FakeEvent): void {
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function waitUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (pred()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for async sidebar condition');
}

async function waitReady(view: ObsidianT3CodeView): Promise<void> {
  const state = view as unknown as { ready: boolean; activeTab: { checking: boolean } };
  await waitUntil(() => state.ready && !state.activeTab.checking);
}

function makeThread(overrides: Partial<CliThread> = {}): CliThread {
  return {
    threadId: 'th-1',
    projectId: 'proj-1',
    title: '知识库治理',
    model: 'gpt-5.4',
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    status: 'ready',
    providerInstanceId: 'codex',
    link: 'https://app.t3.codes/threads/th-1',
    settled: false,
    pinned: false,
    snoozed: false,
    archived: false,
    pendingRequestCount: 0,
    updatedAt: '2026-11-27T10:00:00Z',
    ...overrides,
  };
}

describe('ObsidianT3CodeView V2 UI', () => {
  let tempRoot: string;
  let vaultDir: string;
  let projectDir: string;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    cliMocks.capturedSignals = [];
    vi.clearAllMocks();
    tempRoot = mkdtempSync(join(tmpdir(), 't3c-view-test-'));
    vaultDir = join(tempRoot, 'vault');
    projectDir = join(tempRoot, 'workspace');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-27T12:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function setupView(settingsPatch: Partial<Settings> = {}, factory?: BackendManagerFactory) {
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    const doc = new FakeDocument();
    const contentEl = doc.createElement('div');
    const rawApp = new App() as unknown as Record<string, unknown>;
    const AdapterCtor = FileSystemAdapter as unknown as new (basePath: string) => FileSystemAdapter;
    const MarkdownViewCtor = MarkdownView as unknown as new () => MarkdownView;
    const mdView = new MarkdownViewCtor();
    mdView.file = { path: '00-Inbox/note.md', name: 'note.md', basename: 'note' } as never;
    mdView.editor.getValue = () => '# Hello\nBody';
    rawApp.vault = {
      adapter: new AdapterCtor(vaultDir),
      getMarkdownFiles: () => [],
      cachedRead: async () => '',
    };
    rawApp.workspace = {
      ...(rawApp.workspace as Record<string, unknown>),
      rootSplit: {},
      getMostRecentLeaf: () => ({ view: mdView }),
      on: () => ({}),
    };
    const app = rawApp as unknown as App;

    const settings: Settings = {
      cliPath: 't3',
      projectPath: projectDir,
      projectId: 'proj-1',
      provider: 'codex',
      model: 'gpt-5.4',
      modelPresets: [
        'codex | gpt-5.4 | reasoningEffort=high',
        'codex | gpt-5.3-codex | reasoningEffort=medium',
        'claudeAgent | claude-sonnet-4-6 | reasoningEffort=medium',
      ].join('\n'),
      includeNote: false,
      serverUrl: '',
      backendPreference: 'cli',
      ...settingsPatch,
    };
    const updateSettings = vi.fn(async (patch: Partial<Settings>) => {
      Object.assign(settings, patch);
    });
    const plugin = { settings, updateSettings, app } as unknown as ObsidianT3CodePlugin;
    const view = new ObsidianT3CodeView({} as WorkspaceLeaf, plugin, factory);
    const viewStub = view as unknown as {
      app: unknown;
      contentEl: FakeElement;
      registerDomEvent: (
        el: { addEventListener: (t: string, c: Listener, o?: unknown) => void; removeEventListener: (t: string, c: Listener, o?: unknown) => void },
        type: string,
        cb: Listener,
        opts?: unknown,
      ) => void;
      registerEvent: (_ref: unknown) => void;
      registerInterval: (id: number) => number;
    };
    const domCleanups: Array<() => void> = [];
    viewStub.app = app;
    viewStub.contentEl = contentEl;
    viewStub.registerDomEvent = (el, type, cb, opts) => {
      el.addEventListener(type, cb, opts);
      domCleanups.push(() => el.removeEventListener(type, cb, opts));
    };
    viewStub.registerEvent = () => undefined;
    viewStub.registerInterval = id => id;
    const origClose = view.onClose.bind(view);
    view.onClose = async () => {
      for (const cleanup of domCleanups.splice(0)) cleanup();
      await origClose();
    };
    return { view, root: contentEl, doc, app, settings, updateSettings };
  }

  it('uses zero internal header, stays silent when healthy, and aborts/cleans up on close', async () => {
    cliMocks.listThreads.mockResolvedValue([makeThread()]);
    const { view, root } = setupView();

    await view.onOpen();
    await waitReady(view);

    expect(root.querySelector('.t3c-header')).toBeNull();
    const banner = root.querySelector('.t3c-banner');
    expect(banner?.hidden).toBe(true);
    expect(root.querySelector('.t3c-note-footer-label')?.textContent).toBe('note.md');
    expect(root.querySelector('.t3c-usage-chip')?.textContent).toContain('—');
    expect(cliMocks.capturedSignals.length).toBeGreaterThan(0);

    expect(FakeResizeObserver.instances).toHaveLength(1);
    const ro = FakeResizeObserver.instances[0]!;
    expect(ro.disconnected).toBe(false);

    await view.onClose();
    expect(ro.disconnected).toBe(true);
    expect(cliMocks.capturedSignals.every(signal => signal?.aborted === true)).toBe(true);
  });

  it('surfaces anomaly banner on waiting/pending approval, failed run, unsafe link suppression, and Vault block', async () => {
    const waitingThread = makeThread({
      threadId: 'th-wait',
      status: 'waiting',
      pendingRequestCount: 2,
      link: 'javascript:alert(1)',
    });
    const failedThread = makeThread({
      threadId: 'th-fail',
      status: 'failed',
      pendingRequestCount: 0,
      link: 'https://app.t3.codes/threads/th-fail',
    });
    cliMocks.listThreads.mockResolvedValue([waitingThread, failedThread]);
    cliMocks.readThread.mockImplementation(async args => {
      const id = args.at(-1);
      if (id === 'th-fail') return { thread: failedThread, messages: [] };
      return { thread: waitingThread, messages: [] };
    });

    const { view, root } = setupView();
    await view.onOpen();
    await waitReady(view);

    await (view as unknown as { switchThread: (thread?: CliThread) => Promise<void> }).switchThread(waitingThread);
    await flush();

    const banner = root.querySelector('.t3c-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.getAttribute('data-tone')).toBe('warning');
    expect(root.querySelector('.t3c-banner-text')?.textContent).toContain('等待处理');
    const bannerLink = banner.querySelector('a')!;
    expect(bannerLink.hidden).toBe(true);
    expect(bannerLink.getAttribute('href')).toBeNull();

    // Failed run surfaces data-tone="error" and allows safe https://app.t3.codes/threads/ link
    await (view as unknown as { switchThread: (thread?: CliThread) => Promise<void> }).switchThread(failedThread);
    await flush();
    expect(banner.hidden).toBe(false);
    expect(banner.getAttribute('data-tone')).toBe('error');
    expect(bannerLink.hidden).toBe(false);
    expect(bannerLink.getAttribute('href')).toBe('https://app.t3.codes/threads/th-fail');

    // Vault safety block when projectPath overlaps vaultDir and thread runtimeMode != approval-required
    const fullAccessVaultThread = makeThread({
      threadId: 'th-vault',
      runtimeMode: 'full-access',
      link: 'https://app.t3.codes/threads/th-vault',
    });
    cliMocks.listThreads.mockResolvedValue([fullAccessVaultThread]);
    cliMocks.readThread.mockResolvedValue({ thread: fullAccessVaultThread, messages: [] });
    const vaultView = setupView({ projectPath: vaultDir });
    await vaultView.view.onOpen();
    await waitReady(vaultView.view);
    await (vaultView.view as unknown as { switchThread: (thread?: CliThread) => Promise<void> }).switchThread(fullAccessVaultThread);
    await flush();

    const vBanner = vaultView.root.querySelector('.t3c-banner')!;
    expect(vBanner.hidden).toBe(false);
    expect(vBanner.getAttribute('data-tone')).toBe('warning');
    expect(vBanner.querySelector('a')?.getAttribute('href')).toBe('https://app.t3.codes/threads/th-vault');
    const sendBtn = vaultView.root.querySelector('.t3c-send-btn')!;
    expect(sendBtn.disabled).toBe(true);

    await vaultView.view.onClose();
    await view.onClose();
  });

  it('switches narrow / single / wide modes on ResizeObserver and supports wide sidebar filtering & Inbox mode', async () => {
    cliMocks.listThreads.mockResolvedValue([
      makeThread({ threadId: 't-1', title: 'Normal Thread', settled: false, pinned: true, updatedAt: '2026-11-27T11:50:00Z' }),
      makeThread({ threadId: 't-2', title: 'Waiting Thread', status: 'waiting', pendingRequestCount: 1, updatedAt: '2026-11-27T11:55:00Z' }),
      makeThread({ threadId: 't-3', title: 'Old Archived', archived: true, updatedAt: '2026-11-20T10:00:00Z' }),
    ]);

    const { view, root } = setupView();
    await view.onOpen();
    await waitReady(view);

    const ro = FakeResizeObserver.instances[0]!;
    expect(root.hasClass('obsidian-t3-code')).toBe(true);
    ro.trigger(280);
    expect(root.hasClass('is-narrow')).toBe(true);
    expect(root.hasClass('is-wide')).toBe(false);

    ro.trigger(420);
    expect(root.hasClass('is-narrow')).toBe(false);
    expect(root.hasClass('is-wide')).toBe(false);

    // Open history popover in single mode, then widen >= 600px -> auto-closes history popover
    const historyBtn = root.querySelector('[aria-label="会话历史"]')!;
    historyBtn.click();
    await flush();
    expect(root.querySelector('.t3c-history-popover')?.hidden).toBe(false);

    ro.trigger(680);
    expect(root.hasClass('is-wide')).toBe(true);
    expect(root.querySelector('.t3c-history-popover')?.hidden).toBe(true);
    expect(root.querySelector('.t3c-wide-project')?.textContent).toBe('workspace');

    // Keyboard ArrowLeft/ArrowRight & pointer drag on resizer adjusts wide sidebar width within clamp
    const resizer = root.querySelector('.t3c-resizer')!;
    resizer.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowLeft' }));
    expect(root.style['--t3c-wide-sidebar-width']).toBe('236px');
    resizer.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight' }));
    expect(root.style['--t3c-wide-sidebar-width']).toBe('220px');

    const wideList = root.querySelector('.t3c-wide-list')!;
    const rowsDefault = wideList.querySelectorAll('.t3c-session-row');
    expect(rowsDefault.some(r => r.textContent.includes('Old Archived'))).toBe(false);
    expect(rowsDefault.some(r => r.textContent.includes('Normal Thread'))).toBe(true);

    const modeBtn = root.querySelector('.t3c-wide-sidebar')!.querySelector('.t3c-mini-btn')!;
    modeBtn.click();
    await flush();
    expect(modeBtn.textContent).toContain('Inbox');
    const rowsInbox = wideList.querySelectorAll('.t3c-session-row');
    expect(rowsInbox.some(r => r.textContent.includes('Waiting Thread'))).toBe(true);

    await view.onClose();
  });

  it('isolates multi-tab drafts/badges, avoids nested buttons & selection thrash, and handles in-flight abort safely', async () => {
    cliMocks.listThreads.mockResolvedValue([makeThread()]);
    const { view, root, doc } = setupView();
    await view.onOpen();
    await waitReady(view);

    const initialBadge = root.querySelector('.t3c-tab-badge')!;
    const draft = root.querySelector('.t3c-textarea')!;
    draft.value = 'Tab 1 draft';
    draft.dispatchEvent(new FakeEvent('input'));
    doc.dispatchEvent(new FakeEvent('selectionchange'));
    // Typing and selectionchange must NOT rebuild tab badges
    expect(root.querySelector('.t3c-tab-badge')).toBe(initialBadge);

    const addBtn = root.querySelector('[aria-label="新开标签页"]')!;
    addBtn.click();
    await flush();

    expect(draft.value).toBe('');
    const badges = root.querySelectorAll('.t3c-tab-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]!.tagName).toBe('DIV');
    expect(badges[0]!.hasClass('is-expanded')).toBe(false);
    expect(badges[0]!.querySelector('.t3c-tab-badge-select')!.textContent).toBe('1');
    expect(badges[1]!.hasClass('is-expanded')).toBe(true);
    // Select & close are sibling buttons, never nested inside one another
    const closeBtn = badges[1]!.querySelector('.t3c-tab-badge-close')!;
    expect(closeBtn.tagName).toBe('BUTTON');
    expect(badges[1]!.querySelector('.t3c-tab-badge-select')!.contains(closeBtn)).toBe(false);

    draft.value = 'Tab 2 draft';
    draft.dispatchEvent(new FakeEvent('input'));

    // Start an in-flight CLI request on Tab 2 and close Tab 2 immediately -> must NOT mark view unready
    let rejectSend: ((err: Error) => void) | undefined;
    cliMocks.startThread.mockImplementationOnce(() => new Promise((_, rej) => { rejectSend = rej; }));
    root.querySelector('.t3c-send-btn')!.click();
    await waitUntil(() => typeof rejectSend === 'function');
    root.querySelector('.t3c-tab-badge-close')!.click();
    rejectSend!(new Error('T3 CLI 请求已取消。'));
    await flush();

    expect(root.querySelectorAll('.t3c-tab-badge')).toHaveLength(1);
    expect(draft.value).toBe('Tab 1 draft');
    expect(root.querySelector('.t3c-banner')?.hidden).toBe(true);

    // Re-add Tab 2, test switching back preserves Tab 1 draft then closing Tab 2 leaves Tab 1 intact
    addBtn.click();
    await flush();
    draft.value = 'Tab 2 new';
    draft.dispatchEvent(new FakeEvent('input'));
    root.querySelectorAll('.t3c-tab-badge')[0]!.querySelector('.t3c-tab-badge-select')!.click();
    expect(draft.value).toBe('Tab 1 draft');
    root.querySelectorAll('.t3c-tab-badge')[1]!.querySelector('.t3c-tab-badge-select')!.click();
    root.querySelector('.t3c-tab-badge-close')!.click();
    expect(root.querySelectorAll('.t3c-tab-badge')).toHaveLength(1);
    expect(draft.value).toBe('Tab 1 draft');

    await view.onClose();
  });

  it('renders 3-column Agent · Model · Effort popover with inert disabled buttons, Escape on document, thread lock + clone draft, usage, permissions, and connected action errors', async () => {
    const activeThread = makeThread({
      threadId: 'th-active',
      title: 'Existing',
      providerInstanceId: 'codex',
      model: 'gpt-5.4',
      runtimeMode: 'approval-required',
    });
    cliMocks.listThreads.mockResolvedValue([activeThread]);
    cliMocks.readThread.mockResolvedValue({
      thread: activeThread,
      messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }],
    });

    const { view, root, doc, app, updateSettings } = setupView();
    await view.onOpen();
    await waitReady(view);

    // DEFAULT_SETTINGS.includeNote is false, so clicking footer toggles it to true
    const noteFooter = root.querySelector('.t3c-note-footer')!;
    noteFooter.click();
    await flush();
    expect(updateSettings).toHaveBeenCalledWith({ includeNote: true });

    // Open 3-column model popover on new tab
    const modelChip = root.querySelector('.t3c-model-chip')!;
    expect(modelChip.getAttribute('aria-expanded')).toBe('false');
    modelChip.click();
    expect(modelChip.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.t3c-mp-agents')).not.toBeNull();

    // Browse Claude agent without selecting a Claude model -> effort col is inert AND buttons disabled
    const agentButtons = root.querySelectorAll('.t3c-mp-agent-btn');
    const claudeAgent = agentButtons.find(b => b.getAttribute('aria-label') === 'claudeAgent')!;
    claudeAgent.click();
    const effortCol = root.querySelector('.t3c-mp-efforts')!;
    expect(effortCol.hasClass('is-inert')).toBe(true);
    expect(root.querySelectorAll('.t3c-mp-effort-row').every(b => b.disabled)).toBe(true);

    // Pick Claude model -> updates trigger chip, preserves focus inside popover (not body), clears inert
    root.querySelector('.t3c-mp-model-row')!.click();
    await flush();
    expect(modelChip.textContent).toContain('claudeAgent · claude-sonnet-4-6');
    expect(root.querySelector('.t3c-mp-efforts')!.hasClass('is-inert')).toBe(false);
    expect(doc.activeElement).not.toBeNull();

    // Press Escape on document even if focus is outside root -> closes popover & restores focus to modelChip
    doc.activeElement = doc.body;
    doc.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('.t3c-model-popover')?.hidden).toBe(true);
    expect(modelChip.getAttribute('aria-expanded')).toBe('false');
    expect(doc.activeElement).toBe(modelChip);

    // Open usage popover -> honest 'CLI 暂未提供数据' message
    root.querySelector('.t3c-usage-chip')!.click();
    expect(root.querySelector('.t3c-usage-popover')?.textContent).toContain('CLI 暂未提供数据');

    // Open existing CLI thread -> permissions popover shows T3 Code link, connected action error surfaces on missing note
    await (view as unknown as { switchThread: (thread?: CliThread) => Promise<void> }).switchThread(activeThread);
    await flush();
    const mountedChildren = [...((view as unknown as { children: Array<{ unloaded: boolean }> }).children ?? [])];
    expect(mountedChildren.length).toBeGreaterThan(0);
    const msgRows = root.querySelectorAll('.t3c-msg');
    expect(msgRows[0]!.getAttribute('aria-label')).toBe('你的消息');
    expect(msgRows[1]!.getAttribute('aria-label')).toBeNull();

    (app.workspace as unknown as { getMostRecentLeaf: () => null }).getMostRecentLeaf = () => null;
    root.querySelector('[aria-label="插入当前光标处"]')!.click();
    await flush();
    const banner = root.querySelector('.t3c-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.getAttribute('data-tone')).toBe('error');
    expect(root.querySelector('.t3c-banner-text')?.textContent).toContain('请先打开要插入内容的 Markdown 笔记');

    const permChip = root.querySelector('.t3c-perm-chip')!;
    permChip.click();
    expect(root.querySelector('.t3c-perm-popover')?.textContent).toContain('T3 Code');

    const draft = root.querySelector('.t3c-textarea')!;
    draft.value = 'Carry this draft over';
    draft.dispatchEvent(new FakeEvent('input'));

    modelChip.click();
    expect(root.querySelector('.t3c-mp-locked')?.textContent).toContain('当前会话模型已固定');
    root.querySelector('.t3c-solid-btn')!.click();
    await flush();

    // Clones draft in same tab, clearing threadId and opening the 3-column selector (and disposing old row Component)
    expect(root.querySelectorAll('.t3c-tab-badge')).toHaveLength(1);
    expect(draft.value).toBe('Carry this draft over');
    expect(root.querySelector('.t3c-mp-agents')).not.toBeNull();
    expect(mountedChildren.every(c => c.unloaded)).toBe(true);

    // Switch back to thread then close view -> verifies onClose unloads active row Component too
    await (view as unknown as { switchThread: (thread?: CliThread) => Promise<void> }).switchThread(activeThread);
    await flush();
    const activeChildren = [...((view as unknown as { children: Array<{ unloaded: boolean }> }).children ?? [])];
    expect(activeChildren.length).toBeGreaterThan(0);
    await view.onClose();
    expect(activeChildren.every(c => c.unloaded)).toBe(true);
  });

  it('automatically falls back to CLI with retry banner when RPC fails and allows upgrading to RPC', async () => {
    cliMocks.listThreads.mockResolvedValue([makeThread()]);
    let rpcUp = false;
    const rpcCaps: BackendCapabilities = {
      mode: 'rpc',
      supportsLiveCatalog: true,
      supportsProviderRefresh: true,
      supportsStreaming: true,
      supportsStop: true,
      supportsMidThreadModelSwitch: true,
      supportsRuntimeModeSwitch: true,
      supportsInteractionModeSwitch: true,
      supportsApprovals: true,
      supportsContextUsage: true,
      supportsQuotaUsage: true,
    };
    const fakeRpc = {
      mode: 'rpc',
      connect: vi.fn(async () => {
        if (!rpcUp) throw new Error('T3 Server 不可达 Bearer hidden-tok');
        return rpcCaps;
      }),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [makeThread()]),
      openThread: vi.fn(async () => ({ unsubscribe: () => undefined })),
      getPendingThreadIdForCommand: vi.fn(() => undefined),
    } as unknown as RpcBackend;

    const { view, root } = setupView(
      { backendPreference: 'auto' },
      p => new T3BackendManager({ getSettings: () => p.settings, rpcBackend: fakeRpc }),
    );
    await view.onOpen();
    await waitReady(view);

    const banner = root.querySelector('.t3c-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.getAttribute('data-tone')).toBe('warning');
    expect(root.querySelector('.t3c-banner-text')?.textContent).toContain('CLI 降级模式');
    expect(root.querySelector('.t3c-banner-text')?.textContent).not.toContain('hidden-tok');

    rpcUp = true;
    root.querySelector('.t3c-banner-actions')!.querySelector('button')!.click();
    await waitUntil(() => banner.hidden === true);
    expect(banner.hidden).toBe(true);
    await view.onClose();
  });

  it('drives live RPC multi-Agent catalog, 240° gauge arc, streaming + Stop, inline approval card, Vault lock, and idempotent retry', async () => {
    const store = new T3Store();
    const providers: ProviderDescriptor[] = [
      {
        instanceId: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: true,
        supportedRuntimeModes: ['approval-required', 'full-access'],
        showInteractionModeToggle: true,
        quota: { status: 'unsupported', reason: 'unsupported', windows: [] },
        models: [{
          providerId: 'codex',
          slug: 'gpt-6-astra',
          name: 'GPT-6 Astra',
          isDefault: true,
          reasoningOption: {
            id: 'reasoningEffort',
            type: 'select',
            label: 'Reasoning',
            options: [{ id: 'high', label: 'High', isDefault: true }],
          },
          extraOptions: [],
        }],
      },
      {
        instanceId: 'claudeAgent',
        driver: 'claudeAgent',
        displayName: 'Claude',
        enabled: true,
        installed: true,
        status: 'ready',
        reportsContextWindow: true,
        supportedRuntimeModes: ['approval-required'],
        showInteractionModeToggle: true,
        quota: { status: 'unknown', windows: [] },
        models: [{
          providerId: 'claudeAgent',
          slug: 'claude-sonnet-4-6',
          name: 'Claude Sonnet',
          reasoningOption: {
            id: 'effort',
            type: 'select',
            label: 'Reasoning',
            options: [{ id: 'ultrathink', label: 'Max' }],
          },
          extraOptions: [{ id: 'fastMode', type: 'boolean', label: 'Fast Mode', currentValue: false }],
        }],
      },
    ];
    const rpcCaps: BackendCapabilities = {
      mode: 'rpc',
      supportsLiveCatalog: true,
      supportsProviderRefresh: true,
      supportsStreaming: true,
      supportsStop: true,
      supportsMidThreadModelSwitch: true,
      supportsRuntimeModeSwitch: true,
      supportsInteractionModeSwitch: true,
      supportsApprovals: true,
      supportsContextUsage: true,
      supportsQuotaUsage: true,
    };

    const thread = makeThread({ threadId: 'th-rpc', title: 'Live RPC Session', runtimeMode: 'approval-required', status: 'idle' });
    let threadListener: ((ev: BackendEvent) => void) | undefined;
    let dropFirstSend = true;
    const respondMock = vi.fn(async () => undefined);
    const stopMock = vi.fn(async () => undefined);
    const setModelMock = vi.fn(async () => undefined);
    const refreshProvidersMock = vi.fn(async () => providers);
    const hasMessageOnServerMock = vi.fn(async () => false);

    const fakeRpc = {
      mode: 'rpc',
      connect: vi.fn(async () => rpcCaps),
      disconnect: vi.fn(async () => undefined),
      getProviders: refreshProvidersMock,
      listThreads: vi.fn(async () => [thread]),
      openThread: vi.fn(async (_id: string, cb: (ev: BackendEvent) => void) => {
        threadListener = cb;
        const initial: ThreadDetail = {
          thread,
          messages: [{ id: 'm1', role: 'user', text: 'hi', streaming: false }],
          turnItems: [{ id: 'ti-1', type: 'command', title: 'rg', status: 'running' }],
          runtimeRequests: [],
          contextUsage: { status: 'available', usedTokens: 40_000, maxTokens: 100_000, percent: 40 },
          runIds: ['run-1'],
          lastSequence: 10,
          synchronized: true,
        };
        store.setThreadDetail('th-rpc', initial);
        cb({ type: 'thread.detail', detail: initial });
        return { unsubscribe: () => undefined };
      }),
      sendMessage: vi.fn(async () => {
        if (dropFirstSend) {
          dropFirstSend = false;
          throw new UncertainWriteError('发送过程中连接断开。');
        }
        return { threadId: 'th-rpc' };
      }),
      stopThread: stopMock,
      setModelSelection: setModelMock,
      setRuntimeMode: vi.fn(async () => undefined),
      setInteractionMode: vi.fn(async () => undefined),
      respondRuntimeRequest: respondMock,
      hasMessageOnServer: hasMessageOnServerMock,
      getPendingThreadIdForCommand: vi.fn(() => 'th-rpc'),
    } as unknown as RpcBackend;

    let seq = 0;
    const { view, root } = setupView(
      { projectPath: vaultDir, backendPreference: 'auto' },
      p => new T3BackendManager({
        getSettings: () => p.settings,
        store,
        rpcBackend: fakeRpc,
        randomId: () => `id-${++seq}`,
      }),
    );

    await view.onOpen();
    await waitReady(view);
    await (view as unknown as { switchThread: (t?: CliThread) => Promise<void> }).switchThread(thread);
    await flush();

    // 240° SVG gauge displays 40% & popover honestly displays unsupported quota
    expect(root.querySelector('.t3c-usage-pct')?.textContent).toBe('40%');
    expect(root.querySelector('.t3c-usage-arc')?.hidden).toBe(false);
    root.querySelector('.t3c-usage-chip')!.click();
    expect(root.querySelector('.t3c-usage-popover')?.textContent).toContain('暂不支持额度查询');

    // Vault overlap disables non-approval-required mode switches
    root.querySelector('.t3c-perm-chip')!.click();
    const permButtons = root.querySelector('.t3c-perm-popover')!.querySelectorAll('button');
    expect(permButtons.find(b => b.textContent.includes('完全访问'))?.disabled).toBe(true);

    // Mid-thread model switching & provider refresh works live
    root.querySelector('.t3c-model-chip')!.click();
    root.querySelector('.t3c-mp-refresh')!.click();
    await flush();
    expect(refreshProvidersMock).toHaveBeenCalledWith(true);

    const claudeBtn = root.querySelectorAll('.t3c-mp-agent-btn').find(b => b.getAttribute('aria-label') === 'claudeAgent')!;
    claudeBtn.click();
    root.querySelector('.t3c-mp-model-row')!.click();
    await flush();
    expect(setModelMock).toHaveBeenCalledWith('th-rpc', expect.any(String), expect.objectContaining({
      instanceId: 'claudeAgent',
      model: 'claude-sonnet-4-6',
    }));

    // Streaming + Stop button + inline approval card (without feedback box when supportsFeedback is false)
    const streamingDetail: ThreadDetail = {
      thread: { ...thread, status: 'waiting', pendingRequestCount: 1 },
      messages: [
        { id: 'm1', role: 'user', text: 'hi', streaming: false },
        { id: 'm2', role: 'assistant', text: 'Streaming reply…', streaming: true },
      ],
      turnItems: [{ id: 'ti-1', type: 'command', title: 'npm test', status: 'running' }],
      runtimeRequests: [{ id: 'req-1', threadId: 'th-rpc', kind: 'command', status: 'pending', command: 'echo ok', supportsFeedback: false }],
      contextUsage: { status: 'available', usedTokens: 40_000, maxTokens: 100_000, percent: 40 },
      activeRunId: 'run-live',
      runIds: ['run-live'],
      lastSequence: 11,
      synchronized: true,
    };
    store.setThreadDetail('th-rpc', streamingDetail);
    threadListener?.({ type: 'thread.detail', detail: streamingDetail });
    await flush();

    const stopBtn = root.querySelector('.t3c-stop-btn')!;
    expect(stopBtn.hidden).toBe(false);
    stopBtn.click();
    await flush();
    expect(stopMock).toHaveBeenCalledWith('th-rpc', expect.any(String), 'run-live');

    expect(root.querySelector('.t3c-turn-pill')?.textContent).toContain('npm test');
    expect(root.querySelector('.t3c-approval-card')).not.toBeNull();
    expect(root.querySelector('.t3c-approval-feedback')).toBeNull();
    const declineBtn = root.querySelector('.t3c-approval-actions')!.querySelectorAll('button').find(b => b.textContent === '拒绝')!;
    declineBtn.click();
    await flush();
    expect(respondMock).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1', decision: 'decline' }));

    // Clear active run so send is enabled, then trigger UncertainWriteError -> keeps draft & retries idempotently
    const idleDetail: ThreadDetail = { ...streamingDetail, thread: { ...thread, status: 'idle', pendingRequestCount: 0 }, runtimeRequests: [], activeRunId: undefined };
    store.setThreadDetail('th-rpc', idleDetail);
    threadListener?.({ type: 'thread.detail', detail: idleDetail });
    await flush();

    const draft = root.querySelector('.t3c-textarea')!;
    draft.value = 'Critical prompt';
    draft.dispatchEvent(new FakeEvent('input'));
    root.querySelector('.t3c-send-btn')!.click();
    await waitUntil(() => root.querySelector('.t3c-banner')?.hidden === false);
    expect(draft.value).toBe('Critical prompt');

    root.querySelector('.t3c-banner-actions')!.querySelector('button')!.click();
    await waitUntil(() => draft.value === '');
    expect(hasMessageOnServerMock).toHaveBeenCalled();

    await view.onClose();
  });

  it('recovers uncertain dispatch across fallback-cli retry without deadlocking, keeps approval feedback DOM across streams, releases store detail on switch/close, and survives early tab close during check()', async () => {
    const store = new T3Store();
    const rpcCaps: BackendCapabilities = {
      mode: 'rpc',
      supportsLiveCatalog: true,
      supportsProviderRefresh: false,
      supportsStreaming: true,
      supportsStop: true,
      supportsMidThreadModelSwitch: true,
      supportsRuntimeModeSwitch: true,
      supportsInteractionModeSwitch: true,
      supportsApprovals: true,
      supportsContextUsage: true,
      supportsQuotaUsage: true,
    };
    let rpcReachable = true;
    let shouldDropSend = true;
    let detailListener: ((ev: BackendEvent) => void) | undefined;
    const threadA = makeThread({ threadId: 'th-a', title: 'Thread A', runtimeMode: 'approval-required', status: 'waiting', pendingRequestCount: 1 });

    const fakeRpc = {
      mode: 'rpc',
      connect: vi.fn(async () => {
        if (!rpcReachable) throw new Error('offline');
        return rpcCaps;
      }),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => []),
      listThreads: vi.fn(async () => [threadA]),
      openThread: vi.fn(async (id: string, cb: (ev: BackendEvent) => void) => {
        detailListener = cb;
        const det: ThreadDetail = {
          thread: threadA,
          messages: [{ id: 'm1', role: 'assistant', text: 'Need approval', streaming: true }],
          turnItems: [],
          runtimeRequests: [{ id: 'req-fb', threadId: id, kind: 'command', status: 'pending', command: 'echo 1', supportsFeedback: true }],
          contextUsage: { status: 'unknown' },
          runIds: [],
          lastSequence: 1,
          synchronized: true,
        };
        store.setThreadDetail(id, det);
        cb({ type: 'thread.detail', detail: det });
        return { unsubscribe: () => undefined };
      }),
      sendMessage: vi.fn(async () => {
        if (shouldDropSend) {
          shouldDropSend = false;
          throw new UncertainWriteError('dropped mid-send');
        }
        return { threadId: 'th-a' };
      }),
      inspectPendingWrite: vi.fn(async () => 'committed' as const),
      hasMessageOnServer: vi.fn(async () => true),
      getPendingThreadIdForCommand: vi.fn(() => undefined),
    } as unknown as RpcBackend;

    const { view, root } = setupView(
      { projectPath: vaultDir, backendPreference: 'auto' },
      p => new T3BackendManager({ getSettings: () => p.settings, store, rpcBackend: fakeRpc }),
    );
    await view.onOpen();
    await waitReady(view);

    // Early tab close while check() is pending must NOT prevent view ready state
    let resolveDelayedConnect: (() => void) | undefined;
    (fakeRpc.connect as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<BackendCapabilities>(r => { resolveDelayedConnect = () => r(rpcCaps); }),
    );
    const recheckPromise = (view as unknown as { check: () => Promise<void> }).check();
    root.querySelector('[aria-label="新开标签页"]')!.click();
    await flush();
    root.querySelector('.t3c-tab-badge-select')!.click();
    await flush();
    root.querySelector('.t3c-tab-badge-close')!.click();
    resolveDelayedConnect?.();
    await recheckPromise;
    expect((view as unknown as { ready: boolean }).ready).toBe(true);

    // Verify feedback input node identity survives unrelated streaming updates
    await (view as unknown as { switchThread: (t?: CliThread) => Promise<void> }).switchThread(threadA);
    await flush();
    const feedbackInput = root.querySelector('.t3c-approval-feedback')!;
    expect(feedbackInput).not.toBeNull();
    detailListener?.({
      type: 'thread.detail',
      detail: {
        ...store.getSnapshot().activeThreadDetails.get('th-a')!,
        messages: [{ id: 'm1', role: 'assistant', text: 'Need approval updated text', streaming: true }],
      },
    });
    await flush();
    expect(root.querySelector('.t3c-approval-feedback')).toBe(feedbackInput);

    // Send on idle state throws UncertainWriteError, then simulates CLI fallback -> Banner Retry stays visible and recovers RPC
    detailListener?.({
      type: 'thread.detail',
      detail: { ...store.getSnapshot().activeThreadDetails.get('th-a')!, thread: { ...threadA, status: 'idle', pendingRequestCount: 0 }, runtimeRequests: [] },
    });
    await flush();
    const draft = root.querySelector('.t3c-textarea')!;
    draft.value = 'Uncertain message';
    draft.dispatchEvent(new FakeEvent('input'));
    root.querySelector('.t3c-send-btn')!.click();
    await waitUntil(() => root.querySelector('.t3c-banner')?.hidden === false);

    // Force manager to fallback-cli, click Retry while still unreachable -> Retry button remains visible (not deadlocked)
    rpcReachable = false;
    cliMocks.listThreads.mockResolvedValue([threadA]);
    const manager = (view as unknown as { backendManager: T3BackendManager }).backendManager;
    await manager.retryRpc();
    await flush();
    const retryBtn = root.querySelector('.t3c-banner-actions')!.querySelector('button')!;
    expect(retryBtn.hidden).toBe(false);
    retryBtn.click();
    await flush();
    expect(root.querySelector('.t3c-banner-actions')!.querySelector('button')!.hidden).toBe(false);

    // Bring RPC back -> clicking Retry upgrades to RPC & deduplicates pending dispatch cleanly
    rpcReachable = true;
    root.querySelector('.t3c-banner-actions')!.querySelector('button')!.click();
    await waitUntil(() => draft.value === '');

    // Switching back to new thread releases unused activeThreadDetail from store
    expect(store.getSnapshot().activeThreadDetails.has('th-a')).toBe(true);
    await (view as unknown as { switchThread: (t?: CliThread) => Promise<void> }).switchThread(undefined);
    expect(store.getSnapshot().activeThreadDetails.has('th-a')).toBe(false);

    await view.onClose();
  });

  it('subscribes & awaits sync before new-thread dispatch, keeps bodyEl & scrollTop across streaming completion, preserves filter focus, and isolates two leaves', async () => {
    const store = new T3Store();
    const order: string[] = [];
    let activeListener: ((ev: BackendEvent) => void) | undefined;
    const rpcCaps: BackendCapabilities = {
      mode: 'rpc',
      supportsLiveCatalog: true,
      supportsProviderRefresh: true,
      supportsStreaming: true,
      supportsStop: true,
      supportsMidThreadModelSwitch: true,
      supportsRuntimeModeSwitch: true,
      supportsInteractionModeSwitch: true,
      supportsApprovals: true,
      supportsContextUsage: true,
      supportsQuotaUsage: true,
    };
    const providerOne: ProviderDescriptor[] = [{
      instanceId: 'codex',
      driver: 'codex',
      displayName: 'Codex',
      enabled: true,
      installed: true,
      status: 'ready',
      reportsContextWindow: true,
      supportedRuntimeModes: ['approval-required'],
      showInteractionModeToggle: true,
      quota: { status: 'unsupported', windows: [] },
      models: [{ providerId: 'codex', slug: 'gpt-6-astra', name: 'GPT-6 Astra', extraOptions: [] }],
    }];

    const fakeRpc = {
      mode: 'rpc',
      connect: vi.fn(async () => rpcCaps),
      disconnect: vi.fn(async () => undefined),
      getProviders: vi.fn(async () => providerOne),
      listThreads: vi.fn(async () => []),
      openThread: vi.fn(async (tid: string, cb: (ev: BackendEvent) => void) => {
        activeListener = cb;
        order.push(`openThread:${tid}`);
        const snap: ThreadDetail = {
          thread: makeThread({ threadId: tid, status: 'idle', runtimeMode: 'approval-required' }),
          messages: [],
          turnItems: [],
          runtimeRequests: [],
          contextUsage: { status: 'unknown' },
          runIds: [],
          lastSequence: 1,
          synchronized: false,
        };
        store.setThreadDetail(tid, snap);
        cb({ type: 'thread.detail', detail: snap });
        queueMicrotask(() => {
          order.push(`synchronized:${tid}`);
          const synced: ThreadDetail = { ...snap, synchronized: true, lastSequence: 2 };
          store.setThreadDetail(tid, synced);
          cb({ type: 'thread.detail', detail: synced });
        });
        return { unsubscribe: () => undefined };
      }),
      sendMessage: vi.fn(async input => {
        order.push('thread.create:th-stream-new');
        await input.onThreadReady?.('th-stream-new');
        order.push('message.dispatch:th-stream-new');
        return { threadId: 'th-stream-new', sequence: 3 };
      }),
      getPendingThreadIdForCommand: vi.fn(() => undefined),
    } as unknown as RpcBackend;

    const { view, root, doc } = setupView(
      { projectPath: vaultDir, backendPreference: 'auto' },
      p => new T3BackendManager({ getSettings: () => p.settings, store, rpcBackend: fakeRpc }),
    );
    await view.onOpen();
    await waitReady(view);

    // Filter focus & caret survive provider catalog updates from store
    root.querySelector('.t3c-model-chip')!.click();
    const filterInput = root.querySelector('.t3c-mp-filter')!;
    filterInput.focus();
    filterInput.value = 'astra';
    filterInput.setSelectionRange(2, 5);
    filterInput.dispatchEvent(new FakeEvent('input'));
    store.setProviders([{ ...providerOne[0]! }]);
    const rebuiltFilter = root.querySelector('.t3c-mp-filter')!;
    expect(doc.activeElement).toBe(rebuiltFilter);
    expect(rebuiltFilter.selectionStart).toBe(2);
    expect(rebuiltFilter.selectionEnd).toBe(5);
    doc.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));

    // New-thread send awaits onThreadReady -> openThread -> synchronized BEFORE message.dispatch
    const draft = root.querySelector('.t3c-textarea')!;
    draft.value = 'Stream before dispatch';
    draft.dispatchEvent(new FakeEvent('input'));
    root.querySelector('.t3c-send-btn')!.click();
    await waitUntil(() => order.includes('message.dispatch:th-stream-new'));
    expect(order).toEqual([
      'thread.create:th-stream-new',
      'openThread:th-stream-new',
      'synchronized:th-stream-new',
      'message.dispatch:th-stream-new',
    ]);

    // Streaming delta builds markdown row; scrolled-up position stays anchored; completion keeps same bodyEl & adds actions
    const msgsEl = root.querySelector('.t3c-messages')!;
    msgsEl.scrollHeight = 800;
    msgsEl.clientHeight = 200;
    msgsEl.scrollTop = 100; // Scrolled up (800 - 100 - 200 = 500 >= 60)

    const deltaDetail: ThreadDetail = {
      thread: makeThread({ threadId: 'th-stream-new', status: 'running', runtimeMode: 'approval-required' }),
      messages: [
        { id: 'u1', role: 'user', text: 'Stream before dispatch', streaming: false },
        { id: 'a1', role: 'assistant', text: 'First chunk...', streaming: true },
      ],
      turnItems: [],
      runtimeRequests: [],
      contextUsage: { status: 'unknown' },
      activeRunId: 'run-1',
      runIds: ['run-1'],
      lastSequence: 4,
      synchronized: true,
    };
    store.setThreadDetail('th-stream-new', deltaDetail);
    activeListener?.({ type: 'thread.detail', detail: deltaDetail });
    await flush();

    const bodyBeforeDone = root.querySelectorAll('.t3c-msg')[1]!.querySelector('.t3c-markdown')!;
    expect(bodyBeforeDone).not.toBeNull();
    expect(msgsEl.scrollTop).toBe(100);

    const doneDetail: ThreadDetail = {
      ...deltaDetail,
      thread: makeThread({ threadId: 'th-stream-new', status: 'completed', runtimeMode: 'approval-required' }),
      messages: [
        { id: 'u1', role: 'user', text: 'Stream before dispatch', streaming: false },
        { id: 'a1', role: 'assistant', text: 'First chunk... final text.', streaming: false },
      ],
      activeRunId: undefined,
      lastSequence: 5,
    };
    store.setThreadDetail('th-stream-new', doneDetail);
    activeListener?.({ type: 'thread.detail', detail: doneDetail });
    await flush();

    const bodyAfterDone = root.querySelectorAll('.t3c-msg')[1]!.querySelector('.t3c-markdown')!;
    expect(bodyAfterDone).toBe(bodyBeforeDone);
    expect(root.querySelectorAll('.t3c-msg')[1]!.querySelector('.t3c-msg-actions')).not.toBeNull();
    expect(msgsEl.scrollTop).toBe(100);

    // M5: uncertain dispatch banner is scoped only to originating tab and clears pendingDispatches when closed
    const mgrInternal = (view as unknown as {
      tabs: Array<{ id: string; uncertainCommandId?: string }>;
      activeTab: { id: string; uncertainCommandId?: string };
      activateTab: (id: string) => void;
      closeTab: (id: string) => void;
    });
    const addTabBtn = root.querySelector('[aria-label="新开标签页"]')!;
    addTabBtn.click();
    await flush();
    expect(mgrInternal.tabs).toHaveLength(2);
    const tab1 = mgrInternal.tabs[0]!;
    const tab2 = mgrInternal.tabs[1]!;
    tab1.uncertainCommandId = 'cmd-uncertain-tab1';
    store.upsertPendingDispatch({
      commandId: 'cmd-uncertain-tab1',
      messageId: 'msg-uncertain-tab1',
      threadId: 'th-stream-new',
      createdNewThread: false,
      projectId: 'proj-1',
      text: 'retry me',
      status: 'uncertain',
      createdAt: 1,
    });
    await flush();
    // Tab 2 is active and has no uncertain dispatch -> banner must stay hidden
    expect(mgrInternal.activeTab.id).toBe(tab2.id);
    expect(root.querySelector('.t3c-banner')!.hidden).toBe(true);
    // Closing Tab 1 cleans pendingDispatches from store
    mgrInternal.closeTab(tab1.id);
    await flush();
    expect(store.getSnapshot().pendingDispatches.has('cmd-uncertain-tab1')).toBe(false);

    // Open a second isolated view instance sharing same plugin -> closing both disposes both cleanly
    const second = setupView({ projectPath: vaultDir, backendPreference: 'cli' });
    cliMocks.listThreads.mockResolvedValue([]);
    await second.view.onOpen();
    await waitReady(second.view);
    await Promise.all([view.onClose(), second.view.onClose()]);
  });
});
