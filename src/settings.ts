import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelSelection } from './t3/cli';

export type BackendPreference = 'auto' | 'cli';

export interface Settings {
  cliPath: string;
  projectPath: string;
  projectId: string;
  provider: string;
  model: string;
  modelPresets: string;
  includeNote: boolean;
  serverUrl: string;
  backendPreference: BackendPreference;
}

const defaultCliPath = process.platform === 'win32' ? join(homedir(), '.t3', 'bin', 't3.cmd') : 't3';

export function normalizeSettings(value: unknown): Settings {
  const saved = value as Partial<Settings> | null | undefined;
  return {
    cliPath: (typeof saved?.cliPath === 'string' && saved.cliPath.trim()) || defaultCliPath,
    projectPath: typeof saved?.projectPath === 'string' ? saved.projectPath.trim() : '',
    projectId: typeof saved?.projectId === 'string' ? saved.projectId.trim() : '',
    provider: (typeof saved?.provider === 'string' && saved.provider.trim()) || 'codex',
    model: (typeof saved?.model === 'string' && saved.model.trim()) || 'gpt-6-astra',
    modelPresets: typeof saved?.modelPresets === 'string' ? saved.modelPresets : '',
    includeNote: saved?.includeNote === true,
    serverUrl: typeof saved?.serverUrl === 'string' ? saved.serverUrl.trim() : '',
    backendPreference: saved?.backendPreference === 'cli' ? 'cli' : 'auto',
  };
}

export function configuredModels(settings: Pick<Settings, 'provider' | 'model' | 'modelPresets'>): ModelSelection[] {
  const selections: ModelSelection[] = [{ provider: settings.provider, model: settings.model }];
  const names = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
  const options = /^[a-zA-Z][a-zA-Z0-9_-]*=[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  for (const line of settings.modelPresets.split(/\r?\n/)) {
    const [provider, model, option, extra] = line.split('|').map(part => part.trim());
    if (extra !== undefined || !names.test(provider ?? '') || !names.test(model ?? '') ||
        (option && !options.test(option))) continue;
    const selection = { provider, model, ...(option ? { option } : {}) };
    if (!selections.some(item => item.provider === provider && item.model === model && item.option === selection.option)) {
      selections.push(selection);
    }
  }
  return selections;
}
