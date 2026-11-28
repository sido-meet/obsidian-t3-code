import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianT3CodePlugin from './main';
import type { BackendPreference } from './settings';
import { redactSensitiveText } from './t3/auth';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianT3CodePlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    let {
      cliPath,
      projectPath,
      projectId,
      provider,
      model,
      modelPresets,
      serverUrl,
      backendPreference,
    } = this.plugin.settings;
    let pairingCode = '';

    new Setting(this.containerEl)
      .setName('后端连接模式')
      .setDesc('默认优先通过 WebSocket RPC 连接本地 T3 Code Server；无服务或协议不兼容时自动降级为 CLI。')
      .addDropdown(dropdown => dropdown
        .addOption('auto', 'RPC 优先 + CLI 降级（推荐）')
        .addOption('cli', '仅使用 CLI 模式')
        .setValue(backendPreference)
        .onChange(value => {
          backendPreference = (value === 'cli' ? 'cli' : 'auto') as BackendPreference;
        }));
    new Setting(this.containerEl)
      .setName('T3 服务地址（可选）')
      .setDesc('留空时自动读取本地 T3 Code 运行时；填写时仅允许本机回环地址（如 http://127.0.0.1:3773）。')
      .addText(text => text.setPlaceholder('http://127.0.0.1:3773').setValue(serverUrl).onChange(value => { serverUrl = value; }));
    new Setting(this.containerEl)
      .setName('T3 CLI 路径')
      .addText(text => text.setValue(cliPath).onChange(value => { cliPath = value; }));
    new Setting(this.containerEl)
      .setName('T3 项目目录')
      .setDesc('留空时使用当前知识库目录。请在 T3 Code 中注册该目录，并将项目默认运行权限设为「需要审批」。')
      .addText(text => text.setValue(projectPath).onChange(value => { projectPath = value; }));
    new Setting(this.containerEl)
      .setName('T3 项目 ID')
      .setDesc('RPC 模式下留空将按目录自动匹配；CLI 降级模式需填写项目 ID。')
      .addText(text => text.setValue(projectId).onChange(value => { projectId = value; }));
    new Setting(this.containerEl)
      .setName('默认 Provider 实例 ID')
      .addText(text => text.setValue(provider).onChange(value => { provider = value; }));
    new Setting(this.containerEl)
      .setName('默认模型')
      .addText(text => text.setValue(model).onChange(value => { model = value; }));
    new Setting(this.containerEl)
      .setName('CLI 降级模型预设')
      .setDesc('仅在 CLI 降级模式下使用，每行填写 Provider 实例 ID | 模型 | 可选 CLI 参数，例如 codex | gpt-6-astra | reasoningEffort=high。')
      .addTextArea(text => text.setValue(modelPresets).onChange(value => { modelPresets = value; }));
    new Setting(this.containerEl).addButton(button => button.setButtonText('保存设置').onClick(async () => {
      try {
        await this.plugin.updateSettings({
          cliPath: cliPath.trim(),
          projectPath: projectPath.trim(),
          projectId: projectId.trim(),
          provider,
          model,
          modelPresets,
          serverUrl: serverUrl.trim(),
          backendPreference,
        });
        new Notice('T3-Codian 设置已保存。');
      } catch (error) {
        const msg = redactSensitiveText(error instanceof Error ? error.message : '无法保存设置。');
        new Notice(msg);
      }
    }));

    let pairingInput: { setValue(v: string): unknown } | undefined;
    new Setting(this.containerEl)
      .setName('手动一次性配对码（仅内存有效）')
      .setDesc('当无法通过 T3 CLI 自动签发短期会话时，可粘贴配对码临时兑换内存访问凭据；不会写入配置或 Vault。')
      .addText(text => {
        pairingInput = text;
        text.inputEl.type = 'password';
        text.setPlaceholder('粘贴一次性配对码').onChange(value => { pairingCode = value; });
      })
      .addButton(button => button.setButtonText('配对连接').onClick(async () => {
        const code = pairingCode.trim();
        pairingCode = '';
        pairingInput?.setValue('');
        if (!code) {
          new Notice('请先输入一次性配对码。');
          return;
        }
        button.setDisabled(true);
        try {
          await this.plugin.pairWithCode(code);
          new Notice('配对成功，已切换至 RPC 实时模式。');
        } catch (error) {
          const msg = redactSensitiveText(error instanceof Error ? error.message : '配对失败。');
          new Notice(msg);
        } finally {
          button.setDisabled(false);
        }
      }));
  }
}
