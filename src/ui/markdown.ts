import MarkdownIt from 'markdown-it';
import highlighter from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';

highlighter.registerLanguage('typescript', typescript);
highlighter.registerLanguage('python', python);
highlighter.registerLanguage('json', json);
highlighter.registerLanguage('bash', bash);

// T3 responses are untrusted. Keep this renderer independent of Vault processors and embeds.
const markdown = new MarkdownIt({
  html: false,
  highlight: (text, language) => highlighter.getLanguage(language)
    ? highlighter.highlight(text, { language, ignoreIllegals: true }).value : '',
}).disable('image');

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
