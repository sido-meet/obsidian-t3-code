import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { FileSystemAdapter, FuzzySuggestModal, ItemView, MarkdownView, Notice, setIcon } from 'obsidian';
import type { TFile, WorkspaceLeaf } from 'obsidian';
import type ObsidianT3CodePlugin from '../main';
import { composePrompt } from '../context';
import { CliChat, cliRunner } from '../t3/cli';
import type { CliThread, ModelSelection } from '../t3/cli';
import { configuredModels } from '../settings';
import { resolveWorkspacePath, workspacesOverlap } from '../t3/workspace';
import { renderMarkdown } from './markdown';
import { composeAttachments } from './note-attachments';
import type { Message } from '../t3/transcript';

export const VIEW_TYPE_OBSIDIAN_T3_CODE = 'obsidian-t3-code-chat-view';
const permissionLabels: Record<string, string> = {
  'approval-required': '需要审批',
  'auto-accept-edits': '自动接受编辑',
  auto: '自动',
  'full-access': '完全访问',
};
const NEW_DRAFT = '';
const runStatusLabels: Record<string, string> = {
  waiting: '等待处理，请在 T3 Code 中查看', queued: '已排队', failed: '任务失败，请在 T3 Code 中查看详情',
  completed: '运行结束', interrupted: '已停止', cancelled: '已取消', rolled_back: '已回滚',
};
const activeStatuses = new Set(['preparing', 'queued', 'starting', 'running', 'waiting', 'working']);

