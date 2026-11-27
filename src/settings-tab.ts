import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianT3CodePlugin from './main';
import { loopbackOrigin } from './settings';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianT3CodePlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    let origin = this.plugin.settings.origin;
    new Setting(this.containerEl)
      .setName('本地 T3 服务')
      .setDesc('更改地址后，在对话侧栏重新配对。')
      .addText(text => text.setValue(origin).onChange(value => { origin = value; }))
      .addButton(button => button.setButtonText('保存').onClick(async () => {
        try {
          await this.plugin.updateSettings({ origin: loopbackOrigin(origin.trim()) });
          new Notice('T3 服务地址已保存。');
        } catch (error) {
          new Notice(error instanceof Error ? error.message : '无法保存 T3 设置。');
        }
      }));
  }
}
