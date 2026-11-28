import { MarkdownRenderer } from 'obsidian';
import type { App, Component } from 'obsidian';

export const MAX_RICH_MARKDOWN_CHARS = 40_000;

const PASSIVE_CODE_LANGUAGES = new Set([
  'bash', 'c', 'cpp', 'cs', 'csharp', 'css', 'csv', 'diff', 'dockerfile',
  'go', 'graphql', 'html', 'http', 'ini', 'java', 'javascript', 'js',
  'json', 'jsonc', 'jsx', 'kotlin', 'latex', 'lua', 'makefile', 'markdown',
  'md', 'php', 'plaintext', 'powershell', 'pwsh', 'py', 'python', 'r',
  'regex', 'rs', 'ruby', 'rust', 'scss', 'sh', 'shell', 'sql', 'swift',
  'tex', 'text', 'toml', 'ts', 'tsx', 'txt', 'typescript', 'xml', 'yaml',
  'yml', 'zsh',
]);

const ALLOWED_LINK_SCHEMES = /^(?:https?:|mailto:)/i;
const DANGEROUS_ELEMENTS = 'script, iframe, object, embed, img, audio, video, style, form';

function escapeHtmlLeading(segment: string): string {
  return segment.replace(/<(?=[/?!]?[a-zA-Z!])/g, '&lt;');
}

function normalizeLinkUrl(rawInner: string): string {
  const trimmed = rawInner.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.includes('>')
    ? trimmed.slice(1, trimmed.indexOf('>'))
    : trimmed.split(/\s+/)[0] ?? '';
  return unwrapped.trim();
}

function isSafeUrl(url: string): boolean {
  if (!ALLOWED_LINK_SCHEMES.test(url)) return false;
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

function rewriteMarkdownLinks(segment: string): string {
  let out = '';
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '[' && i > 0 && (segment[i - 1] === '!' || segment[i - 1] === '\\')) {
      out += segment[i++];
      continue;
    }
    if (segment[i] !== '[') {
      out += segment[i++];
      continue;
    }
    const closeBracket = segment.indexOf(']', i + 1);
    if (closeBracket < 0 || segment[closeBracket + 1] !== '(') {
      out += segment[i++];
      continue;
    }
    // Scan balanced parentheses inside `(url)` so `javascript:alert(1)` or wiki URLs do not truncate early.
    let depth = 1;
    let p = closeBracket + 2;
    while (p < segment.length && depth > 0) {
      if (segment[p] === '(') depth++;
      else if (segment[p] === ')') depth--;
      p++;
    }
    if (depth !== 0) {
      out += segment[i++];
      continue;
    }
    const label = segment.slice(i + 1, closeBracket);
    const rawTarget = segment.slice(closeBracket + 2, p - 1);
    const url = normalizeLinkUrl(rawTarget);
    if (isSafeUrl(url)) {
      out += `[${label}](${url})`;
    } else {
      out += `${label.trim() || 'link'} (blocked link)`;
    }
    i = p;
  }
  return out;
}

function sanitizePlainSegment(segment: string): string {
  // Neutralize Obsidian embeds (![[...]]) and Markdown images (![alt](...)) before escaping raw HTML.
  const withoutImages = segment
    .replace(/!\[\[/g, '\\![[')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '\\![$1]($2)')
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, '\\![$1][$2]');

  // Restrict non-image Markdown links [label](url) to https:, http:, or mailto:.
  return escapeHtmlLeading(rewriteMarkdownLinks(withoutImages));
}

function sanitizeLineOutsideFence(line: string): string {
  // Preserve inline code spans (`...`) and math ($...$ / $$...$$) verbatim.
  let out = '';
  let i = 0;
  let plainStart = 0;

  while (i < line.length) {
    if (line[i] === '`') {
      out += sanitizePlainSegment(line.slice(plainStart, i));
      let ticks = 0;
      while (i + ticks < line.length && line[i + ticks] === '`') ticks++;
      const close = line.indexOf('`'.repeat(ticks), i + ticks);
      if (close >= 0) {
        const end = close + ticks;
        out += line.slice(i, end);
        i = end;
        plainStart = end;
        continue;
      }
      plainStart = i;
      i += ticks;
      continue;
    }

    if (line[i] === '$' && (i === 0 || line[i - 1] !== '\\')) {
      const isDisplay = line[i + 1] === '$';
      const delim = isDisplay ? '$$' : '$';
      const close = line.indexOf(delim, i + delim.length);
      if (close >= 0 && (isDisplay || !/\s/.test(line[i + 1] ?? ''))) {
        out += sanitizePlainSegment(line.slice(plainStart, i));
        const end = close + delim.length;
        out += line.slice(i, end);
        i = end;
        plainStart = end;
        continue;
      }
    }
    i++;
  }

  out += sanitizePlainSegment(line.slice(plainStart));
  return out;
}