export default class ObsidianT3CodeView extends ItemView {
  private readonly rows = new Map<string, { message: Message; element: HTMLElement }>();
  private chat?: CliChat;
  private controller?: AbortController;
  private poll?: ReturnType<typeof setTimeout>;
  private visible = false;
  private ready = false;
  private busy = false;
  private checking = false;
  private submitting = false;
  private draftScope = '';
  private selectionRevision = 0;
  private thread?: CliThread;
  private selection?: ModelSelection;
  private readonly drafts = new Map<string, { text: string; notes: TFile[] }>();
  private notes: TFile[] = [];
  private attachments!: HTMLElement;
  private titleEl!: HTMLElement;
  private history!: HTMLDetailsElement;
  private historyContent!: HTMLElement;
  private modelChoice!: HTMLDetailsElement;
  private modelLabel!: HTMLElement;
  private modelPanel!: HTMLElement;
  private permissionLabel!: HTMLElement;
  private threadLink!: HTMLAnchorElement;
  private status!: HTMLElement;
  private messages!: HTMLElement;
  private welcome!: HTMLElement;
  private projectLabel!: HTMLElement;
  private contextLabel!: HTMLElement;
  private checkButton!: HTMLButtonElement;
  private resetButton!: HTMLButtonElement;
  private draft!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private includeNote!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianT3CodePlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_OBSIDIAN_T3_CODE; }
  getDisplayText(): string { return 'Obsidian T3 Code'; }

  async onOpen(): Promise<void> {
    this.visible = true;
    const root = this.contentEl;
    root.empty();
    root.addClass('obsidian-t3-code');
    const header = root.createDiv({ cls: 'obsidian-t3-code-header' });
    const identity = header.createDiv({ cls: 'obsidian-t3-code-identity' });
    this.titleEl = identity.createEl('strong', { text: 'T3 Code' });
    this.status = identity.createDiv({ cls: 'obsidian-t3-code-status', attr: { role: 'status' } });
    const actions = header.createDiv({ cls: 'obsidian-t3-code-header-actions' });
    this.checkButton = this.button(actions, '重试', () => this.check());
    this.resetButton = this.button(actions, '新会话', () => this.switchThread());
    this.history = actions.createEl('details', { cls: 'obsidian-t3-code-disclosure obsidian-t3-code-history' });
    this.history.createEl('summary', { text: '历史' });
    this.historyContent = this.history.createDiv({ cls: 'obsidian-t3-code-popover' });
    this.history.ontoggle = () => {
      if (this.history.open) void this.loadHistory();
    };

    this.welcome = root.createDiv({ cls: 'obsidian-t3-code-welcome' });
    setIcon(this.welcome.createDiv({ cls: 'obsidian-t3-code-welcome-icon' }), 'message-square');
    this.welcome.createEl('strong', { text: '与 T3 Code 对话' });
    this.welcome.createEl('p', { text: '提个问题，或附上当前笔记一起讨论。' });
    this.messages = root.createDiv({ cls: 'obsidian-t3-code-messages', attr: { role: 'log', 'aria-live': 'off' } });
    this.messages.hidden = true;

    const composer = root.createDiv({ cls: 'obsidian-t3-code-composer' });
    const input = composer.createDiv({ cls: 'obsidian-t3-code-input' });
    this.draft = input.createEl('textarea', { placeholder: '发送消息…', attr: { 'aria-label': '消息' } });
    const context = input.createDiv({ cls: 'obsidian-t3-code-context' });
    this.projectLabel = context.createDiv({ cls: 'obsidian-t3-code-project' });
    this.button(context, '@ 笔记', () => { this.pickNote(); });
    this.attachments = input.createDiv({ cls: 'obsidian-t3-code-attachments' });
    const label = context.createEl('label', { cls: 'obsidian-t3-code-note' });
    this.includeNote = label.createEl('input', { type: 'checkbox' });
    this.includeNote.checked = this.plugin.settings.includeNote;
    this.contextLabel = label.createSpan();
    this.includeNote.onchange = () => {
      this.refreshControls();
      void this.plugin.updateSettings({ includeNote: this.includeNote.checked })
        .catch(() => this.show('无法保存笔记上下文选项。'));
    };

    const footer = input.createDiv({ cls: 'obsidian-t3-code-footer' });
    this.modelChoice = footer.createEl('details', { cls: 'obsidian-t3-code-disclosure obsidian-t3-code-popover-up obsidian-t3-code-model' });
    this.modelLabel = this.modelChoice.createEl('summary');
    this.modelPanel = this.modelChoice.createDiv({ cls: 'obsidian-t3-code-popover' });
    this.modelChoice.ontoggle = () => { if (this.modelChoice.open) this.renderModels(); };
    const usage = footer.createEl('details', { cls: 'obsidian-t3-code-disclosure obsidian-t3-code-popover-up' });
    usage.createEl('summary', { text: '额度' });
    const usagePanel = usage.createDiv({ cls: 'obsidian-t3-code-popover' });
    usagePanel.createEl('strong', { text: '用量详情' });
    usagePanel.createEl('p', { text: '账户额度 · CLI 暂未提供数据' });
    usagePanel.createEl('p', { text: '上下文占用 · CLI 暂未提供数据' });
    const permissions = footer.createEl('details', { cls: 'obsidian-t3-code-disclosure obsidian-t3-code-popover-up' });
    this.permissionLabel = permissions.createEl('summary', { text: '权限' });
    const permissionPanel = permissions.createDiv({ cls: 'obsidian-t3-code-popover' });
    permissionPanel.createEl('p', { text: '侧栏显示 T3 Code 实际生效的运行权限。权限切换和待处理请求可在 T3 Code 中完成。' });
    this.threadLink = permissionPanel.createEl('a', { text: '在 T3 Code 中打开会话', attr: { target: '_blank', rel: 'noopener noreferrer' } });
    this.threadLink.hidden = true;
    this.sendButton = this.button(footer, '发送', () => this.send());
    this.sendButton.addClass('mod-cta');
    this.draft.oninput = () => this.refreshControls();
    this.draft.onkeydown = event => {
      const cursor = this.draft.selectionStart;
      if (event.key === '@' && !event.isComposing && (cursor === 0 || /\s/.test(this.draft.value[cursor - 1]))) {
        event.preventDefault();
        this.pickNote();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.sendButton.disabled) this.sendButton.click();
      }
    };
    this.registerDomEvent(root.ownerDocument, 'pointerdown', event => {
      for (const disclosure of [this.history, this.modelChoice, usage, permissions]) {
        if (disclosure.open && !disclosure.contains(event.target as Node | null)) disclosure.open = false;
      }
    });
    this.registerDomEvent(root, 'keydown', event => {
      if (event.key !== 'Escape') return;
      const disclosure = [this.history, this.modelChoice, usage, permissions].find(item => item.open);
      if (!disclosure) return;
      event.preventDefault();
      event.stopPropagation();
      disclosure.open = false;
      disclosure.querySelector('summary')?.focus();
    });
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshControls()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshControls()));
    this.registerDomEvent(root.ownerDocument, 'selectionchange', () => this.refreshControls());
    this.backendChanged();
  }

  async onClose(): Promise<void> {
    this.visible = false;
    clearTimeout(this.poll);
    this.controller?.abort();
    this.rows.clear();
  }
  private button(parent: HTMLElement, text: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl('button', { text, type: 'button' });
    button.onclick = () => { void Promise.resolve().then(action).catch(error => {
      this.show(error instanceof Error ? error.message : '操作失败。');
    }); };
    return button;
  }

  backendChanged(): void {
    if (!this.visible) return;
    if (this.chat) this.saveDraft(this.chat.threadId);
    clearTimeout(this.poll);
    this.controller?.abort();
    this.controller = new AbortController();
    const { cliPath, projectPath, projectId } = this.plugin.settings;
    this.draftScope = JSON.stringify([cliPath, projectPath, projectId]);
    this.chat = new CliChat(cliRunner(cliPath, this.controller.signal));
    this.selectionRevision++;
    this.ready = false;
    this.busy = false;
    this.checking = false;
    this.thread = undefined;
    this.selection = configuredModels(this.plugin.settings)[0];
    this.submitting = false;
    const saved = this.drafts.get(this.draftKey());
    this.draft.value = saved?.text ?? '';
    this.notes = saved?.notes ?? [];
    this.renderAttachments();
    this.render([]);
    void this.check();
  }

  modelsChanged(): void {
    this.selection = configuredModels(this.plugin.settings)[0];
    if (this.modelChoice?.open) this.renderModels();
    this.refreshControls();
  }

  private draftKey(threadId = NEW_DRAFT): string {
    return JSON.stringify([this.draftScope, threadId]);
  }

  private saveDraft(threadId?: string): void {
    this.drafts.set(this.draftKey(threadId), { text: this.draft.value, notes: this.notes });
  }

  private async loadHistory(): Promise<void> {
    const chat = this.chat;
    this.historyContent.empty();
    this.historyContent.createEl('p', { text: '正在读取会话…' });
    if (!chat) return;
    try {
      const list = await chat.list(await this.project());
      if (this.chat !== chat || !this.visible || !this.history.open) return;
      this.historyContent.empty();
      if (!list.length) this.historyContent.createEl('p', { text: '此项目还没有会话。' });
      for (const thread of list) {
        const button = this.button(this.historyContent, thread.title, () => this.switchThread(thread));
        button.disabled = this.submitting || this.checking;
        button.title = [thread.providerInstanceId, thread.model].filter(Boolean).join(' · ');
        if (thread.threadId === chat.threadId) button.setAttribute('aria-current', 'true');
      }
    } catch {
      if (this.chat !== chat || !this.visible) return;
      this.historyContent.setText('读取会话失败。请检查本地 T3 Code 连接。');
    }
  }

  private async switchThread(thread?: CliThread, keepDraft = false): Promise<void> {
    const chat = this.chat;
    if (!chat || !this.ready || this.submitting || this.checking || (thread && thread.threadId === chat.threadId)) return;
    const currentDraft = this.draft.value;
    this.saveDraft(chat.threadId);
    clearTimeout(this.poll);
    this.selectionRevision++;
    this.busy = false;
    this.thread = thread;
    chat.threadId = thread?.threadId;
    const target = this.drafts.get(this.draftKey(chat.threadId));
    this.draft.value = keepDraft ? currentDraft : target?.text ?? '';
    this.notes = keepDraft ? [...this.notes] : target?.notes ?? [];
    this.renderAttachments();
    this.history.open = false;
    this.render([]);
    this.draft.focus();
    if (!thread) {
      this.show('本地 CLI 已连接');
      return;
    }
    this.checking = true;
    this.show('正在恢复会话…');
    this.refreshControls();
    try {
      await this.read(chat);
    } catch (error) {
      if (this.chat !== chat || !this.visible) return;
      this.ready = false;
      this.show(error instanceof Error ? error.message : '无法恢复会话。');
    } finally {
      if (this.chat === chat) {
        this.checking = false;
        this.refreshControls();
      }
    }
  }

  private renderModels(): void {
    const panel = this.modelPanel;
    panel.empty();
    if (this.chat?.threadId) {
      panel.createEl('p', { text: '当前 CLI 在创建会话时设置模型。' });
      const button = this.button(panel, '带着草稿新开会话', async () => {
        await this.switchThread(undefined, true);
        if (!this.chat?.threadId) this.renderModels();
      });
      button.disabled = !this.ready || this.submitting || this.checking;
      return;
    }
    const entries = configuredModels(this.plugin.settings);
    const selection = this.selection ?? entries[0];
    const select = (labelText: string, values: string[], selected: string, change: (value: string) => void) => {
      const label = panel.createEl('label');
      label.createSpan({ text: labelText });
      const input = label.createEl('select', { attr: { 'aria-label': labelText } });
      for (const value of new Set(values)) input.createEl('option', { value, text: value || '默认' });
      input.value = selected;
      input.onchange = () => {
        change(input.value);
        this.renderModels();
        panel.querySelector<HTMLSelectElement>('select[aria-label='+JSON.stringify(labelText)+']')?.focus();
        this.refreshControls();
      };
    };
    select('Agent', entries.map(entry => entry.provider), selection.provider, provider => {
      this.selection = entries.find(entry => entry.provider === provider);
    });
    const agentModels = entries.filter(entry => entry.provider === selection.provider);
    select('模型', agentModels.map(entry => entry.model), selection.model, model => {
      this.selection = agentModels.find(entry => entry.model === model);
    });
    const options = agentModels.filter(entry => entry.model === selection.model);
    if (options.some(entry => entry.option)) {
      select('推理选项', options.map(entry => entry.option ?? ''), selection.option ?? '', option => {
        this.selection = options.find(entry => (entry.option ?? '') === option);
      });
    }
    if (entries.length === 1) panel.createEl('p', { text: '可在插件设置添加其他 Agent 和模型预设。' });
  }
  private show(message: string): void {
    if (this.visible) this.status.setText(message);
  }

  private async project(): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('无法取得当前知识库的本地目录。');
    const vaultPath = adapter.getBasePath();
    const path = resolveWorkspacePath(this.plugin.settings.projectPath, vaultPath);
    if (!isAbsolute(path)) throw new Error('请输入 T3 项目绝对路径。');
    const [vault, workspace] = await Promise.all([realpath(vaultPath), realpath(path)])
      .catch(() => { throw new Error('无法访问 T3 项目目录。'); });
    if (vault !== workspace && workspacesOverlap(vault, workspace)) {
      throw new Error('请使用当前知识库目录，或选择与知识库分离的项目。');
    }
    const id = this.plugin.settings.projectId;
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) {
      throw new Error('请在插件设置绑定当前目录在 T3 Code 中登记的项目 ID。');
    }
    const chat = this.chat;
    if (!chat) throw new Error('T3 CLI 未连接。');
    const threads = await chat.list(workspace);
    if (threads.some(thread => thread.projectId !== id)) {
      throw new Error('当前目录解析到了其他项目。请核对已登记的项目根目录和项目 ID。');
    }
    return id;
  }

  private async check(): Promise<void> {
    const chat = this.chat;
    if (!chat || this.checking || this.busy) return;
    this.checking = true;
    this.show('正在检查 T3 CLI…');
    this.refreshControls();
    try {
      await chat.check(await this.project());
      if (this.chat !== chat || !this.visible) return;
      this.ready = true;
      this.show('本地 CLI 已连接');
      if (chat.threadId) await this.read(chat);
    } catch (error) {
      if (this.chat !== chat || !this.visible) return;
      this.ready = false;
      this.show(error instanceof Error ? error.message : '无法检查 T3 CLI。');
    } finally {
      if (this.chat === chat) {
        this.checking = false;
        this.refreshControls();
      }
    }
  }

  private note(): MarkdownView | undefined {
    const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    return view instanceof MarkdownView && view.file ? view : undefined;
  }

  private pickNote(): void {
    if (this.submitting) return;
    const selectionRevision = this.selectionRevision;
    const available = () => this.app.vault.getMarkdownFiles().filter(file => !this.notes.includes(file));
    const attach = (file: TFile) => {
      if (!this.visible || this.selectionRevision !== selectionRevision || this.submitting || this.notes.includes(file)) return;
      this.notes = [...this.notes, file];
      this.renderAttachments();
      this.draft.focus();
    };
    new class NotePicker extends FuzzySuggestModal<TFile> {
      getItems(): TFile[] { return available(); }
      getItemText(file: TFile): string { return file.path; }
      onChooseItem(file: TFile): void { attach(file); }
    }(this.app).open();
  }
  private renderAttachments(): void {
    this.attachments.empty();
    this.attachments.hidden = this.notes.length === 0;
    for (const file of this.notes) {
      const chip = this.button(this.attachments, file.basename + ' ×', () => {
        if (this.submitting) return;
        this.notes = this.notes.filter(item => item !== file);
        this.renderAttachments();
      });
      chip.title = file.path;
      chip.setAttribute('aria-label', '移除引用 ' + file.path);
    }
  }

  private async send(): Promise<void> {
    const chat = this.chat;
    const draft = this.draft.value;
    const notes = this.notes;
    if (!chat || !this.ready || this.busy || this.checking || !draft.trim() || this.threadBlocksSending()) return;
    this.busy = true;
    this.submitting = true;
    this.show('正在提交…');
    this.refreshControls();
    const view = this.includeNote.checked ? this.note() : undefined;
    const selection = view?.editor.getSelection() ?? '';
    const prompt = composePrompt(draft.trim(), view?.file ? {
      path: view.file.path, selection, body: selection.trim() ? '' : view.editor.getValue(),
    } : undefined);
    try {
      const project = await this.project();
      if (this.chat !== chat || !this.visible) return;
      const activeNote = this.note();
      const attachmentText = await Promise.all(notes.filter(file => file !== view?.file).map(async file => {
        const read = file === activeNote?.file ? Promise.resolve(activeNote.editor.getValue()) : this.app.vault.cachedRead(file);
        const text = await read
          .catch(() => { throw new Error('无法读取引用笔记 ' + file.path); });
        return { path: file.path, text };
      }));
      if (this.chat !== chat || !this.visible) return;
      const wasNew = !chat.threadId;
      const runId = await chat.send(project, composeAttachments(prompt, attachmentText), this.selection);
      if (this.chat !== chat || !this.visible) return;
      if (this.draft.value === draft) this.draft.value = '';
      this.notes = this.notes.filter(note => !notes.includes(note));
      this.renderAttachments();
      if (wasNew) this.drafts.delete(this.draftKey());
      this.submitting = false;
      await this.read(chat, runId);
    } catch (error) {
      if (this.chat !== chat || !this.visible) return;
      this.busy = false;
      this.ready = false;
      this.refreshControls();
      this.show(error instanceof Error ? error.message : 'T3 CLI 请求失败。');
    } finally {
      if (this.chat === chat && this.visible) {
        this.submitting = false;
        this.refreshControls();
      }
    }
  }

  private async read(chat: CliChat, expectedRun?: string, remaining = 15): Promise<void> {
    const selectionRevision = this.selectionRevision;
    const snapshot = await chat.read();
    if (!snapshot || this.chat !== chat || !this.visible || this.selectionRevision !== selectionRevision) return;
    this.thread = snapshot.thread;
    const pending = Boolean(expectedRun && expectedRun !== snapshot.latestRunId && !snapshot.runIds.includes(expectedRun) && remaining > 0);
    this.busy = activeStatuses.has(snapshot.status) || pending;
    this.show(runStatusLabels[snapshot.status] ?? (this.busy ? '正在运行…' : '本地 CLI 已连接'));
    this.render(snapshot.messages);
    if (this.busy) {
      this.poll = setTimeout(() => {
        void this.read(chat, expectedRun, remaining - 1).catch(error => {
          if (this.chat !== chat || !this.visible || this.selectionRevision !== selectionRevision) return;
          this.ready = false;
          this.busy = false;
          this.refreshControls();
          this.show(error instanceof Error ? error.message : '无法更新会话。');
        });
      }, 1600);
    }
  }

  private threadBlocksSending(): boolean {
    if (!this.thread) return false;
    const adapter = this.app.vault.adapter;
    const path = this.plugin.settings.projectPath;
    const isVault = !path || (adapter instanceof FileSystemAdapter && path === adapter.getBasePath());
    return isVault && this.thread.runtimeMode !== 'approval-required';
  }

  private refreshControls(): void {
    if (!this.visible) return;
    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    const path = resolveWorkspacePath(this.plugin.settings.projectPath, vaultPath);
    this.projectLabel.setText(path ? basename(path) : '未配置项目');
    this.projectLabel.title = path;
    this.checkButton.disabled = this.checking || this.busy;
    this.historyContent.querySelectorAll('button').forEach(button => { button.disabled = this.submitting || this.checking; });
    this.resetButton.disabled = !this.ready || this.submitting || this.checking || !this.chat?.threadId;
    this.sendButton.disabled = !this.ready || this.busy || this.checking || !this.draft.value.trim() || this.threadBlocksSending();
    this.sendButton.title = this.threadBlocksSending() ? '使用知识库目录时请在 T3 Code 中确认会话权限为需要审批。' : '发送';
    this.draft.readOnly = this.submitting;
    this.includeNote.disabled = this.submitting;
    this.attachments.querySelectorAll('button').forEach(chip => { chip.disabled = this.submitting; });
    this.status.toggleClass('is-connected', this.ready);
    this.titleEl.setText(this.thread?.title ?? 'T3 Code');
    const model = this.chat?.threadId
      ? [this.thread?.providerInstanceId, this.thread?.model].filter(Boolean).join(' · ')
      : [this.selection?.provider, this.selection?.model, this.selection?.option?.split('=')[1]].filter(Boolean).join(' · ');
    this.modelLabel.setText(model || 'Agent · 模型');
    this.modelLabel.title = model || 'Agent · 模型';
    const mode = this.thread?.runtimeMode;
    this.permissionLabel.setText(mode ? permissionLabels[mode] ?? '权限未知' : '权限');
    this.permissionLabel.toggleClass('is-full-access', mode === 'full-access');
    const link = this.thread?.link;
    const safeLink = link && /^https:\/\/app\.t3\.codes\/threads\//i.test(link) ? link : undefined;
    this.threadLink.hidden = !safeLink;
    if (safeLink) this.threadLink.href = safeLink;
    else this.threadLink.removeAttribute('href');
    const note = this.note();
    const hasSelection = Boolean(note?.editor.getSelection().trim());
    this.contextLabel.setText(note?.file ? (hasSelection ? '选区 · ' : '笔记 · ') + note.file.name : '引用当前笔记');
    this.contextLabel.title = this.includeNote.checked ? '取消本轮笔记引用' : '引用当前笔记';
  }

  private render(messages: Message[]): void {
    this.refreshControls();
    const nearBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 60;
    this.welcome.hidden = messages.length > 0;
    this.messages.hidden = messages.length === 0;
    const remaining = new Set(this.rows.keys());
    let cursor = this.messages.firstElementChild;
    for (const message of messages) {
      remaining.delete(message.id);
      const previous = this.rows.get(message.id);
      const entry = previous?.message.text === message.text && previous.message.role === message.role
        ? previous : this.createRow(message, previous?.element);
      if (entry.element !== cursor) this.messages.insertBefore(entry.element, cursor);
      cursor = entry.element.nextElementSibling;
      this.rows.set(message.id, entry);
    }
    for (const id of remaining) {
      this.rows.get(id)?.element.remove();
      this.rows.delete(id);
    }
    if (nearBottom) this.messages.scrollTop = this.messages.scrollHeight;
  }
  private createRow(message: Message, element?: HTMLElement) {
    const row = element ?? this.messages.createDiv({ cls: 'obsidian-t3-code-message' });
    row.empty();
    row.toggleClass('is-user', message.role === 'user');
    if (message.role === 'assistant') row.createEl('strong', { text: '助手' });
    else row.setAttribute('aria-label', '你的消息');
    if (message.role === 'assistant' && !message.streaming) {
      const rendered = row.createDiv({ cls: 'obsidian-t3-code-markdown' });
      try {
        rendered.innerHTML = renderMarkdown(message.text);
      } catch {
        rendered.addClass('obsidian-t3-code-message-body');
        rendered.setText(message.text);
      }
      const actions = row.createDiv({ cls: 'obsidian-t3-code-actions' });
      this.button(actions, '复制 Markdown', async () => {
        await navigator.clipboard.writeText(message.text);
        new Notice('已复制 Markdown。');
      });
      this.button(actions, '插入当前光标处', () => {
        const editor = this.note()?.editor;
        if (!editor) throw new Error('请先打开要插入内容的 Markdown 笔记。');
        editor.replaceRange(message.text, editor.getCursor());
      });
    } else {
      row.createDiv({ cls: 'obsidian-t3-code-message-body', text: message.text });
    }
    return { message, element: row };
  }
}
