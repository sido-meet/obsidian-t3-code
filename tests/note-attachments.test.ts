import { expect, it } from 'vitest';
import { composeAttachments } from '../src/ui/note-attachments';

it('sends attached notes with names and caps the total excerpt budget', () => {
  const prompt = composeAttachments('question', [
    { path: 'a.md', text: 'x'.repeat(7999) },
    { path: 'b.md', text: '甲乙' },
    { path: 'c.md', text: 'SHOULD BE EXCLUDED' },
  ]);
  expect(prompt).toContain('Path: a.md');
  expect(prompt).toContain('Path: b.md\n甲\n[内容已截断]');
  expect(prompt).not.toContain('SHOULD BE EXCLUDED');
  expect(composeAttachments('question', [])).toBe('question');
});
