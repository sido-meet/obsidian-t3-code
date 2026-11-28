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
const DANGEROUS_ELEMENTS = 'script, iframe, object, embed, img, audio, video, style, form, link, picture, source, base, meta';
const DANGEROUS_TAG_SET = new Set(DANGEROUS_ELEMENTS.split(',').map(s => s.trim().toUpperCase()));

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

function rewriteImagesAndLinks(segment: string): string {
  // Block wiki-style embeds (![[...]]) even when preceded by backslashes (e.g. `\![[Secret]]`).
  let neutralized = segment
    .replace(/\\*!\[\[([^\]]*)\]\]/g, (_m, target: string) => `(blocked embed: ${target.trim() || 'embed'})`)
    .replace(/\\*!\[\[/g, '(blocked embed) [[');

  // Rewrite inline images (`![alt](url)`, including multiline) and links (`[label](url)`) using balanced parens.
  let out = '';
  let i = 0;
  while (i < neutralized.length) {
    let bangStart = i;
    while (bangStart < neutralized.length && neutralized[bangStart] === '\\') bangStart++;
    const isEscapedImage = neutralized[bangStart] === '!' && neutralized[bangStart + 1] === '[';

    const bracketPos = isEscapedImage ? bangStart + 1 : (neutralized[i] === '[' ? i : -1);
    if (bracketPos < 0 || (!isEscapedImage && i > 0 && (neutralized[i - 1] === '!' || neutralized[i - 1] === '\\'))) {
      out += neutralized[i++];
      continue;
    }

    const closeBracket = neutralized.indexOf(']', bracketPos + 1);
    if (closeBracket < 0) {
      out += neutralized[i++];
      continue;
    }

    if (neutralized[closeBracket + 1] === '(') {
      let depth = 1;
      let p = closeBracket + 2;
      while (p < neutralized.length && depth > 0) {
        if (neutralized[p] === '(') depth++;
        else if (neutralized[p] === ')') depth--;
        p++;
      }
      if (depth !== 0) {
        out += neutralized[i++];
        continue;
      }
      const label = neutralized.slice(bracketPos + 1, closeBracket);
      const rawTarget = neutralized.slice(closeBracket + 2, p - 1);
      if (isEscapedImage) {
        out += `${label.trim() || 'image'} (blocked image)`;
      } else {
        const url = normalizeLinkUrl(rawTarget);
        out += isSafeUrl(url) ? `[${label}](${url})` : `${label.trim() || 'link'} (blocked link)`;
      }
      i = p;
      continue;
    }

    if (isEscapedImage) {
      const alt = neutralized.slice(bracketPos + 1, closeBracket);
      let nextIdx = closeBracket + 1;
      if (neutralized[nextIdx] === '[') {
        const refClose = neutralized.indexOf(']', nextIdx + 1);
        if (refClose >= 0) nextIdx = refClose + 1;
      }
      out += `${alt.trim() || 'image'} (blocked image)`;
      i = nextIdx;
      continue;
    }

    out += neutralized[i++];
  }

  // Neutralize unsafe or image-tracker link reference definitions ([ref]: url).
  neutralized = out.replace(
    /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))([^\r\n]*)$/gm,
    (full, id: string, wrapped?: string, bare?: string) => {
      const candidate = (wrapped ?? bare ?? '').trim();
      return isSafeUrl(candidate) ? full : `(${id.trim()}: blocked link reference)`;
    },
  );

  return escapeHtmlLeading(neutralized);
}

function sanitizeProseBlock(block: string): string {
  // Preserve inline code spans (`...`) and math ($...$ / $$...$$) verbatim.
  let out = '';
  let i = 0;
  let plainStart = 0;

  while (i < block.length) {
    if (block[i] === '`') {
      out += rewriteImagesAndLinks(block.slice(plainStart, i));
      let ticks = 0;
      while (i + ticks < block.length && block[i + ticks] === '`') ticks++;
      const close = block.indexOf('`'.repeat(ticks), i + ticks);
      if (close >= 0) {
        const end = close + ticks;
        out += block.slice(i, end);
        i = end;
        plainStart = end;
        continue;
      }
      plainStart = i;
      i += ticks;
      continue;
    }

    if (block[i] === '$' && (i === 0 || block[i - 1] !== '\\')) {
      const isDisplay = block[i + 1] === '$';
      const delim = isDisplay ? '$$' : '$';
      const close = block.indexOf(delim, i + delim.length);
      if (close >= 0 && (isDisplay || !/\s/.test(block[i + 1] ?? ''))) {
        out += rewriteImagesAndLinks(block.slice(plainStart, i));
        const end = close + delim.length;
        out += block.slice(i, end);
        i = end;
        plainStart = end;
        continue;
      }
    }
    i++;
  }

  out += rewriteImagesAndLinks(block.slice(plainStart));
  return out;
}