/**
 * Sanitizes untrusted AI Markdown before passing it to Obsidian's MarkdownRenderer:
 * - Blocks executable / third-party code fences (e.g. dataviewjs, templater) by rewriting to `text`.
 * - Neutralizes Vault embeds (`![[...]]`), images, raw HTML tags, and non-HTTP(S)/mailto links.
 * - Falls back to inert plain text above 40,000 chars.
 */
export function sanitizeUntrustedMarkdown(raw: string): { markdown: string; inertFallback: boolean } {
  if (raw.length > MAX_RICH_MARKDOWN_CHARS) {
    return { markdown: raw, inertFallback: true };
  }

  const lines = raw.split(/\r?\n/);
  const result: string[] = [];
  let fence: { char: '`' | '~'; minLen: number } | null = null;

  for (const line of lines) {
    if (fence) {
      result.push(line);
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.minLen) {
        fence = null;
      }
      continue;
    }

    const openMatch = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const indent = openMatch[1];
      const marker = openMatch[2];
      const info = openMatch[3];
      const isBacktick = marker[0] === '`';
      if (!isBacktick || !info.includes('`')) {
        fence = { char: isBacktick ? '`' : '~', minLen: marker.length };
        const langToken = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!langToken) {
          result.push(`${indent}${marker}`);
        } else if (PASSIVE_CODE_LANGUAGES.has(langToken) && info.trim() === langToken) {
          result.push(`${indent}${marker}${langToken}`);
        } else {
          result.push(`${indent}${marker}text`);
        }
        continue;
      }
    }

    result.push(sanitizeLineOutsideFence(line));
  }

  return { markdown: result.join('\n'), inertFallback: false };
}

/** Defense-in-depth DOM hardening applied to staged MarkdownRenderer output before mounting. */
export function hardenRenderedMarkdown(container: HTMLElement): void {
  container.querySelectorAll(DANGEROUS_ELEMENTS).forEach(el => el.remove());

  const visit = (root: HTMLElement): void => {
    for (const attr of Array.from(root.attributes)) {
      if (/^on/i.test(attr.name)) root.removeAttribute(attr.name);
    }
    if (root.tagName === 'SVG' && !root.parentElement?.classList?.contains('copy-code-button')) {
      root.remove();
      return;
    }
    if (root.tagName === 'A') {
      const href = root.getAttribute('href')?.trim() ?? '';
      if (!isSafeUrl(href)) {
        root.removeAttribute('href');
        root.classList?.add('is-blocked-link');
      } else {
        root.setAttribute('target', '_blank');
        root.setAttribute('rel', 'noopener noreferrer');
      }
    }
    for (const child of Array.from(root.children)) {
      visit(child as HTMLElement);
    }
  };

  for (const child of Array.from(container.children)) {
    visit(child as HTMLElement);
  }
}

/**
 * Safely renders untrusted AI Markdown via Obsidian's native MarkdownRenderer into `container`
 * using an offscreen staging container + post-render DOM hardening, with inert plain-text fallback.
 */
export async function renderSafeMarkdown(
  app: App,
  text: string,
  container: HTMLElement,
  component: Component,
): Promise<void> {
  const { markdown, inertFallback } = sanitizeUntrustedMarkdown(text);
  container.empty();
  if (inertFallback) {
    container.addClass('t3c-msg-plain');
    container.setText(text);
    return;
  }

  const stage = container.ownerDocument.createElement('div');
  try {
    await MarkdownRenderer.render(app, markdown, stage, '', component);
    hardenRenderedMarkdown(stage);
    container.removeClass('t3c-msg-plain');
    while (true) {
      const next = (stage as unknown as { firstChild?: ChildNode | null }).firstChild ?? stage.firstElementChild;
      if (!next) break;
      container.appendChild(next as Node);
    }
  } catch {
    container.empty();
    container.addClass('t3c-msg-plain');
    container.setText(text);
  }
}
