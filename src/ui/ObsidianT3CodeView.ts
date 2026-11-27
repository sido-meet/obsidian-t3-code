import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { FileSystemAdapter, ItemView, MarkdownView, Notice } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type ObsidianT3CodePlugin from '../main';
import { composePrompt } from '../context';
import { T3Connection } from '../t3/connection';
import type { T3Project } from '../t3/connection';
import type { T3Rpc } from '../t3/rpc';
import { ChatSession } from '../t3/session';
import { workspacesOverlap } from '../t3/workspace';
import { renderMarkdown } from './markdown';
import type { Message } from '../t3/transcript';

export const VIEW_TYPE_OBSIDIAN_T3_CODE = 'obsidian-t3-code-chat-view';

export default class ObsidianT3CodeView extends ItemView {
  private readonly session = new ChatSession(() => this.scheduleRender(), message => this.show(message));
  private connection?: T3Connection;
  private origin?: string;
  private rpc?: T3Rpc;
  private generation = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private readonly rows = new Map<string, { message: Message; element: HTMLElement }>();
  private projects: T3Project[] = [];
  private visible = false;
  private pairing = false;
  private status!: HTMLElement;
  private messages!: HTMLElement;
  private sessionId!: HTMLElement;
  private code!: HTMLInputElement;
  private pairButton!: HTMLButtonElement;
  private project!: HTMLSelectElement;
  private draft!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private resetButton!: HTMLButtonElement;
  private includeNote!: HTMLInputElement;
  private contextLabel!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianT3CodePlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_OBSIDIAN_T3_CODE; }
  getDisplayText(): string { return 'Obsidian T3 Code'; }

  async onOpen(): Promise<void> {
    this.visible = true;
    this.rows.clear();
    const root = this.contentEl;
    root.empty();
    root.addClass('obsidian-t3-code');
    const header = root.createDiv({ cls: 'obsidian-t3-code-header' });
    header.createEl('strong', { text: 'T3 Code · Codex' });
    this.status = header.createDiv({ attr: { role: 'status' } });
    this.sessionId = header.createDiv({ cls: 'obsidian-t3-code-thread' });
    const controls = root.createDiv({ cls: 'obsidian-t3-code-controls' });
    this.code = controls.createEl('input', {
      type: 'password', placeholder: 'T3 一次性配对码',
      attr: { 'aria-label': 'T3 一次性配对码', autocomplete: 'off' },
    });
    this.pairButton = this.button(controls, '连接', () => this.pair());
    this.project = controls.createEl('select', { attr: { 'aria-label': 'T3 项目' } });
    this.project.onchange = () => this.refreshControls();
    this.resetButton = this.button(controls, '新会话', () => { this.session.reset(); });
    this.messages = root.createDiv({ cls: 'obsidian-t3-code-messages', attr: { role: 'log', 'aria-live': 'off' } });
    const composer = root.createDiv({ cls: 'obsidian-t3-code-composer' });
    const label = composer.createEl('label');
    this.includeNote = label.createEl('input', { type: 'checkbox' });
    this.includeNote.checked = this.plugin.settings.includeNote;
    this.includeNote.onchange = () => {
      this.scheduleRender();
      void this.plugin.updateSettings({ includeNote: this.includeNote.checked })
        .catch(() => this.show('无法保存笔记上下文选项。'));
    };
    this.contextLabel = label.createSpan();
    this.draft = composer.createEl('textarea', { placeholder: '输入消息', attr: { 'aria-label': '消息' } });
    const actions = composer.createDiv({ cls: 'obsidian-t3-code-actions' });
    this.sendButton = this.button(actions, '发送', () => this.send());
    this.sendButton.addClass('mod-cta');
    this.stopButton = this.button(actions, '停止', () => this.session.stop());
    this.draft.oninput = () => this.refreshControls();
    this.draft.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.sendButton.disabled) this.sendButton.click();
      }
    };
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleRender()));
    this.show('未连接。启动本地 T3 Code 并输入配对码。');
    this.render();
  }

  async onClose(): Promise<void> {
    this.visible = false;
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.rpc?.close();
    this.rpc = undefined;
    this.rows.clear();
  }

  private button(parent: HTMLElement, text: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl('button', { text, type: 'button' });
    button.onclick = () => { void Promise.resolve().then(action).catch(error => {
      this.show(error instanceof Error ? error.message : '操作失败。');
    }); };
    return button;
  }

  addressChanged(): void {
    this.generation++;
    clearTimeout(this.retry);
    this.rpc?.close();
    this.rpc = undefined;
    this.connection = undefined;
    this.origin = undefined;
    this.show('服务地址已更改，请重新配对。');
    this.scheduleRender();
  }

  private show(message: string): void {
    if (this.visible) this.status.setText(message);
  }

  private async pair(): Promise<void> {
    if (this.pairing) return;
    const code = this.code.value.trim();
    if (!code && (!this.connection || this.origin !== this.plugin.settings.origin)) {
      this.show('请输入当前 T3 服务的一次性配对码。');
      return;
    }
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.rpc?.close();
    this.rpc = undefined;
    this.pairing = true;
    this.refreshControls();
    try {
      const origin = this.plugin.settings.origin;
      if (code) {
        const connection = new T3Connection(origin);
        this.show('正在配对…');
        await connection.pair(code);
        if (generation !== this.generation) return;
        this.session.reset();
        this.connection = connection;
        this.origin = origin;
        this.code.value = '';
      }
      await this.connect(generation);
    } finally {
      this.pairing = false;
      this.scheduleRender();
    }
  }

  private async connect(generation: number): Promise<void> {
    const connection = this.connection;
    if (!connection || generation !== this.generation) return;
    const projects = await connection.projects();
    const rpc = await connection.open();
    if (generation !== this.generation) { rpc.close(); return; }
    const selected = this.project.value;
    this.projects = projects;
    this.project.empty();
    this.project.createEl('option', { text: '选择 Vault 外的 T3 项目', value: '' });
    for (const project of projects) this.project.createEl('option', { text: project.title, value: project.id });
    this.project.value = projects.some(project => project.id === selected) ? selected : '';
    this.rpc = rpc;
    this.session.attach(rpc);
    this.show(projects.length ? '已连接' : '已连接。请在 T3 Code 中添加一个 Vault 外的项目。');
    this.refreshControls();
    this.scheduleRender();
    void rpc.disconnected.then(() => {
      if (generation !== this.generation) return;
      this.rpc = undefined;
      this.scheduleRender();
      this.reconnect(generation, 0);
    });
  }

  private reconnect(generation: number, attempt: number): void {
    if (generation !== this.generation) return;
    if (attempt >= 5 || this.origin !== this.plugin.settings.origin) {
      this.show('T3 连接已中断。点击连接重试，或输入新配对码。');
      return;
    }
    this.show('T3 连接中断，正在重连…');
    this.retry = setTimeout(() => {
      void this.connect(generation).catch(() => this.reconnect(generation, attempt + 1));
    }, Math.min(1000 * 2 ** attempt, 8000));
  }

  private note(): MarkdownView | undefined {
    const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    return view instanceof MarkdownView && view.file ? view : undefined;
  }

  private async send(): Promise<void> {
    if (!this.rpc || this.session.busy || this.origin !== this.plugin.settings.origin) return;
    const text = this.draft.value.trim();
    const project = this.projects.find(item => item.id === this.project.value);
    const adapter = this.app.vault.adapter;
    if (!text || !project || (this.session.projectId && project.id !== this.session.projectId)) return;
    if (!(adapter instanceof FileSystemAdapter) || !isAbsolute(project.root)) {
      throw new Error('无法确认 T3 项目目录与 Vault 隔离。');
    }
    const original = this.draft.value;
    this.sendButton.disabled = true;
    const view = this.includeNote.checked ? this.note() : undefined;
    const selection = view?.editor.getSelection() ?? '';
    const prompt = composePrompt(text, view?.file ? {
      path: view.file.path, selection, body: selection.trim() ? '' : view.editor.getValue(),
    } : undefined);
    let dispatched = false;
    try {
      const [vault, workspace] = await Promise.all([realpath(adapter.getBasePath()), realpath(project.root)])
        .catch(() => { throw new Error('无法验证 T3 项目目录。请选择本机可访问的项目。'); });
      if (workspacesOverlap(vault, workspace)) throw new Error('请选择与 Vault 完全分离的 T3 项目。');
      if (!this.visible || !this.rpc || this.session.busy || this.origin !== this.plugin.settings.origin ||
          project.id !== this.project.value || original !== this.draft.value) return;
      this.show('已连接');
      dispatched = true;
      this.draft.value = '';
      await this.session.send(project, prompt);
    } catch (error) {
      if (dispatched && !this.draft.value) this.draft.value = original;
      throw error;
    } finally {
      this.scheduleRender();
    }
  }

  private refreshControls(): void {
    const connected = Boolean(this.rpc && this.origin === this.plugin.settings.origin);
    const busy = this.session.busy;
    this.pairButton.disabled = this.pairing;
    this.project.disabled = !connected || busy || Boolean(this.session.projectId);
    this.sendButton.disabled = !connected || busy || !this.project.value || !this.draft.value.trim();
    this.stopButton.disabled = !connected || !this.session.transcript.activeRun;
    this.resetButton.disabled = this.pairing || Boolean(connected && busy) || !this.session.threadId;
    this.sessionId.setText(this.session.threadId ?? '');
    const note = this.note();
    this.contextLabel.setText(note?.file ? '包含笔记 · ' + note.file.name : '包含当前笔记');
  }

  private scheduleRender(): void {
    if (!this.visible || this.renderTimer !== undefined) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (this.visible) this.render();
    }, 50);
  }

  private render(): void {
    this.refreshControls();
    const nearBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 60;
    const remaining = new Set(this.rows.keys());
    let cursor = this.messages.firstElementChild;
    for (const message of this.session.transcript.messages) {
      remaining.delete(message.id);
      const previous = this.rows.get(message.id);
      const entry = previous?.message === message ? previous : this.createRow(message, previous?.element);
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
    row.createEl('strong', { text: message.role === 'assistant' ? 'Codex' : '你' });
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