/**
 * Sanitizes untrusted AI Markdown before passing it to Obsidian's MarkdownRenderer:
 * - Blocks executable / third-party code fences (including inside blockquotes or list items) by rewriting to `text`.
 * - Neutralizes Vault embeds (`![[...]]`), inline/multiline/reference images, backslash escapes, raw HTML tags, and unsafe links.
 * - Falls back to inert plain text above 40,000 chars.
 */
export function sanitizeUntrustedMarkdown(raw: string): { markdown: string; inertFallback: boolean } {
  if (raw.length > MAX_RICH_MARKDOWN_CHARS) {
    return { markdown: raw, inertFallback: true };
  }

  const lines = raw.split(/\r?\n/);
  const result: string[] = [];
  let proseLines: string[] = [];
  let fence: { char: '`' | '~'; minLen: number } | null = null;

  const flushProse = () => {
    if (proseLines.length === 0) return;
    result.push(sanitizeProseBlock(proseLines.join('\n')));
    proseLines = [];
  };

  for (const line of lines) {
    if (fence) {
      result.push(line);
      const closeMatch = line.match(/^(?:[ \t]*(?:>[ \t]*)*) {0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.minLen) {
        fence = null;
      }
      continue;
    }

    const openMatch = line.match(/^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])?[ \t]*)(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const prefix = openMatch[1];
      const marker = openMatch[2];
      const info = openMatch[3];
      const isBacktick = marker[0] === '`';
      if (!isBacktick || !info.includes('`')) {
        flushProse();
        fence = { char: isBacktick ? '`' : '~', minLen: marker.length };
        const langToken = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!langToken) {
          result.push(`${prefix}${marker}`);
        } else if (PASSIVE_CODE_LANGUAGES.has(langToken) && info.trim() === langToken) {
          result.push(`${prefix}${marker}${langToken}`);
        } else {
          result.push(`${prefix}${marker}text`);
        }
        continue;
      }
    }

    proseLines.push(line);
  }
  flushProse();

  return { markdown: result.join('\n'), inertFallback: false };
}

/** Defense-in-depth DOM hardening applied to staged MarkdownRenderer output before mounting. */
export function hardenRenderedMarkdown(container: HTMLElement): void {
  container.querySelectorAll(DANGEROUS_ELEMENTS).forEach(el => el.remove());

  const visit = (root: HTMLElement): void => {
    for (const attr of Array.from(root.attributes)) {
      if (/^on/i.test(attr.name)) root.removeAttribute(attr.name);
    }
    const tag = root.tagName.toUpperCase();
    if (DANGEROUS_TAG_SET.has(tag) || (tag === 'SVG' && !root.parentElement?.classList?.contains('copy-code-button'))) {
      root.remove();
      return;
    }
    if (tag === 'A') {
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
 * using offscreen staging + post-render DOM hardening, committing only if `shouldCommit` stays true.
 */
export async function renderSafeMarkdown(
  app: App,
  text: string,
  container: HTMLElement,
  component: Component,
  shouldCommit?: () => boolean,
): Promise<boolean> {
  const { markdown, inertFallback } = sanitizeUntrustedMarkdown(text);
  if (shouldCommit && !shouldCommit()) return false;
  if (inertFallback) {
    container.empty();
    container.addClass('t3c-msg-plain');
    container.setText(text);
    return true;
  }

  const stage = container.ownerDocument.createElement('div');
  try {
    await MarkdownRenderer.render(app, markdown, stage, '', component);
    if (shouldCommit && !shouldCommit()) return false;
    hardenRenderedMarkdown(stage);
    if (shouldCommit && !shouldCommit()) return false;
    container.empty();
    container.removeClass('t3c-msg-plain');
    while (true) {
      const next = (stage as unknown as { firstChild?: ChildNode | null }).firstChild ?? stage.firstElementChild;
      if (!next) break;
      container.appendChild(next as Node);
    }
    return true;
  } catch {
    if (shouldCommit && !shouldCommit()) return false;
    container.empty();
    container.addClass('t3c-msg-plain');
    container.setText(text);
    return true;
  }
}
