import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { Component, FileSystemAdapter, FuzzySuggestModal, ItemView, MarkdownView, Notice, setIcon } from 'obsidian';
import type { TFile, WorkspaceLeaf } from 'obsidian';
import type ObsidianT3CodePlugin from '../main';
import { composePrompt } from '../context';
import { configuredModels } from '../settings';
import { redactSensitiveText } from '../t3/auth';
import {
  CLI_BACKEND_CAPABILITIES,
  type BackendModelSelection,
  type ContextUsageSnapshot,
  type RuntimeRequestItem,
  type ThreadDetail,
  type TurnItemSummary,
} from '../t3/backend';
import { T3BackendManager } from '../t3/backend-manager';
import type { CliThread, ModelSelection } from '../t3/cli';
import { UncertainWriteError } from '../t3/rpc-backend';
import type { T3StoreState } from '../t3/store';
import type { Message } from '../t3/transcript';
import { resolveWorkspacePath, workspacesOverlap } from '../t3/workspace';
import { renderSafeMarkdown } from './markdown';
import { composeAttachments } from './note-attachments';
import {
  ACTIVE_THREAD_STATUSES,
  buildModelCatalog,
  buildModelCatalogFromProviders,
  filterThreads,
  formatContextUsage,
  formatElapsedMs,
  formatModelTrigger,
  formatQuotaSummary,
  groupThreads,
  resolveLayoutMode,
  resolveStatusBanner,
  resolveTabBadgeStatus,
  type ModelCatalogItem,
  type SessionGroupMode,
} from './sidebar-model';

export const VIEW_TYPE_OBSIDIAN_T3_CODE = 'obsidian-t3-code-chat-view';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GAUGE_ARC_LENGTH = 23.88;
const MIN_WIDE_SIDEBAR_WIDTH = 180;
const MIN_CHAT_COL_WIDTH = 320;
const RESIZER_WIDTH = 5;
const RESIZE_KEY_STEP = 16;

interface RuntimeModeMeta {
  id: string;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
}

const RUNTIME_MODES: readonly RuntimeModeMeta[] = [
  { id: 'approval-required', label: '需要审批', shortLabel: '需审批', icon: 'lock', description: '执行命令与改动笔记前逐项确认（Vault 推荐）。' },
  { id: 'auto-accept-edits', label: '自动接受编辑', shortLabel: '自动编辑', icon: 'pen-line', description: '自动接受文件编辑，其他操作仍需审批。' },
  { id: 'auto', label: '自动', shortLabel: '自动', icon: 'shield-check', description: '由 Provider 按策略自动批准常规操作。' },
  { id: 'full-access', label: '完全访问', shortLabel: '完全访问', icon: 'shield-alert', description: '无需确认直接运行命令与写入文件。' },
];

interface SidebarTab {
  id: string;
  badgeNumber: number;
  threadId?: string;
  thread?: CliThread;
  selection?: ModelSelection;
  extraOptions: Record<string, string | boolean>;
  draft: string;
  notes: TFile[];
  messages: Message[];
  turnItems: TurnItemSummary[];
  runtimeRequests: RuntimeRequestItem[];
  contextUsage?: ContextUsageSnapshot;
  activeRunId?: string;
  uncertainCommandId?: string;
  unread: boolean;
  checking: boolean;
  busy: boolean;
  submitting: boolean;
  runStartedAt?: number;
  lastElapsedMs?: number;
  threadSub?: { unsubscribe: () => void };
  pendingFeedback: Map<string, string>;
  selectionRevision: number;
}

interface RowEntry {
  message: Message;
  element: HTMLElement;
  bodyEl?: HTMLElement;
  renderComponent?: Component;
  renderSeq: number;
  throttleTimer?: ReturnType<typeof setTimeout>;
  lastRenderAt: number;
  lastRenderedText?: string;
}

export type BackendManagerFactory = (plugin: ObsidianT3CodePlugin) => T3BackendManager;

export default class ObsidianT3CodeView extends ItemView {
  private readonly rows = new Map<string, RowEntry>();
  private tabs: SidebarTab[] = [];
  private activeTabId = '';
  private nextTabNumber = 1;
  private visible = false;
  private ready = false;
  private workspaceValidated = false;
  private actionError?: string;
  private backendRevision = 0;
  private cachedThreads: CliThread[] = [];
  private threadsLoaded = false;
  private historyQuery = '';
  private groupMode: SessionGroupMode = 'time';
  private wideSidebarWidth = 220;
  private browseProvider = '';
  private modelFilterQuery = '';
  private openPopover: 'history' | 'model' | 'usage' | 'perm' | null = null;
  private wideSearchVisible = false;

  private backendManager?: T3BackendManager;
  private storeUnsub?: () => void;
  private storeState: T3StoreState = {
    connectionPhase: 'idle',
    capabilities: { ...CLI_BACKEND_CAPABILITIES },
    providers: [],
    threads: [],
    activeThreadDetails: new Map(),
    pendingDispatches: new Map(),
  };

  private resizeObserver?: ResizeObserver;
  private elapsedTimer?: ReturnType<typeof setInterval>;
  private resizeCleanup?: () => void;
  private vaultOverlapCache?: { vaultPath: string; projectPath: string; overlaps: boolean };

  private rootEl!: HTMLElement;
  private resizerEl!: HTMLElement;
  private wideSidebarEl!: HTMLElement;
  private wideSearchWrapEl!: HTMLElement;
  private wideSearchInput!: HTMLInputElement;
  private wideProjectEl!: HTMLElement;
  private wideGroupBtn!: HTMLButtonElement;
  private wideListEl!: HTMLElement;

  private welcomeEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private turnItemsEl!: HTMLElement;
  private approvalAreaEl!: HTMLElement;
  private runIndicatorEl!: HTMLElement;
  private navRailEl!: HTMLElement;
  private tabBadgesEl!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  private historyPopover!: HTMLElement;
  private historySearchInput!: HTMLInputElement;
  private historyGroupBtn!: HTMLButtonElement;
  private historyListEl!: HTMLElement;

  private bannerEl!: HTMLElement;
  private bannerTextEl!: HTMLElement;
  private bannerRetryBtn!: HTMLButtonElement;
  private bannerLinkEl!: HTMLAnchorElement;

