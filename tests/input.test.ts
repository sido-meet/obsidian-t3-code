import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/settings';
import { composePrompt } from '../src/context';

describe('MVP input boundaries', () => {
  it('defaults to the local service for absent and invalid settings', () => {
    for (const input of [null, { origin: 'https://example.org/secret' }, { origin: 'file:///tmp' }]) {
      expect(normalizeSettings(input).origin).toBe('http://127.0.0.1:3425');
    }
  });

  it('accepts a custom loopback port and removes a trailing slash', () => {
    expect(normalizeSettings({ origin: 'http://localhost:1234/' }).origin).toBe('http://localhost:1234');
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
