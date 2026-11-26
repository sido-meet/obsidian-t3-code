import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianT3CodePlugin from './main';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianT3CodePlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    let { cliPath, projectPath, projectId, provider, model, modelPresets } = this.plugin.settings;
    new Setting(this.containerEl)
      .setName('T3 CLI 路径')
      .addText(text => text.setValue(cliPath).onChange(value => { cliPath = value; }));
    new Setting(this.containerEl)
      .setName('T3 项目目录')
      .setDesc('留空时使用当前知识库目录。请在 T3 Code 中注册该目录，并将项目默认运行权限设为「需要审批」。')
      .addText(text => text.setValue(projectPath).onChange(value => { projectPath = value; }));
    new Setting(this.containerEl)
      .setName('T3 项目 ID')
      .setDesc('填写此目录在 T3 Code 中登记的项目 ID，确保 CLI 连接到指定项目。')
      .addText(text => text.setValue(projectId).onChange(value => { projectId = value; }));
    new Setting(this.containerEl)
      .setName('Provider 实例 ID')
      .addText(text => text.setValue(provider).onChange(value => { provider = value; }));
    new Setting(this.containerEl)
      .setName('模型')
      .addText(text => text.setValue(model).onChange(value => { model = value; }));
    new Setting(this.containerEl)
      .setName('侧栏模型预设')
      .setDesc('每行填写 Provider 实例 ID | 模型 | 可选 CLI 参数，例如 codex | gpt-6-astra | reasoningEffort=high。')
      .addTextArea(text => text.setValue(modelPresets).onChange(value => { modelPresets = value; }));
    new Setting(this.containerEl).addButton(button => button.setButtonText('保存').onClick(async () => {
      try {
        await this.plugin.updateSettings({ cliPath: cliPath.trim(), projectPath: projectPath.trim(), projectId, provider, model, modelPresets });
        new Notice('T3 CLI 设置已保存。');
      } catch {
        new Notice('无法保存 T3 CLI 设置。');
      }
    }));
  }
}
