import { Plugin } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import T3CodianView, { VIEW_TYPE_T3_CODIAN } from './ui/T3CodianView';

export default class T3CodianPlugin extends Plugin {
  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_T3_CODIAN, (leaf) => new T3CodianView(leaf));
    this.addCommand({
      id: 't3-codian-open-chat',
      name: '打开 T3-Codian 聊天面板',
      callback: () => this.openChatView(),
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_T3_CODIAN);
    super.onunload();
  }

  private openChatView(): void {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    void leaf.setViewState({ type: VIEW_TYPE_T3_CODIAN });
  }
}
