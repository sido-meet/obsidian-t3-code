interface AttachedNote {
  path: string;
  text: string;
}

export function composeAttachments(prompt: string, notes: AttachedNote[]): string {
  const sections = [prompt];
  let remaining = 8000;
  for (const note of notes) {
    if (remaining === 0) {
      sections.push('[其余附件未加入，已达到字数上限]');
      break;
    }
    const characters = Array.from(note.text);
    const excerpt = characters.slice(0, remaining).join('');
    const truncated = characters.length > remaining ? '\n[内容已截断]' : '';
    remaining -= Math.min(remaining, characters.length);
    sections.push('<attached-note>\nPath: ' + note.path + '\n' + excerpt + truncated + '\n</attached-note>');
  }
  return sections.join('\n\n');
}