  private contextTrayEl!: HTMLElement;
  private draftEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private modelChipBtn!: HTMLButtonElement;
  private modelIconEl!: HTMLElement;
  private modelPrimaryEl!: HTMLElement;
  private modelSecondaryEl!: HTMLElement;
  private modelPopover!: HTMLElement;
  private usageChipBtn!: HTMLButtonElement;
  private usageArcEl!: SVGPathElement;
  private usageLabelEl!: HTMLElement;
  private usagePopover!: HTMLElement;
  private permChipBtn!: HTMLButtonElement;
  private permIconEl!: HTMLElement;
  private permLabelEl!: HTMLElement;
  private permPopover!: HTMLElement;
  private noteFooterBtn!: HTMLButtonElement;
  private noteFooterLabelEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ObsidianT3CodePlugin,
    private readonly createBackendManager?: BackendManagerFactory,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_OBSIDIAN_T3_CODE; }
  getDisplayText(): string { return 'T3-Codian'; }

  private ensureManager(): T3BackendManager {
    if (!this.backendManager) {
      this.backendManager = this.createBackendManager?.(this.plugin) ?? new T3BackendManager({
        getSettings: () => this.plugin.settings,
      });
    }
    return this.backendManager;
  }

  private get activeTab(): SidebarTab {
    return this.tabs.find(tab => tab.id === this.activeTabId) ?? this.tabs[0];
  }

  private getModelGroups() {
    if (this.storeState.capabilities.supportsLiveCatalog && this.storeState.providers.length > 0) {
      return buildModelCatalogFromProviders(this.storeState.providers);
    }
    return buildModelCatalog(configuredModels(this.plugin.settings));
  }

  private createTab(seed?: { draft?: string; notes?: TFile[]; selection?: ModelSelection }): SidebarTab {
    const num = this.nextTabNumber++;
    const defaultSel = seed?.selection ?? configuredModels(this.plugin.settings)[0];
    return {
      id: `tab-${num}`,
      badgeNumber: num,
      selection: defaultSel,
      extraOptions: {},
      draft: seed?.draft ?? '',
      notes: seed?.notes ? [...seed.notes] : [],
      messages: [],
      turnItems: [],
      runtimeRequests: [],
      unread: false,
      checking: false,
      busy: false,
      submitting: false,
      pendingFeedback: new Map(),
      selectionRevision: 0,
    };
  }

  private abortTab(tab: SidebarTab): void {
    tab.threadSub?.unsubscribe();
    tab.threadSub = undefined;
  }

  private isStaleTab(tab: SidebarTab, rev: number, selectionRevision: number): boolean {
    return rev !== this.backendRevision
      || !this.visible
      || !this.tabs.includes(tab)
      || tab.selectionRevision !== selectionRevision;
  }

  async onOpen(): Promise<void> {
    this.visible = true;
    const manager = this.ensureManager();
    this.storeState = manager.store.getSnapshot();
    this.storeUnsub?.();
    this.storeUnsub = manager.store.subscribe(state => this.handleStoreUpdate(state));

    const root = this.contentEl;
    this.rootEl = root;
    root.empty();
    root.addClass('obsidian-t3-code');
    if (this.tabs.length === 0) {
      const initial = this.createTab();
      this.tabs = [initial];
      this.activeTabId = initial.id;
    }

    const chatCol = root.createDiv({ cls: 't3c-chat-col' });
    this.buildMessageArea(chatCol);
    this.buildComposerArea(chatCol);

    this.resizerEl = root.createDiv({
      cls: 't3c-resizer',
      attr: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '调整会话栏宽度', tabindex: '0' },
    });
    this.buildWideSidebar(root);
    this.bindGlobalEvents(root);
    this.setupResizeObserver(root);
    this.backendChanged();
  }

  async onClose(): Promise<void> {
    this.visible = false;
    this.openPopover = null;
    this.vaultOverlapCache = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.stopResize();
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
    this.storeUnsub?.();
    this.storeUnsub = undefined;
    for (const tab of this.tabs) this.abortTab(tab);
    for (const entry of this.rows.values()) this.disposeRow(entry);
    this.rows.clear();
    await this.backendManager?.dispose();
  }

  async pairWithCode(code: string): Promise<void> {
    const manager = this.ensureManager();
    await manager.pairWithCode(code);
    this.actionError = undefined;
    await this.check();
  }

  private handleStoreUpdate(state: T3StoreState): void {
    this.storeState = state;
    this.cachedThreads = state.threads;
    if (state.connectionPhase === 'connected-rpc' || state.connectionPhase === 'fallback-cli') {
      this.threadsLoaded = true;
      if (this.workspaceValidated) this.ready = true;
    } else if (state.connectionPhase === 'disconnected') {
      this.ready = false;
    }

    for (const tab of this.tabs) {
      if (!tab.threadId) continue;
      const summary = state.threads.find(t => t.threadId === tab.threadId);
      if (summary) tab.thread = summary;
      const detail = state.activeThreadDetails.get(tab.threadId);
      if (detail) this.syncTabFromDetail(tab, detail);
    }

    if (!this.visible) return;
    if (this.openPopover === 'model') this.renderModelPopover();
    if (this.openPopover === 'usage') this.renderUsagePopover();
    if (this.openPopover === 'perm') this.renderPermPopover();
    this.updateRunTimer();
    this.refreshControls();
  }

  private syncTabFromDetail(tab: SidebarTab, detail: ThreadDetail): void {
    const wasBusy = tab.busy;
    tab.thread = detail.thread;
    tab.messages = detail.messages;
    tab.turnItems = detail.turnItems;
    tab.runtimeRequests = detail.runtimeRequests;
    tab.contextUsage = detail.contextUsage;
    tab.activeRunId = detail.activeRunId;
    if (detail.thread.providerInstanceId && detail.thread.model && !tab.selection) {
      tab.selection = { provider: detail.thread.providerInstanceId, model: detail.thread.model };
    }
    const activeByServer = ACTIVE_THREAD_STATUSES.has(detail.thread.status) || Boolean(detail.activeRunId);
    tab.busy = tab.submitting || (!tab.uncertainCommandId && activeByServer);
    if (tab.busy && !tab.runStartedAt) tab.runStartedAt = Date.now();
    if (!tab.busy && wasBusy && tab.runStartedAt) {
      tab.lastElapsedMs = Date.now() - tab.runStartedAt;
      tab.runStartedAt = undefined;
      if (tab !== this.activeTab) tab.unread = true;
    }
    if (tab === this.activeTab && this.visible) {
      this.renderMessages(tab.messages);
      this.renderTurnItems(tab.turnItems);
      this.renderApprovalCards(tab);
    }
  }

  private disposeRow(entry: RowEntry): void {
    clearTimeout(entry.throttleTimer);
    entry.throttleTimer = undefined;
    entry.renderSeq++;
    if (entry.renderComponent) {
      this.removeChild(entry.renderComponent);
      entry.renderComponent.unload();
      entry.renderComponent = undefined;
    }
  }

  private buildMessageArea(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 't3c-messages-wrap' });
    this.welcomeEl = wrap.createDiv({ cls: 't3c-welcome' });
    setIcon(this.welcomeEl.createDiv({ cls: 't3c-welcome-icon' }), 'message-square');
    this.welcomeEl.createEl('strong', { text: '开始新对话' });
    this.welcomeEl.createEl('p', { text: '提出问题，或通过 @ 提及知识库中的笔记。' });

    this.messagesEl = wrap.createDiv({ cls: 't3c-messages', attr: { role: 'log', 'aria-live': 'off' } });
    this.messagesEl.hidden = true;
    this.turnItemsEl = wrap.createDiv({ cls: 't3c-turn-items' });
    this.turnItemsEl.hidden = true;
    this.approvalAreaEl = wrap.createDiv({ cls: 't3c-approval-area' });
    this.approvalAreaEl.hidden = true;
    this.runIndicatorEl = wrap.createDiv({ cls: 't3c-run-indicator' });
    this.runIndicatorEl.hidden = true;

    this.navRailEl = wrap.createDiv({ cls: 't3c-nav-rail' });
    this.navRailEl.hidden = true;
    const topBtn = this.iconButton(this.navRailEl, 'chevrons-up', '回到顶部', () => { this.messagesEl.scrollTop = 0; });
    topBtn.addClass('t3c-nav-btn');
    const bottomBtn = this.iconButton(this.navRailEl, 'chevrons-down', '回到底部', () => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
    bottomBtn.addClass('t3c-nav-btn');
  }

  private buildPopovers(parent: HTMLElement): void {
    this.historyPopover = parent.createDiv({ cls: 't3c-popover t3c-history-popover', attr: { role: 'dialog', 'aria-label': '会话历史', tabindex: '-1' } });
    this.historyPopover.hidden = true;
    const hHead = this.historyPopover.createDiv({ cls: 't3c-popover-head' });
    this.historySearchInput = hHead.createEl('input', { attr: { type: 'search', placeholder: '搜索会话…', 'aria-label': '搜索会话' } });
    this.historySearchInput.oninput = () => {
      this.historyQuery = this.historySearchInput.value;
      this.renderSessionLists();
    };
    this.historyGroupBtn = this.button(hHead, '时间', () => this.toggleGroupMode());
    this.historyGroupBtn.addClass('t3c-mini-btn');
    this.iconButton(hHead, 'refresh-cw', '刷新会话列表', () => this.refreshThreadList(true));
    this.historyListEl = this.historyPopover.createDiv({ cls: 't3c-history-list' });

    this.modelPopover = parent.createDiv({ cls: 't3c-popover t3c-model-popover', attr: { role: 'dialog', 'aria-label': 'Agent · 模型 · 思考度', tabindex: '-1' } });
    this.modelPopover.hidden = true;

    this.usagePopover = parent.createDiv({ cls: 't3c-popover t3c-usage-popover', attr: { role: 'dialog', 'aria-label': '上下文与账号额度', tabindex: '-1' } });
    this.usagePopover.hidden = true;

    this.permPopover = parent.createDiv({ cls: 't3c-popover t3c-perm-popover', attr: { role: 'dialog', 'aria-label': '运行权限说明', tabindex: '-1' } });
    this.permPopover.hidden = true;
  }

  private buildComposerArea(parent: HTMLElement): void {
    const area = parent.createDiv({ cls: 't3c-composer-area' });

    const navRow = area.createDiv({ cls: 't3c-input-nav-row' });
    this.tabBadgesEl = navRow.createDiv({ cls: 't3c-tab-badges' });
    const navActions = navRow.createDiv({ cls: 't3c-nav-actions' });
    this.iconButton(navActions, 'plus', '新开标签页', () => this.openNewTab());
    this.iconButton(navActions, 'square-pen', '当前标签新建会话', () => this.switchThread(undefined));
    this.historyBtn = this.iconButton(navActions, 'history', '会话历史', () => this.togglePopover('history'));
    this.historyBtn.setAttribute('aria-haspopup', 'dialog');
    this.historyBtn.setAttribute('aria-expanded', 'false');

    this.bannerEl = area.createDiv({ cls: 't3c-banner', attr: { role: 'status' } });
    this.bannerEl.hidden = true;
    this.bannerTextEl = this.bannerEl.createSpan({ cls: 't3c-banner-text' });
    const bannerActions = this.bannerEl.createDiv({ cls: 't3c-banner-actions' });
    this.bannerRetryBtn = this.button(bannerActions, '重试', () => this.retryFromBanner());
    this.bannerLinkEl = bannerActions.createEl('a', { text: '在 T3 Code 中打开 ↗', attr: { target: '_blank', rel: 'noopener noreferrer' } });

    const dock = area.createDiv({ cls: 't3c-composer-dock' });
    this.buildPopovers(dock);
    const wrapper = dock.createDiv({ cls: 't3c-input-wrapper' });
    this.contextTrayEl = wrapper.createDiv({ cls: 't3c-context-tray' });
    this.contextTrayEl.hidden = true;

    const taRow = wrapper.createDiv({ cls: 't3c-textarea-row' });
    this.draftEl = taRow.createEl('textarea', {
      cls: 't3c-textarea',
      placeholder: '提出修改要求、@ 提及笔记…',
      attr: { 'aria-label': '消息', rows: '2' },
    });
    this.stopBtn = this.iconButton(taRow, 'square', '停止运行', () => this.stopCurrentRun());
    this.stopBtn.addClass('t3c-stop-btn');
    this.stopBtn.hidden = true;
    this.sendBtn = this.iconButton(taRow, 'arrow-up', '发送消息', () => this.send());
    this.sendBtn.addClass('t3c-send-btn');

    const toolbar = wrapper.createDiv({ cls: 't3c-toolbar' });
    this.modelChipBtn = toolbar.createEl('button', { cls: 't3c-chip t3c-model-chip', attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } });
    this.modelIconEl = this.modelChipBtn.createSpan({ cls: 't3c-chip-ico' });
    this.modelPrimaryEl = this.modelChipBtn.createSpan({ cls: 't3c-chip-primary' });
    this.modelSecondaryEl = this.modelChipBtn.createSpan({ cls: 't3c-chip-secondary' });
    setIcon(this.modelChipBtn.createSpan({ cls: 't3c-chip-chev' }), 'chevron-down');
    this.modelChipBtn.onclick = () => this.togglePopover('model');

    this.usageChipBtn = toolbar.createEl('button', { cls: 't3c-chip t3c-usage-chip', attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': '上下文与账号额度' } });
    this.buildUsageGauge(this.usageChipBtn);
    this.usageLabelEl = this.usageChipBtn.createSpan({ cls: 't3c-usage-pct', text: '—' });
    this.usageChipBtn.onclick = () => this.togglePopover('usage');

    this.permChipBtn = toolbar.createEl('button', { cls: 't3c-chip t3c-perm-chip', attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } });
    this.permIconEl = this.permChipBtn.createSpan({ cls: 't3c-chip-ico' });
    this.permLabelEl = this.permChipBtn.createSpan({ cls: 't3c-perm-label' });
    setIcon(this.permChipBtn.createSpan({ cls: 't3c-chip-chev' }), 'chevron-down');
    this.permChipBtn.onclick = () => this.togglePopover('perm');

    this.noteFooterBtn = area.createEl('button', { cls: 't3c-note-footer', attr: { type: 'button' } });
    setIcon(this.noteFooterBtn.createSpan({ cls: 't3c-note-footer-ico' }), 'file-text');
    this.noteFooterLabelEl = this.noteFooterBtn.createSpan({ cls: 't3c-note-footer-label' });
    this.noteFooterBtn.onclick = () => {
      const next = !this.plugin.settings.includeNote;
      void this.plugin.updateSettings({ includeNote: next })
        .then(() => {
          if (this.ready) this.actionError = undefined;
          this.refreshControls();
        })
        .catch(() => this.setActionError('无法保存笔记上下文选项。'));
    };

    this.draftEl.oninput = () => {
      this.activeTab.draft = this.draftEl.value;
      if (this.ready && this.actionError) {
        this.actionError = undefined;
        this.refreshBanner();
      }
      this.refreshSendButton();
    };
    this.draftEl.onkeydown = event => {
      const cursor = this.draftEl.selectionStart;
      if (event.key === '@' && !event.isComposing && (cursor === 0 || /\s/.test(this.draftEl.value[cursor - 1]))) {
        event.preventDefault();
        this.pickNote();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.sendBtn.disabled) this.sendBtn.click();
      }
    };
  }

  private buildWideSidebar(root: HTMLElement): void {
    this.wideSidebarEl = root.createDiv({ cls: 't3c-wide-sidebar' });
    const nav = this.wideSidebarEl.createDiv({ cls: 't3c-wide-nav' });
    const addNavAction = (label: string, icon: string, onClick: () => void) => {
      const btn = nav.createEl('button', { cls: 't3c-wide-nav-btn', attr: { type: 'button' } });
      setIcon(btn.createSpan({ cls: 't3c-wide-nav-ico' }), icon);
      btn.createSpan({ text: label });
      btn.onclick = onClick;
      return btn;
    };
    addNavAction('新会话', 'square-pen', () => this.switchThread(undefined));
    addNavAction('搜索', 'search', () => {
      this.wideSearchVisible = !this.wideSearchVisible;
      this.wideSearchWrapEl.hidden = !this.wideSearchVisible;
      if (this.wideSearchVisible) this.wideSearchInput.focus();
      else if (this.historyQuery) {
        this.historyQuery = '';
        this.wideSearchInput.value = '';
        this.renderSessionLists();
      }
    });

    this.wideSearchWrapEl = this.wideSidebarEl.createDiv({ cls: 't3c-wide-search' });
    this.wideSearchWrapEl.hidden = true;
    this.wideSearchInput = this.wideSearchWrapEl.createEl('input', { attr: { type: 'search', placeholder: '过滤会话…', 'aria-label': '过滤会话' } });
    this.wideSearchInput.oninput = () => {
      this.historyQuery = this.wideSearchInput.value;
      this.renderSessionLists();
    };

    const projHead = this.wideSidebarEl.createDiv({ cls: 't3c-wide-sec-head' });
    projHead.createSpan({ text: '项目' });
    this.iconButton(projHead, 'refresh-cw', '刷新项目会话', () => this.refreshThreadList(true));
    this.wideProjectEl = this.wideSidebarEl.createDiv({ cls: 't3c-wide-project' });

    const sessHead = this.wideSidebarEl.createDiv({ cls: 't3c-wide-sec-head' });
    sessHead.createSpan({ text: 'SESSIONS' });
    this.wideGroupBtn = this.button(sessHead, '时间 ▾', () => this.toggleGroupMode());
    this.wideGroupBtn.addClass('t3c-mini-btn');
    this.wideListEl = this.wideSidebarEl.createDiv({ cls: 't3c-wide-list' });
  }

  private bindGlobalEvents(root: HTMLElement): void {
    const doc = root.ownerDocument;
    this.registerDomEvent(doc, 'pointerdown', event => {
      if (!this.openPopover) return;
      const target = event.target as Node | null;
      const insidePopover = [this.historyPopover, this.modelPopover, this.usagePopover, this.permPopover].some(p => p.contains(target));
      const insideTrigger = [this.historyBtn, this.modelChipBtn, this.usageChipBtn, this.permChipBtn].some(b => b.contains(target));
      if (!insidePopover && !insideTrigger) this.closePopovers(false);
    });
    this.registerDomEvent(doc, 'keydown', event => {
      if (!this.visible || event.key !== 'Escape' || !this.openPopover) return;
      event.preventDefault();
      event.stopPropagation();
      this.closePopovers(true);
    });
    this.resizerEl.onpointerdown = event => this.startResize(event);
    this.resizerEl.onkeydown = event => this.handleResizeKey(event);
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshNoteFooter()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshNoteFooter()));
    this.registerDomEvent(doc, 'selectionchange', () => this.refreshNoteFooter());
  }

  private setupResizeObserver(root: HTMLElement): void {
    const win = root.ownerDocument.defaultView;
    const RO = win?.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
    const applyWidth = (width: number) => {
      if (width <= 0) return;
      const mode = resolveLayoutMode(width);
      root.toggleClass('is-wide', mode === 'wide');
      root.toggleClass('is-narrow', mode === 'narrow');
      if (mode === 'wide') {
        if (this.openPopover === 'history') this.closePopovers(false);
        this.clampWideSidebarWidth(this.wideSidebarWidth, width);
        if (!this.threadsLoaded && this.ready) void this.refreshThreadList(false);
      }
    };
    if (RO) {
      this.resizeObserver = new RO(entries => {
        const w = entries.at(-1)?.contentRect.width ?? root.getBoundingClientRect().width;
        applyWidth(w);
      });
      this.resizeObserver.observe(root);
    }
    applyWidth(root.getBoundingClientRect().width);
  }

  private clampWideSidebarWidth(requested: number, totalWidth = this.rootEl.getBoundingClientRect().width): void {
    const maxW = Math.max(MIN_WIDE_SIDEBAR_WIDTH, totalWidth - MIN_CHAT_COL_WIDTH - RESIZER_WIDTH);
    const clamped = Math.round(Math.min(Math.max(requested, MIN_WIDE_SIDEBAR_WIDTH), maxW));
    this.wideSidebarWidth = clamped;
    this.rootEl.style.setProperty('--t3c-wide-sidebar-width', `${clamped}px`);
    this.resizerEl.setAttribute('aria-valuenow', String(clamped));
    this.resizerEl.setAttribute('aria-valuemin', String(MIN_WIDE_SIDEBAR_WIDTH));
    this.resizerEl.setAttribute('aria-valuemax', String(Math.round(maxW)));
  }

  private startResize(event: PointerEvent): void {
    if (!this.rootEl.hasClass('is-wide') || event.button !== 0) return;
    event.preventDefault();
    this.stopResize();
    const doc = this.rootEl.ownerDocument;
    const startX = event.clientX;
    const startW = this.wideSidebarWidth;
    const onMove = (e: PointerEvent) => this.clampWideSidebarWidth(startW - (e.clientX - startX));
    const onEnd = () => this.stopResize();
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onEnd);
    doc.addEventListener('pointercancel', onEnd);
    this.resizeCleanup = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onEnd);
      doc.removeEventListener('pointercancel', onEnd);
    };
  }

  private stopResize(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = undefined;
  }

  private handleResizeKey(event: KeyboardEvent): void {
    if (!this.rootEl.hasClass('is-wide')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    this.clampWideSidebarWidth(this.wideSidebarWidth + (event.key === 'ArrowLeft' ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP));
  }

  private buildUsageGauge(parent: HTMLElement): void {
    const svg = parent.ownerDocument.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const track = parent.ownerDocument.createElementNS(SVG_NS, 'path');
    track.setAttribute('d', 'M 3.05 11 A 5.7 5.7 0 1 1 12.95 11');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'currentColor');
    track.setAttribute('stroke-opacity', '0.28');
    track.setAttribute('stroke-width', '2');
    track.setAttribute('stroke-linecap', 'round');
    svg.appendChild(track);

    const arc = parent.ownerDocument.createElementNS(SVG_NS, 'path') as unknown as SVGPathElement;
    arc.setAttribute('d', 'M 3.05 11 A 5.7 5.7 0 1 1 12.95 11');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '2');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', String(GAUGE_ARC_LENGTH));
    arc.setAttribute('stroke-dashoffset', String(GAUGE_ARC_LENGTH));
    (arc as unknown as { classList?: { add(...c: string[]): void }; addClass?: (...c: string[]) => void }).addClass?.('t3c-usage-arc');
    if (typeof (arc as unknown as HTMLElement).setAttribute === 'function') {
      arc.setAttribute('class', 't3c-usage-arc');
    }
    (arc as unknown as { hidden: boolean }).hidden = true;
    svg.appendChild(arc);
    this.usageArcEl = arc;
    parent.appendChild(svg);
  }

  private button(parent: HTMLElement, text: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl('button', { text, type: 'button' });
    button.onclick = () => {
      void Promise.resolve().then(action).catch(error => {
        this.setActionError(redactSensitiveText(error instanceof Error ? error.message : '操作失败。'));
      });
    };
    return button;
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 't3c-icon-btn', attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(button, icon);
    button.onclick = () => {
      void Promise.resolve().then(action).catch(error => {
        this.setActionError(redactSensitiveText(error instanceof Error ? error.message : '操作失败。'));
      });
    };
    return button;
  }

  private setActionError(message?: string): void {
    this.actionError = message;
    this.refreshControls();
  }

  backendChanged(): void {
    if (!this.visible) return;
    this.backendRevision++;
    this.ready = false;
    this.workspaceValidated = false;
    this.actionError = undefined;
    this.vaultOverlapCache = undefined;
    this.cachedThreads = [];
    this.threadsLoaded = false;
    this.closePopovers(false);
    const defaultSel = configuredModels(this.plugin.settings)[0];
    for (const tab of this.tabs) {
      this.abortTab(tab);
      tab.checking = false;
      tab.busy = false;
      tab.submitting = false;
      tab.threadId = undefined;
      tab.thread = undefined;
      tab.messages = [];
      tab.turnItems = [];
      tab.runtimeRequests = [];
      tab.contextUsage = undefined;
      tab.activeRunId = undefined;
      tab.uncertainCommandId = undefined;
      tab.extraOptions = {};
      tab.pendingFeedback.clear();
      tab.unread = false;
      tab.runStartedAt = undefined;
      tab.lastElapsedMs = undefined;
      tab.selection = defaultSel;
      tab.selectionRevision++;
    }
    this.syncActiveTabUI();
    void this.check();
  }

  modelsChanged(): void {
    if (this.storeState.capabilities.supportsLiveCatalog && this.storeState.providers.length > 0) return;
    const entries = configuredModels(this.plugin.settings);
    for (const tab of this.tabs) {
      if (!tab.threadId) tab.selection = entries[0];
    }
    if (this.openPopover === 'model') this.renderModelPopover();
    this.refreshControls();
  }

  private openNewTab(seed?: { draft?: string; notes?: TFile[]; selection?: ModelSelection }): void {
    const tab = this.createTab(seed);
    this.tabs.push(tab);
    this.activateTab(tab.id);
  }

  private releaseTabThreadDetail(threadId?: string): void {
    if (!threadId) return;
    if (this.tabs.some(t => t.threadId === threadId)) return;
    this.backendManager?.store.removeThreadDetail(threadId);
  }

  private closeTab(tabId: string): void {
    if (this.tabs.length <= 1) return;
    const index = this.tabs.findIndex(t => t.id === tabId);
    if (index < 0) return;
    const [removed] = this.tabs.splice(index, 1);
    removed.selectionRevision++;
    this.abortTab(removed);
    this.releaseTabThreadDetail(removed.threadId);
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activateTab(next.id);
    } else {
      this.renderTabBadges();
    }
  }

  private activateTab(tabId: string): void {
    const target = this.tabs.find(t => t.id === tabId);
    if (!target) return;
    const current = this.tabs.find(t => t.id === this.activeTabId);
    if (current && current !== target) current.draft = this.draftEl.value;
    this.activeTabId = tabId;
    target.unread = false;
    this.closePopovers(false);
    this.syncActiveTabUI();
    this.draftEl.focus();
  }

  private syncActiveTabUI(): void {
    const tab = this.activeTab;
    this.draftEl.value = tab.draft;
    this.renderAttachments();
    this.renderMessages(tab.messages);
    this.renderTurnItems(tab.turnItems);
    this.renderApprovalCards(tab);
    this.updateRunTimer();
    this.refreshControls();
  }

  private togglePopover(target: 'history' | 'model' | 'usage' | 'perm'): void {
    if (this.openPopover === target) {
      this.closePopovers(false);
      return;
    }
    this.closePopovers(false);
    this.openPopover = target;
    if (target === 'history') {
      this.historyPopover.hidden = false;
      this.historyBtn.addClass('is-active');
      this.historyBtn.setAttribute('aria-expanded', 'true');
      this.renderSessionLists();
      void this.refreshThreadList(true);
      this.historySearchInput.focus();
    } else if (target === 'model') {
      this.modelFilterQuery = '';
      const activeThreadSel = this.activeTab.threadId ? this.activeTab.thread?.providerInstanceId : undefined;
      this.browseProvider = activeThreadSel ?? this.activeTab.selection?.provider ?? this.getModelGroups()[0]?.provider ?? '';
      this.modelPopover.hidden = false;
      this.modelChipBtn.addClass('is-open');
      this.modelChipBtn.setAttribute('aria-expanded', 'true');
      this.renderModelPopover('initial');
    } else if (target === 'usage') {
      this.usagePopover.hidden = false;
      this.usageChipBtn.addClass('is-open');
      this.usageChipBtn.setAttribute('aria-expanded', 'true');
      this.renderUsagePopover();
      (this.usagePopover.querySelector('a') as HTMLElement | null ?? this.usagePopover).focus();
    } else {
      this.permPopover.hidden = false;
      this.permChipBtn.addClass('is-open');
      this.permChipBtn.setAttribute('aria-expanded', 'true');
      this.renderPermPopover();
      (this.permPopover.querySelector('button') as HTMLElement | null
        ?? this.permPopover.querySelector('a') as HTMLElement | null
        ?? this.permPopover).focus();
    }
  }

  private closePopovers(restoreFocus: boolean): void {
    const prev = this.openPopover;
    this.openPopover = null;
    this.historyPopover.hidden = true;
    this.modelPopover.hidden = true;
    this.usagePopover.hidden = true;
    this.permPopover.hidden = true;
    this.historyBtn.removeClass('is-active');
    this.modelChipBtn.removeClass('is-open');
    this.usageChipBtn.removeClass('is-open');
    this.permChipBtn.removeClass('is-open');
    this.historyBtn.setAttribute('aria-expanded', 'false');
    this.modelChipBtn.setAttribute('aria-expanded', 'false');
    this.usageChipBtn.setAttribute('aria-expanded', 'false');
    this.permChipBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && prev) {
      const focusTarget = prev === 'history' ? this.historyBtn
        : prev === 'model' ? this.modelChipBtn
          : prev === 'usage' ? this.usageChipBtn
            : this.permChipBtn;
      focusTarget.focus();
    }
  }

  private toggleGroupMode(): void {
    this.groupMode = this.groupMode === 'time' ? 'inbox' : 'time';
    const text = this.groupMode === 'time' ? '时间' : 'Inbox';
    this.historyGroupBtn.setText(text);
    this.wideGroupBtn.setText(`${text} ▾`);
    this.renderSessionLists();
  }

  private async refreshThreadList(force = false): Promise<void> {
    if (!this.visible) return;
    const rev = this.backendRevision;
    const tab = this.activeTab;
    const selectionRevision = tab.selectionRevision;
    if (!force && this.threadsLoaded) {
      this.renderSessionLists();
      return;
    }
    try {
      await this.resolveWorkspacePaths();
      const list = await this.ensureManager().refreshThreads();
      if (!this.visible || rev !== this.backendRevision) return;
      this.cachedThreads = list;
      this.threadsLoaded = true;
      this.renderSessionLists();
    } catch {
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      if (this.openPopover === 'history') {
        this.historyListEl.empty();
        this.historyListEl.createEl('p', { cls: 't3c-empty-msg', text: '读取会话失败。请检查本地 T3 Code 连接。' });
      }
    }
  }

  private renderSessionLists(): void {
    const filtered = filterThreads(this.cachedThreads, this.historyQuery);
    const groups = groupThreads(filtered, this.groupMode);
    const renderInto = (container: HTMLElement) => {
      container.empty();
      if (!this.threadsLoaded) {
        container.createEl('p', { cls: 't3c-empty-msg', text: '正在读取会话…' });
        return;
      }
      if (!groups.length) {
        container.createEl('p', { cls: 't3c-empty-msg', text: this.historyQuery.trim() ? '无匹配会话。' : '此项目还没有会话。' });
        return;
      }
      for (const group of groups) {
        container.createDiv({ cls: 't3c-group-label', text: group.label });
        for (const thread of group.threads) {
          const btn = this.button(container, thread.title, () => this.switchThread(thread));
          btn.addClass('t3c-session-row');
          btn.disabled = this.activeTab.submitting || this.activeTab.checking;
          btn.title = [thread.providerInstanceId, thread.model].filter(Boolean).join(' · ');
          if (thread.threadId === this.activeTab.threadId) btn.setAttribute('aria-current', 'true');
        }
      }
    };
    if (this.openPopover === 'history') renderInto(this.historyListEl);
    renderInto(this.wideListEl);
  }

  private async attachThreadStream(tab: SidebarTab, threadId: string, rev: number, selectionRevision: number): Promise<void> {
    this.abortTab(tab);
    let initialError: string | undefined;
    const sub = await this.ensureManager().openThread(threadId, event => {
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      if (event.type === 'thread.detail') {
        this.syncTabFromDetail(tab, event.detail);
        this.updateRunTimer();
        this.refreshControls();
      } else if (event.type === 'error') {
        initialError = event.message;
        tab.busy = false;
        tab.runStartedAt = undefined;
        this.actionError = redactSensitiveText(event.message);
        this.updateRunTimer();
        this.refreshControls();
      }
    });
    if (this.isStaleTab(tab, rev, selectionRevision)) {
      sub.unsubscribe();
      return;
    }
    if (initialError) {
      sub.unsubscribe();
      throw new Error(initialError);
    }
    tab.threadSub = sub;
  }

  private async switchThread(thread?: CliThread, keepDraft = false): Promise<void> {
    const tab = this.activeTab;
    if (!this.ready || tab.submitting || tab.checking || (thread && thread.threadId === tab.threadId)) return;
    const rev = this.backendRevision;
    const currentDraft = this.draftEl.value;
    const currentNotes = [...tab.notes];
    this.abortTab(tab);
    tab.selectionRevision++;
    const selectionRevision = tab.selectionRevision;
    tab.busy = false;
    tab.unread = false;
    tab.runStartedAt = undefined;
    tab.lastElapsedMs = undefined;
    const prevThreadId = tab.threadId;
    tab.thread = thread;
    tab.threadId = thread?.threadId;
    this.releaseTabThreadDetail(prevThreadId);
    tab.draft = keepDraft ? currentDraft : '';
    tab.notes = keepDraft ? currentNotes : [];
    tab.messages = [];
    tab.turnItems = [];
    tab.runtimeRequests = [];
    tab.contextUsage = undefined;
    tab.activeRunId = undefined;
    tab.uncertainCommandId = undefined;
    this.closePopovers(false);
    this.syncActiveTabUI();
    this.draftEl.focus();
    if (!thread) {
      if (this.ready) this.setActionError(undefined);
      this.renderSessionLists();
      return;
    }
    tab.checking = true;
    this.refreshControls();
    try {
      await this.attachThreadStream(tab, thread.threadId, rev, selectionRevision);
      if (!this.isStaleTab(tab, rev, selectionRevision)) {
        this.renderSessionLists();
      }
    } catch (error) {
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      this.ready = false;
      this.setActionError(redactSensitiveText(error instanceof Error ? error.message : '无法恢复会话。'));
    } finally {
      if (rev === this.backendRevision) {
        tab.checking = false;
        if (this.visible && this.tabs.includes(tab)) this.refreshControls();
      }
    }
  }

  private toBackendModelSelection(sel: ModelSelection, extra: Record<string, string | boolean>): BackendModelSelection {
    const options: Array<{ id: string; value: string | boolean }> = [];
    if (sel.option) {
      const sep = sel.option.indexOf('=');
      if (sep > 0) {
        options.push({ id: sel.option.slice(0, sep), value: sel.option.slice(sep + 1) });
      }
    }
    for (const [id, value] of Object.entries(extra)) {
      if (!options.some(o => o.id === id)) {
        options.push({ id, value });
      }
    }
    return {
      instanceId: sel.provider,
      model: sel.model,
      ...(options.length > 0 ? { options } : {}),
    };
  }

  private async applyModelSelection(tab: SidebarTab, nextSel: ModelSelection, nextExtra: Record<string, string | boolean>, focusKey: string): Promise<void> {
    const rev = this.backendRevision;
    const selectionRevision = tab.selectionRevision;
    if (tab.threadId) {
      await this.ensureManager().setModelSelection(tab.threadId, this.toBackendModelSelection(nextSel, nextExtra));
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      if (tab.thread) {
        tab.thread = { ...tab.thread, providerInstanceId: nextSel.provider, model: nextSel.model };
      }
    }
    tab.selection = nextSel;
    tab.extraOptions = nextExtra;
    this.renderModelPopover(focusKey);
    this.refreshControls();
  }

  private getEffectiveTabSelection(tab: SidebarTab): ModelSelection | undefined {
    if (tab.threadId && tab.thread?.providerInstanceId && tab.thread.model) {
      const opt = tab.selection?.provider === tab.thread.providerInstanceId && tab.selection.model === tab.thread.model
        ? tab.selection.option
        : undefined;
      return { provider: tab.thread.providerInstanceId, model: tab.thread.model, ...(opt ? { option: opt } : {}) };
    }
    return tab.selection;
  }

  private renderModelPopover(focusTarget?: string): void {
    const panel = this.modelPopover;
    panel.empty();
    const tab = this.activeTab;
    const caps = this.storeState.capabilities;

    if (tab.threadId && !caps.supportsMidThreadModelSwitch) {
      const locked = panel.createDiv({ cls: 't3c-mp-locked' });
      locked.createEl('strong', { text: '当前会话模型已固定' });
      locked.createEl('p', { text: '本机 CLI 在创建会话时设置 Agent 与模型，暂不支持在已有会话中切换。' });
      const btn = this.button(locked, '带着草稿新开会话', async () => {
        await this.switchThread(undefined, true);
        if (!this.activeTab.threadId) {
          this.togglePopover('model');
        }
      });
      btn.addClass('t3c-solid-btn');
      btn.disabled = !this.ready || tab.submitting || tab.checking;
      if (focusTarget === 'initial') (btn.disabled ? panel : btn).focus();
      return;
    }

    const groups = this.getModelGroups();
    const activeSel = this.getEffectiveTabSelection(tab);
    if (!groups.some(g => g.provider === this.browseProvider)) {
      this.browseProvider = activeSel?.provider ?? groups[0]?.provider ?? '';
    }

    let focusElement: HTMLElement | null = null;
    const agentsCol = panel.createDiv({ cls: 't3c-mp-agents', attr: { role: 'toolbar', 'aria-label': 'Agent 实例' } });
    for (const group of groups) {
      const label = group.displayName ?? group.provider;
      const btn = agentsCol.createEl('button', {
        cls: 't3c-mp-agent-btn',
        attr: { type: 'button', 'aria-label': group.provider, 'aria-pressed': String(group.provider === this.browseProvider), title: label },
      });
      setIcon(btn, group.provider.toLowerCase().includes('claude') ? 'sparkles' : 'cpu');
      btn.onclick = () => {
        this.browseProvider = group.provider;
        this.renderModelPopover(`agent:${group.provider}`);
      };
      if (focusTarget === `agent:${group.provider}`) focusElement = btn;
    }

    const modelsCol = panel.createDiv({ cls: 't3c-mp-models' });
    const head = modelsCol.createDiv({ cls: 't3c-mp-col-head' });
    head.createSpan({ text: '模型' });
    const filterInput = head.createEl('input', { cls: 't3c-mp-filter', attr: { type: 'search', placeholder: '过滤…', 'aria-label': '过滤模型' } });
    filterInput.value = this.modelFilterQuery;
    if (caps.supportsProviderRefresh) {
      const refreshBtn = this.iconButton(head, 'refresh-cw', '刷新模型目录', async () => {
        await this.ensureManager().refreshProviders();
        this.renderModelPopover('refresh');
      });
      refreshBtn.addClass('t3c-mp-refresh');
    }
    if (focusTarget === 'initial') focusElement = filterInput;
    const modelList = modelsCol.createDiv({ cls: 't3c-mp-list' });

    const effortsCol = panel.createDiv({ cls: 't3c-mp-efforts' });
    const isBrowsingOtherAgent = Boolean(activeSel && this.browseProvider !== activeSel.provider);
    effortsCol.toggleClass('is-inert', isBrowsingOtherAgent);
    effortsCol.setAttribute('aria-disabled', String(isBrowsingOtherAgent));
    effortsCol.createDiv({ cls: 't3c-mp-col-head', text: '思考' });
    const effortList = effortsCol.createDiv({ cls: 't3c-mp-list' });

    const configuredEntries = configuredModels(this.plugin.settings);
    const renderModelsList = () => {
      modelList.empty();
      const group = groups.find(g => g.provider === this.browseProvider) ?? groups[0];
      const q = this.modelFilterQuery.trim().toLowerCase();
      const models = (group?.models ?? []).filter(m => !q || `${m.model} ${m.name ?? ''} ${m.subtitle}`.toLowerCase().includes(q));
      for (const item of models) {
        const isSelected = activeSel?.provider === item.provider && activeSel?.model === item.model;
        const row = this.button(modelList, '', async () => {
          const hasBare = caps.supportsLiveCatalog
            ? Boolean(item.defaultSelection)
            : configuredEntries.some(e => e.provider === item.provider && e.model === item.model && !e.option);
          const nextSel = hasBare ? item.defaultSelection : (item.efforts[0]?.selection ?? item.defaultSelection);
          await this.applyModelSelection(tab, nextSel, {}, `model:${item.provider}:${item.model}`);
        });
        row.addClass('t3c-mp-model-row');
        if (isSelected) row.addClass('is-selected');
        row.createSpan({ cls: 't3c-mp-model-name', text: item.model });
        row.createSpan({ cls: 't3c-mp-model-sub', text: item.subtitle });
        if (focusTarget === `model:${item.provider}:${item.model}`) focusElement = row;
      }
      if (!models.length) modelList.createEl('p', { cls: 't3c-empty-msg', text: '无匹配模型' });
    };

    filterInput.oninput = () => {
      this.modelFilterQuery = filterInput.value;
      renderModelsList();
    };
    renderModelsList();

    const activeGroup = groups.find(g => g.provider === activeSel?.provider);
    const activeItem: ModelCatalogItem | undefined = activeGroup?.models.find(m => m.model === activeSel?.model);
    if (activeItem && (activeItem.efforts.length > 0 || (activeItem.extraOptions?.length ?? 0) > 0)) {
      const hasBare = !caps.supportsLiveCatalog && configuredEntries.some(
        e => e.provider === activeItem.provider && e.model === activeItem.model && !e.option,
      );
      if (hasBare) {
        const defBtn = this.button(effortList, '默认', async () => {
          if (isBrowsingOtherAgent) return;
          await this.applyModelSelection(tab, activeItem.defaultSelection, tab.extraOptions, 'effort:default');
        });
        defBtn.addClass('t3c-mp-effort-row');
        defBtn.disabled = isBrowsingOtherAgent;
        if (!activeSel?.option) defBtn.addClass('is-selected');
        if (focusTarget === 'effort:default' && !defBtn.disabled) focusElement = defBtn;
      }
      for (const eff of activeItem.efforts) {
        const row = effortList.createEl('button', { cls: 't3c-mp-effort-row', attr: { type: 'button' } });
        row.disabled = isBrowsingOtherAgent;
        if (activeSel?.option === eff.option) row.addClass('is-selected');
        const bars = row.createSpan({ cls: 't3c-bars', attr: { 'aria-hidden': 'true' } });
        for (let i = 1; i <= 4; i++) {
          const bar = bars.createSpan();
          if (i <= eff.bars) bar.addClass('is-on');
        }
        row.createSpan({ text: eff.label });
        row.onclick = () => {
          if (isBrowsingOtherAgent) return;
          void this.applyModelSelection(tab, eff.selection, tab.extraOptions, `effort:${eff.option}`)
            .catch(err => this.setActionError(redactSensitiveText(err instanceof Error ? err.message : '切换思考度失败。')));
        };
        if (focusTarget === `effort:${eff.option}` && !row.disabled) focusElement = row;
      }

      if (activeItem.extraOptions?.length) {
        const extraWrap = effortList.createDiv({ cls: 't3c-mp-extra' });
        for (const opt of activeItem.extraOptions) {
          if (opt.type === 'boolean') {
            const currentVal = typeof tab.extraOptions[opt.id] === 'boolean'
              ? Boolean(tab.extraOptions[opt.id])
              : Boolean(opt.currentValue);
            const optBtn = this.button(extraWrap, `${opt.label}: ${currentVal ? '开' : '关'}`, async () => {
              if (isBrowsingOtherAgent || !activeSel) return;
              const nextExtra = { ...tab.extraOptions, [opt.id]: !currentVal };
              await this.applyModelSelection(tab, activeSel, nextExtra, `extra:${opt.id}`);
            });
            optBtn.addClass('t3c-mp-extra-btn');
            optBtn.disabled = isBrowsingOtherAgent;
            if (currentVal) optBtn.addClass('is-selected');
          }
        }
      }
    } else {
      effortList.createEl('p', {
        cls: 't3c-empty-msg',
        text: caps.supportsLiveCatalog ? '当前模型无思考选项' : '可在设置添加模型与思考预设',
      });
    }
    if (focusTarget) (focusElement ?? panel).focus();
  }

  private renderUsagePopover(): void {
    const panel = this.usagePopover;
    panel.empty();
    const tab = this.activeTab;
    const caps = this.storeState.capabilities;
    panel.createEl('strong', { text: '上下文与账号额度' });

    const ctxBlock = panel.createDiv({ cls: 't3c-usage-block' });
    const ctxHead = ctxBlock.createDiv({ cls: 't3c-usage-section' });
    ctxHead.createSpan({ text: '上下文窗口（当前会话）' });
    if (!caps.supportsContextUsage) {
      ctxHead.createSpan({ cls: 't3c-muted-inline', text: 'CLI 暂未提供数据' });
    } else {
      const ctxInfo = formatContextUsage(tab.contextUsage);
      ctxHead.createSpan({ cls: 't3c-usage-val', text: ctxInfo.shortLabel });
      for (const line of ctxInfo.detailLines) {
        ctxBlock.createDiv({ cls: 't3c-muted-note', text: line });
      }
    }

    const quotaBlock = panel.createDiv({ cls: 't3c-usage-block' });
    const quotaHead = quotaBlock.createDiv({ cls: 't3c-usage-section' });
    quotaHead.createSpan({ text: '账号额度（Provider 实例）' });
    if (!caps.supportsQuotaUsage) {
      quotaHead.createSpan({ cls: 't3c-muted-inline', text: 'CLI 暂未提供数据' });
    } else {
      const activeProviderId = this.getEffectiveTabSelection(tab)?.provider;
      const provider = this.storeState.providers.find(p => p.instanceId === activeProviderId)
        ?? this.storeState.providers.find(p => p.enabled && p.status === 'ready');
      const entries = formatQuotaSummary(provider?.quota);
      for (const entry of entries) {
        const row = quotaBlock.createDiv({ cls: 't3c-usage-section' });
        row.createSpan({ cls: 't3c-muted-inline', text: entry.label });
        row.createSpan({ cls: 't3c-muted-inline', text: entry.value });
      }
    }

    const link = this.safeThreadLink(tab.thread);
    if (link) {
      panel.createEl('a', { text: '在 T3 Code 中查看用量 ↗', href: link, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    }
  }

  private renderPermPopover(): void {
    const panel = this.permPopover;
    panel.empty();
    const tab = this.activeTab;
    const caps = this.storeState.capabilities;
    const isOverlapping = this.vaultOverlapCache?.overlaps === true;
    const currentMode = tab.thread?.runtimeMode ?? (isOverlapping ? 'approval-required' : undefined);
    const activeProvider = this.storeState.providers.find(
      p => p.instanceId === (tab.thread?.providerInstanceId ?? tab.selection?.provider),
    );
    const allowedModes = activeProvider?.supportedRuntimeModes.length
      ? new Set(activeProvider.supportedRuntimeModes)
      : undefined;

    panel.createEl('strong', { text: '运行权限' });
    const canSwitch = caps.supportsRuntimeModeSwitch && Boolean(tab.threadId);

    for (const mode of RUNTIME_MODES) {
      if (allowedModes && !allowedModes.has(mode.id)) continue;
      const lockedByVault = isOverlapping && mode.id !== 'approval-required';
      const isCurrent = mode.id === currentMode;

      if (canSwitch) {
        const rev = this.backendRevision;
        const selectionRevision = tab.selectionRevision;
        const btn = this.button(panel, '', async () => {
          if (!tab.threadId) return;
          await this.ensureManager().setRuntimeMode(tab.threadId, mode.id);
          if (this.isStaleTab(tab, rev, selectionRevision)) return;
          if (tab.thread) tab.thread = { ...tab.thread, runtimeMode: mode.id };
          this.renderPermPopover();
          this.refreshControls();
        });
        btn.addClass('t3c-perm-row', 'is-interactive');
        if (isCurrent) btn.addClass('is-current');
        btn.disabled = lockedByVault;
        setIcon(btn.createSpan({ cls: 't3c-perm-row-ico' }), mode.icon);
        const copy = btn.createDiv({ cls: 't3c-perm-row-copy' });
        const head = copy.createDiv({ cls: 't3c-perm-row-title', text: mode.label });
        if (isCurrent) head.createSpan({ cls: 't3c-perm-badge', text: '当前生效' });
        if (lockedByVault) head.createSpan({ cls: 't3c-perm-badge', text: '知识库锁定' });
        copy.createDiv({ cls: 't3c-perm-row-desc', text: mode.description });
      } else {
        const row = panel.createDiv({ cls: 't3c-perm-row' });
        if (isCurrent) row.addClass('is-current');
        setIcon(row.createSpan({ cls: 't3c-perm-row-ico' }), mode.icon);
        const copy = row.createDiv({ cls: 't3c-perm-row-copy' });
        const head = copy.createDiv({ cls: 't3c-perm-row-title', text: mode.label });
        if (isCurrent) head.createSpan({ cls: 't3c-perm-badge', text: '当前生效' });
        copy.createDiv({ cls: 't3c-perm-row-desc', text: mode.description });
      }
    }

    panel.createEl('p', {
      cls: 't3c-muted-note',
      text: canSwitch
        ? (isOverlapping ? '当前绑定知识库目录，已锁定仅允许「需要审批」。' : '点击可即时切换当前会话运行权限。')
        : '权限由 T3 Code 项目设置控制，侧栏仅显示实测状态。',
    });
    const link = this.safeThreadLink(tab.thread);
    if (link) {
      panel.createEl('a', { text: '在 T3 Code 中调整权限 ↗', href: link, attr: { target: '_blank', rel: 'noopener noreferrer' } });
    }
  }

  private safeThreadLink(thread?: CliThread): string | undefined {
    const link = thread?.link;
    return link && /^https:\/\/app\.t3\.codes\/threads\//i.test(link) ? link : undefined;
  }

  private async resolveWorkspacePaths(): Promise<{ vaultPath: string; projectPath: string }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('无法取得当前知识库的本地目录。');
    const vaultPath = adapter.getBasePath();
    const projectPath = resolveWorkspacePath(this.plugin.settings.projectPath, vaultPath);
    if (!isAbsolute(projectPath)) throw new Error('请输入 T3 项目绝对路径。');
    const [vault, workspace] = await Promise.all([realpath(vaultPath), realpath(projectPath)])
      .catch(() => { throw new Error('无法访问 T3 项目目录。'); });
    this.vaultOverlapCache = {
      vaultPath,
      projectPath: this.plugin.settings.projectPath,
      overlaps: vault === workspace || workspacesOverlap(vault, workspace),
    };
    if (vault !== workspace && workspacesOverlap(vault, workspace)) {
      throw new Error('请使用当前知识库目录，或选择与知识库分离的项目。');
    }
    return { vaultPath, projectPath: workspace };
  }

  private validateCliProjectBinding(id: string): void {
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) {
      throw new Error('请在插件设置绑定当前目录在 T3 Code 中登记的项目 ID。');
    }
    const threads = this.ensureManager().store.getSnapshot().threads;
    if (threads.some(thread => thread.projectId !== id)) {
      throw new Error('当前目录解析到了其他项目。请核对已登记的项目根目录和项目 ID。');
    }
  }

  private async check(): Promise<void> {
    const tab = this.activeTab;
    if (tab.checking || tab.busy) return;
    const rev = this.backendRevision;
    const selectionRevision = tab.selectionRevision;
    const manager = this.ensureManager();
    tab.checking = true;
    this.workspaceValidated = false;
    this.actionError = undefined;
    this.refreshControls();

    try {
      const { vaultPath } = await this.resolveWorkspacePaths();
      if (!this.visible || rev !== this.backendRevision) return;
      if (this.plugin.settings.backendPreference === 'cli' && !/^[a-z0-9][a-z0-9._:-]*$/i.test(this.plugin.settings.projectId)) {
        throw new Error('请在插件设置绑定当前目录在 T3 Code 中登记的项目 ID。');
      }
      await manager.connect(vaultPath, this.plugin.settings.projectPath, this.plugin.settings.projectId);
      if (!this.visible || rev !== this.backendRevision) return;
      if (manager.activeMode === 'cli') {
        this.validateCliProjectBinding(this.plugin.settings.projectId);
      }
      this.workspaceValidated = true;
      this.ready = true;
      this.actionError = undefined;
      this.cachedThreads = manager.store.getSnapshot().threads;
      this.threadsLoaded = true;
      this.renderSessionLists();
      if (!this.isStaleTab(tab, rev, selectionRevision) && tab.threadId) {
        await this.attachThreadStream(tab, tab.threadId, rev, selectionRevision);
      }
    } catch (error) {
      if (!this.visible || rev !== this.backendRevision) return;
      this.workspaceValidated = false;
      this.ready = false;
      this.actionError = redactSensitiveText(error instanceof Error ? error.message : '无法检查 T3 连接。');
    } finally {
      if (rev === this.backendRevision) {
        tab.checking = false;
        if (this.visible) this.refreshControls();
      }
    }
  }

  private async retryFromBanner(): Promise<void> {
    const tab = this.activeTab;
    const rev = this.backendRevision;
    const selectionRevision = tab.selectionRevision;
    if (tab.uncertainCommandId) {
      const cmdId = tab.uncertainCommandId;
      const manager = this.ensureManager();
      tab.checking = true;
      this.refreshControls();
      try {
        if (manager.activeMode !== 'rpc' && this.plugin.settings.backendPreference !== 'cli') {
          await manager.retryRpc();
        }
        if (this.isStaleTab(tab, rev, selectionRevision)) return;
        if (manager.activeMode !== 'rpc') {
          this.actionError = undefined;
          return;
        }
        const res = await manager.retryPendingDispatch(cmdId);
        if (this.isStaleTab(tab, rev, selectionRevision)) return;
        tab.uncertainCommandId = undefined;
        tab.threadId = res.threadId;
        if (tab.draft.trim()) {
          tab.draft = '';
          if (tab === this.activeTab) this.draftEl.value = '';
        }
        tab.notes = [];
        this.actionError = undefined;
        await this.attachThreadStream(tab, res.threadId, rev, selectionRevision);
        void manager.refreshThreads().catch(() => undefined);
      } finally {
        if (rev === this.backendRevision) {
          tab.checking = false;
          if (this.visible && this.tabs.includes(tab)) this.refreshControls();
        }
      }
      return;
    }
    await this.check();
  }

  private async stopCurrentRun(): Promise<void> {
    const tab = this.activeTab;
    if (!tab.threadId || !tab.busy) return;
    await this.ensureManager().stopThread(tab.threadId, tab.activeRunId);
  }

  private note(): MarkdownView | undefined {
    const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    return view instanceof MarkdownView && view.file ? view : undefined;
  }

  private pickNote(): void {
    const tab = this.activeTab;
    if (tab.submitting) return;
    const selectionRevision = tab.selectionRevision;
    const available = () => this.app.vault.getMarkdownFiles().filter(file => !tab.notes.includes(file));
    const attach = (file: TFile) => {
      if (!this.visible || tab.selectionRevision !== selectionRevision || tab.submitting || tab.notes.includes(file)) return;
      tab.notes = [...tab.notes, file];
      if (tab === this.activeTab) this.renderAttachments();
      this.draftEl.focus();
    };
    new class NotePicker extends FuzzySuggestModal<TFile> {
      getItems(): TFile[] { return available(); }
      getItemText(file: TFile): string { return file.path; }
      onChooseItem(file: TFile): void { attach(file); }
    }(this.app).open();
  }

  private renderAttachments(): void {
    const tab = this.activeTab;
    this.contextTrayEl.empty();
    this.contextTrayEl.hidden = tab.notes.length === 0;
    for (const file of tab.notes) {
      const chip = this.button(this.contextTrayEl, file.basename + ' ×', () => {
        if (tab.submitting) return;
        tab.notes = tab.notes.filter(item => item !== file);
        this.renderAttachments();
      });
      chip.addClass('t3c-context-chip');
      chip.title = file.path;
      chip.setAttribute('aria-label', '移除引用 ' + file.path);
    }
  }

  private async send(): Promise<void> {
    const tab = this.activeTab;
    const draft = this.draftEl.value;
    const notes = tab.notes;
    if (!this.ready || tab.busy || tab.checking || !draft.trim() || this.threadBlocksSending(tab)) return;
    const rev = this.backendRevision;
    const selectionRevision = tab.selectionRevision;
    this.actionError = undefined;
    tab.busy = true;
    tab.submitting = true;
    tab.runStartedAt = Date.now();
    tab.lastElapsedMs = undefined;
    this.updateRunTimer();
    this.refreshControls();

    const view = this.plugin.settings.includeNote ? this.note() : undefined;
    const selection = view?.editor.getSelection() ?? '';
    const prompt = composePrompt(draft.trim(), view?.file ? {
      path: view.file.path, selection, body: selection.trim() ? '' : view.editor.getValue(),
    } : undefined);

    const manager = this.ensureManager();
    const commandId = randomUUID();
    try {
      await this.resolveWorkspacePaths();
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      const activeNote = this.note();
      const attachmentText = await Promise.all(notes.filter(file => file !== view?.file).map(async file => {
        const read = file === activeNote?.file ? Promise.resolve(activeNote.editor.getValue()) : this.app.vault.cachedRead(file);
        const text = await read.catch(() => { throw new Error('无法读取引用笔记 ' + file.path); });
        return { path: file.path, text };
      }));
      if (this.isStaleTab(tab, rev, selectionRevision)) return;

      const modelSelection = tab.selection
        ? this.toBackendModelSelection(tab.selection, tab.extraOptions)
        : undefined;
      const runtimeMode = tab.threadId
        ? tab.thread?.runtimeMode
        : (this.vaultOverlapCache?.overlaps ? 'approval-required' : undefined);
      const result = await manager.sendMessage({
        commandId,
        projectId: this.plugin.settings.projectId,
        threadId: tab.threadId,
        text: composeAttachments(prompt, attachmentText),
        ...(modelSelection ? { modelSelection } : {}),
        ...(runtimeMode ? { runtimeMode } : {}),
        ...(tab.thread?.runtimeMode ? { knownRuntimeMode: tab.thread.runtimeMode } : {}),
      });
      if (this.isStaleTab(tab, rev, selectionRevision)) return;

      tab.uncertainCommandId = undefined;
      const isNewThread = tab.threadId !== result.threadId;
      tab.threadId = result.threadId;
      if (tab.draft === draft) {
        tab.draft = '';
        if (tab === this.activeTab) this.draftEl.value = '';
      }
      tab.notes = tab.notes.filter(note => !notes.includes(note));
      if (tab === this.activeTab) this.renderAttachments();
      tab.submitting = false;

      if (isNewThread || !tab.threadSub) {
        await this.attachThreadStream(tab, result.threadId, rev, selectionRevision);
      }
      void manager.refreshThreads().catch(() => undefined);
    } catch (error) {
      if (this.isStaleTab(tab, rev, selectionRevision)) return;
      tab.busy = false;
      tab.runStartedAt = undefined;
      if (error instanceof UncertainWriteError) {
        tab.uncertainCommandId = commandId;
        this.actionError = undefined;
      } else {
        if (manager.activeMode === 'cli') this.ready = false;
        this.actionError = redactSensitiveText(error instanceof Error ? error.message : 'T3 请求失败。');
      }
      this.refreshControls();
    } finally {
      if (rev === this.backendRevision) {
        tab.submitting = false;
        if (this.visible && this.tabs.includes(tab)) {
          this.updateRunTimer();
          this.refreshControls();
        }
      }
    }
  }

  private renderTurnItems(items: TurnItemSummary[]): void {
    this.turnItemsEl.empty();
    const visible = items.filter(i => i.type !== 'compaction').slice(-5);
    this.turnItemsEl.hidden = visible.length === 0;
    for (const item of visible) {
      const pill = this.turnItemsEl.createSpan({ cls: 't3c-turn-pill' });
      const title = item.title ?? item.type;
      pill.setText(item.status ? `${title} · ${item.status}` : title);
      if (item.detail) pill.title = item.detail;
    }
  }

  private renderApprovalCards(tab: SidebarTab): void {
    const caps = this.storeState.capabilities;
    const pending = caps.supportsApprovals
      ? tab.runtimeRequests.filter(req => req.status === 'pending')
      : [];
    const sig = pending.map(r => `${r.id}:${r.status}:${r.command ?? ''}:${r.title ?? ''}:${r.supportsFeedback}`).join('|');
    if (pending.length === 0) {
      this.approvalAreaEl.removeAttribute('data-sig');
      this.approvalAreaEl.empty();
      this.approvalAreaEl.hidden = true;
      return;
    }
    this.approvalAreaEl.hidden = false;
    if (this.approvalAreaEl.getAttribute('data-sig') === sig) return;
    this.approvalAreaEl.empty();
    this.approvalAreaEl.setAttribute('data-sig', sig);

    const rev = this.backendRevision;
    const selectionRevision = tab.selectionRevision;
    for (const req of pending) {
      const card = this.approvalAreaEl.createDiv({ cls: 't3c-approval-card', attr: { role: 'region', 'aria-label': '待确认审批' } });
      card.createEl('strong', { cls: 't3c-approval-title', text: req.title ?? '需要运行审批' });
      if (req.command) {
        card.createEl('code', { cls: 't3c-approval-cmd', text: req.command });
      }
      if (req.detail) {
        card.createEl('p', { cls: 't3c-muted-note', text: req.detail });
      }

      let feedbackInput: HTMLInputElement | undefined;
      if (req.supportsFeedback) {
        feedbackInput = card.createEl('input', {
          cls: 't3c-approval-feedback',
          attr: { type: 'text', placeholder: '可选：填写拒绝原因（仅拒绝时发送）…', 'aria-label': '审批拒绝原因' },
        });
        feedbackInput.value = tab.pendingFeedback.get(req.id) ?? '';
        feedbackInput.oninput = () => {
          if (feedbackInput) tab.pendingFeedback.set(req.id, feedbackInput.value);
        };
      }

      const actions = card.createDiv({ cls: 't3c-approval-actions' });
      const respond = async (decision: 'accept' | 'acceptForSession' | 'decline') => {
        const feedback = decision === 'decline' && req.supportsFeedback
          ? (tab.pendingFeedback.get(req.id) ?? feedbackInput?.value ?? '').trim()
          : undefined;
        await this.ensureManager().respondRuntimeRequest({
          threadId: req.threadId,
          requestId: req.id,
          decision,
          ...(feedback ? { feedback } : {}),
        });
        if (this.isStaleTab(tab, rev, selectionRevision)) return;
        tab.pendingFeedback.delete(req.id);
      };
      const acceptBtn = this.button(actions, '允许一次', () => respond('accept'));
      acceptBtn.addClass('t3c-solid-btn');
      this.button(actions, '本会话允许', () => respond('acceptForSession'));
      this.button(actions, '拒绝', () => respond('decline'));
    }
  }

  private updateRunTimer(): void {
    const anyBusy = this.tabs.some(t => t.busy);
    if (anyBusy && !this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => this.renderRunIndicator(), 1000);
    } else if (!anyBusy && this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
    this.renderRunIndicator();
  }

  private renderRunIndicator(): void {
    if (!this.visible) return;
    const tab = this.activeTab;
    const elapsed = tab.busy && tab.runStartedAt !== undefined
      ? Date.now() - tab.runStartedAt
      : tab.lastElapsedMs;
    if (elapsed === undefined) {
      this.runIndicatorEl.hidden = true;
      return;
    }
    this.runIndicatorEl.hidden = false;
    this.runIndicatorEl.toggleClass('is-shining', tab.busy);
    this.runIndicatorEl.setText(formatElapsedMs(elapsed));
  }

  private threadBlocksSending(tab = this.activeTab): boolean {
    if (!tab.thread) return false;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return true;
    const path = this.plugin.settings.projectPath;
    const vaultPath = adapter.getBasePath();
    if (!path) return tab.thread.runtimeMode !== 'approval-required';
    const isVault = this.vaultOverlapCache?.vaultPath === vaultPath && this.vaultOverlapCache?.projectPath === path
      ? this.vaultOverlapCache.overlaps
      : workspacesOverlap(resolveWorkspacePath(path, vaultPath), vaultPath);
    return isVault && tab.thread.runtimeMode !== 'approval-required';
  }

  private renderTabBadges(): void {
    this.tabBadgesEl.empty();
    for (const tab of this.tabs) {
      const isCurrent = tab.id === this.activeTabId;
      const badge = this.tabBadgesEl.createDiv({
        cls: 't3c-tab-badge',
        attr: {
          'data-tab-status': resolveTabBadgeStatus({
            status: tab.thread?.status,
            pendingRequestCount: tab.thread?.pendingRequestCount,
            unread: tab.unread,
          }),
        },
      });
      const selectBtn = badge.createEl('button', {
        cls: 't3c-tab-badge-select',
        attr: {
          type: 'button',
          'aria-current': String(isCurrent),
          title: tab.thread?.title ?? '新会话',
        },
      });
      if (isCurrent) {
        badge.addClass('is-expanded');
        selectBtn.createSpan({ cls: 't3c-tab-badge-title', text: tab.thread?.title ?? '新会话' });
        if (this.tabs.length > 1) {
          const closeBtn = badge.createEl('button', {
            cls: 't3c-tab-badge-close',
            text: '×',
            attr: { type: 'button', 'aria-label': '关闭标签' },
          });
          closeBtn.onclick = () => this.closeTab(tab.id);
        }
      } else {
        selectBtn.setText(String(tab.badgeNumber));
      }
      selectBtn.onclick = () => this.activateTab(tab.id);
    }
  }

  private refreshNoteFooter(): void {
    if (!this.visible) return;
    const noteView = this.note();
    const hasSelection = Boolean(noteView?.editor.getSelection().trim());
    const noteText = noteView?.file ? (hasSelection ? '选区 · ' : '') + noteView.file.name : '未打开笔记';
    this.noteFooterLabelEl.setText(noteText);
    this.noteFooterBtn.toggleClass('is-excluded', !this.plugin.settings.includeNote);
    this.noteFooterBtn.title = this.plugin.settings.includeNote ? '已附带当前笔记 · 点击排除' : '已排除当前笔记 · 点击恢复附带';
  }

  private refreshBanner(): void {
    if (!this.visible) return;
    const tab = this.activeTab;
    const blocksVault = this.threadBlocksSending(tab);
    const safeLink = this.safeThreadLink(tab.thread);
    const fallbackReason = this.storeState.connectionPhase === 'fallback-cli'
      ? this.storeState.connectionError
      : undefined;
    const displayError = this.actionError
      ?? (this.storeState.connectionPhase === 'disconnected' ? this.storeState.connectionError : undefined);
    const banner = resolveStatusBanner({
      ready: this.ready,
      checking: tab.checking || this.storeState.connectionPhase === 'connecting',
      error: displayError,
      fallbackReason,
      connectionPhase: this.storeState.connectionPhase,
      supportsApprovals: this.storeState.capabilities.supportsApprovals,
      hasUncertainDispatch: Boolean(tab.uncertainCommandId) || this.storeState.pendingDispatches.size > 0,
      blocksVaultSend: blocksVault,
      thread: tab.thread,
      safeLink,
    });
    this.bannerEl.hidden = banner === null;
    if (banner) {
      this.bannerEl.setAttribute('data-tone', banner.tone);
      this.bannerTextEl.setText(banner.message);
      this.bannerRetryBtn.hidden = !banner.showRetry;
      this.bannerRetryBtn.disabled = tab.checking || tab.busy;
      this.bannerLinkEl.hidden = !banner.link;
      if (banner.link) this.bannerLinkEl.href = banner.link;
      else this.bannerLinkEl.removeAttribute('href');
    }
  }

  private refreshSendButton(): void {
    if (!this.visible) return;
    const tab = this.activeTab;
    const blocksVault = this.threadBlocksSending(tab);
    const hasDraft = Boolean(this.draftEl.value.trim());
    const canStop = tab.busy && this.storeState.capabilities.supportsStop && Boolean(tab.threadId);
    this.stopBtn.hidden = !canStop;
    this.stopBtn.disabled = !canStop;
    this.sendBtn.hidden = !hasDraft || canStop;
    this.sendBtn.disabled = !this.ready || tab.busy || tab.checking || !hasDraft || blocksVault;
    this.sendBtn.title = blocksVault ? '使用知识库目录时请在 T3 Code 中确认会话权限为需要审批。' : '发送';
    this.draftEl.readOnly = tab.submitting;
    this.contextTrayEl.querySelectorAll('button').forEach(chip => { chip.disabled = tab.submitting; });
  }

  private refreshUsageGauge(): void {
    const info = formatContextUsage(this.activeTab.contextUsage);
    this.usageLabelEl.setText(info.shortLabel);
    const arcEl = this.usageArcEl as unknown as {
      hidden: boolean;
      setAttribute(k: string, v: string): void;
      toggleClass?: (cls: string, force: boolean) => void;
    };
    if (info.percent === undefined || !this.storeState.capabilities.supportsContextUsage) {
      arcEl.hidden = true;
      return;
    }
    const clamped = Math.max(0, Math.min(100, info.percent));
    arcEl.hidden = false;
    arcEl.setAttribute('stroke-dashoffset', (GAUGE_ARC_LENGTH * (1 - clamped / 100)).toFixed(2));
    arcEl.toggleClass?.('is-warn', clamped >= 75 && clamped < 90);
    arcEl.toggleClass?.('is-danger', clamped >= 90);
  }

  private refreshControls(): void {
    if (!this.visible) return;
    const tab = this.activeTab;
    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    const path = resolveWorkspacePath(this.plugin.settings.projectPath, vaultPath);
    this.wideProjectEl.setText(path ? (basename(path) || path) : '未配置项目');
    this.wideProjectEl.title = path;

    this.renderTabBadges();
    this.refreshBanner();
    this.refreshSendButton();

    const trigger = formatModelTrigger(tab.selection, tab.thread);
    this.modelPrimaryEl.setText(trigger.primary);
    this.modelSecondaryEl.setText(trigger.secondary ? `· ${trigger.secondary}` : '');
    this.modelSecondaryEl.hidden = !trigger.secondary;
    this.modelChipBtn.title = trigger.full;
    const activeProvider = (tab.thread?.providerInstanceId ?? tab.selection?.provider ?? '').toLowerCase();
    setIcon(this.modelIconEl, activeProvider.includes('claude') ? 'sparkles' : 'cpu');

    const previewMode = tab.thread?.runtimeMode ?? (this.vaultOverlapCache?.overlaps ? 'approval-required' : undefined);
    const modeMeta = RUNTIME_MODES.find(m => m.id === previewMode);
    setIcon(this.permIconEl, modeMeta?.icon ?? 'lock');
    this.permLabelEl.setText(modeMeta?.shortLabel ?? (previewMode ? '权限未知' : '权限'));
    this.permChipBtn.toggleClass('is-alert', previewMode === 'full-access');

    this.refreshNoteFooter();
    this.refreshUsageGauge();
    this.renderSessionLists();
  }

  private renderMessages(messages: Message[]): void {
    const nearBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 60;
    this.welcomeEl.hidden = messages.length > 0;
    this.messagesEl.hidden = messages.length === 0;
    this.navRailEl.hidden = messages.length < 2;
    const remaining = new Set(this.rows.keys());
    let cursor = this.messagesEl.firstElementChild;
    for (const message of messages) {
      remaining.delete(message.id);
      const previous = this.rows.get(message.id);
      const entry = previous && previous.message.role === message.role
        ? this.updateExistingRow(previous, message)
        : this.createRow(message, previous);
      if (entry.element !== cursor) this.messagesEl.insertBefore(entry.element, cursor);
      cursor = entry.element.nextElementSibling;
      this.rows.set(message.id, entry);
    }
    for (const id of remaining) {
      const stale = this.rows.get(id);
      if (stale) {
        this.disposeRow(stale);
        stale.element.remove();
      }
      this.rows.delete(id);
    }
    if (nearBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateExistingRow(entry: RowEntry, message: Message): RowEntry {
    if (entry.message.text === message.text && entry.message.streaming === message.streaming) {
      return entry;
    }
    if (message.role === 'user') {
      entry.message = message;
      entry.bodyEl?.setText(message.text);
      return entry;
    }
    if (!entry.bodyEl || entry.message.streaming !== message.streaming) {
      return this.createRow(message, entry);
    }
    entry.message = message;
    this.scheduleAssistantRender(entry, message.text, !message.streaming);
    return entry;
  }

  private createRow(message: Message, previous?: RowEntry): RowEntry {
    if (previous) this.disposeRow(previous);
    const row = previous?.element ?? this.messagesEl.createDiv({ cls: 't3c-msg' });
    row.empty();
    row.toggleClass('is-user', message.role === 'user');
    row.toggleClass('is-assistant', message.role === 'assistant');
    if (message.role === 'user') {
      row.setAttribute('aria-label', '你的消息');
      const bodyEl = row.createDiv({ cls: 't3c-msg-user-body', text: message.text });
      return { message, element: row, bodyEl, renderSeq: (previous?.renderSeq ?? 0) + 1, lastRenderAt: 0 };
    }
    row.removeAttribute('aria-label');
    const bodyEl = row.createDiv({ cls: 't3c-markdown' });
    const entry: RowEntry = {
      message,
      element: row,
      bodyEl,
      renderSeq: (previous?.renderSeq ?? 0) + 1,
      lastRenderAt: 0,
    };
    if (!message.streaming) {
      const actions = row.createDiv({ cls: 't3c-msg-actions' });
      this.iconButton(actions, 'copy', '复制 Markdown', async () => {
        await navigator.clipboard.writeText(entry.message.text);
        if (this.ready && this.actionError) this.setActionError(undefined);
        new Notice('已复制 Markdown。');
      });
      this.iconButton(actions, 'corner-down-left', '插入当前光标处', () => {
        const editor = this.note()?.editor;
        if (!editor) throw new Error('请先打开要插入内容的 Markdown 笔记。');
        editor.replaceRange(entry.message.text, editor.getCursor());
        if (this.ready && this.actionError) this.setActionError(undefined);
      });
    }
    this.scheduleAssistantRender(entry, message.text, !message.streaming);
    return entry;
  }

  private scheduleAssistantRender(entry: RowEntry, text: string, immediate: boolean): void {
    if (entry.lastRenderedText === text) return;
    if (immediate) {
      clearTimeout(entry.throttleTimer);
      entry.throttleTimer = undefined;
      void this.flushAssistantRender(entry, text);
      return;
    }
    const elapsed = Date.now() - entry.lastRenderAt;
    if (elapsed >= 120) {
      clearTimeout(entry.throttleTimer);
      entry.throttleTimer = undefined;
      void this.flushAssistantRender(entry, text);
      return;
    }
    if (entry.throttleTimer !== undefined) return;
    entry.throttleTimer = setTimeout(() => {
      entry.throttleTimer = undefined;
      void this.flushAssistantRender(entry, entry.message.text);
    }, Math.max(16, 120 - elapsed));
  }

  private async flushAssistantRender(entry: RowEntry, text: string): Promise<void> {
    if (!this.visible || !entry.bodyEl) return;
    const seq = ++entry.renderSeq;
    entry.lastRenderAt = Date.now();
    entry.lastRenderedText = text;
    const comp = new Component();
    comp.load();
    const committed = await renderSafeMarkdown(
      this.app,
      text,
      entry.bodyEl,
      comp,
      () => this.visible && Boolean(entry.element.parentElement) && entry.renderSeq === seq,
    );
    if (!committed) {
      comp.unload();
      return;
    }
    const nearBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 60;
    const prev = entry.renderComponent;
    entry.renderComponent = this.addChild(comp);
    if (prev && prev !== comp) {
      this.removeChild(prev);
      prev.unload();
    }
    if (nearBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
