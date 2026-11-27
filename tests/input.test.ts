import { describe, expect, it } from 'vitest';
import { configuredModels, normalizeSettings } from '../src/settings';
import { composePrompt } from '../src/context';

describe('MVP input boundaries', () => {
  it('preserves note preferences when migrating from the paired backend', () => {
    const settings = normalizeSettings({ origin: 'http://localhost:1234/', includeNote: true });
    expect(settings.cliPath).toMatch(/t3(?:\.cmd)?$/);
    expect(settings.projectPath).toBe('');
    expect(settings.includeNote).toBe(true);
  });

  it('normalizes the configured paths without changing spaces in folder names', () => {
    expect(normalizeSettings({ cliPath: ' /opt/t3 ', projectPath: ' /data/Project A ' }))
      .toEqual({ cliPath: '/opt/t3', projectPath: '/data/Project A', projectId: '', provider: 'codex', model: 'gpt-6-astra', modelPresets: '', includeNote: false });
  });
  it('includes the selection ahead of the full note', () => {
    expect(composePrompt('Summarize', { path: 'Draft.md', selection: 'Chosen', body: 'Private remainder' }))
      .toBe('Summarize\n\n<note-context>\nPath: Draft.md\nChosen\n</note-context>');
  });

  it('leaves the prompt alone when no note is selected for inclusion', () => {
    expect(composePrompt('Summarize')).toBe('Summarize');
  });

  it('limits long note text and marks truncation', () => {
    const prompt = composePrompt('Question', { path: 'x.md', selection: '', body: 'x'.repeat(8001) });
    expect(prompt).toContain('x'.repeat(8000) + '\n[内容已截断]');
    expect(prompt).not.toContain('x'.repeat(8001));
  });
});

it('groups configured presets without inventing model support', () => {
  expect(configuredModels({
    provider: 'codex', model: 'gpt-base',
    modelPresets: 'codex | gpt-base\nclaude-work | sonnet | effort=high\nclaude-work | sonnet | effort=high\nbroken\nclaude-work | opus | --bad',
  })).toEqual([
    { provider: 'codex', model: 'gpt-base' },
    { provider: 'claude-work', model: 'sonnet', option: 'effort=high' },
  ]);
});
