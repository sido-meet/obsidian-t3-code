import { Notice, Plugin } from 'obsidian';
import type { App, PluginManifest, WorkspaceLeaf } from 'obsidian';
import { normalizeSettings } from './settings';
import type { Settings } from './settings';
import { SettingsTab } from './settings-tab';
import ObsidianT3CodeView, { VIEW_TYPE_OBSIDIAN_T3_CODE } from './ui/ObsidianT3CodeView';

export default class ObsidianT3CodePlugin extends Plugin {
  settings = normalizeSettings(null);
  private saving = Promise.resolve();
  private opening?: Promise<WorkspaceLeaf>;
  private unloaded = false;

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const write = this.saving.then(async () => {
      const settings = normalizeSettings({ ...this.settings, ...patch });
      await this.saveData(settings);
      const changedBackend = settings.cliPath !== this.settings.cliPath || settings.projectPath !== this.settings.projectPath || settings.projectId !== this.settings.projectId;
      const changedModels = settings.provider !== this.settings.provider || settings.model !== this.settings.model ||
        settings.modelPresets !== this.settings.modelPresets;
      this.settings = settings;
      if (changedBackend || changedModels) {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIDIAN_T3_CODE)) {
          if (!(leaf.view instanceof ObsidianT3CodeView)) continue;
          if (changedBackend) leaf.view.backendChanged();
          else leaf.view.modelsChanged();
        }
      }
    });
    this.saving = write.catch(() => undefined);
    return write;
  }

  constructor(app: App, manifest: PluginManifest) { super(app, manifest); }

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerView(VIEW_TYPE_OBSIDIAN_T3_CODE, leaf => new ObsidianT3CodeView(leaf, this));
    this.addRibbonIcon('message-square', 'Obsidian T3 Code', () => this.openChatView());
    this.addCommand({
      id: 'obsidian-t3-code-open-chat',
      name: '打开 Obsidian T3 Code 聊天面板',
      callback: () => this.openChatView(),
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OBSIDIAN_T3_CODE);
    super.onunload();
  }

  private openChatView(): void {
    const workspace = this.app.workspace;
    if (!this.opening) {
      const existing = workspace.getLeavesOfType(VIEW_TYPE_OBSIDIAN_T3_CODE)[0];
      if (existing) {
        void workspace.revealLeaf(existing).catch(() => new Notice('无法显示 Obsidian T3 Code 侧栏。'));
        return;
      }
      const leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      this.opening = leaf.setViewState({ type: VIEW_TYPE_OBSIDIAN_T3_CODE, active: true })
        .then(() => leaf).finally(() => { this.opening = undefined; });
    }
    void this.opening.then(leaf => {
      if (!this.unloaded) return workspace.revealLeaf(leaf);
    }).catch(() => new Notice('无法显示 Obsidian T3 Code 侧栏。'));
  }
}
