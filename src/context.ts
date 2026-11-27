export interface NoteContext {
  path: string;
  selection: string;
  body: string;
}

export function composePrompt(prompt: string, note?: NoteContext): string {
  if (!note) return prompt;
  const content = note.selection.trim() ? note.selection : note.body;
  const limited = Array.from(content);
  const excerpt = limited.slice(0, 8000).join('') + (limited.length > 8000 ? '\n[内容已截断]' : '');
  return [prompt, '', '<note-context>', 'Path: ' + note.path, excerpt, '</note-context>'].join('\n');
}
