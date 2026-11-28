import { describe, expect, it, vi } from 'vitest';
import { App, Component, MarkdownRenderer } from 'obsidian';
import {
  MAX_RICH_MARKDOWN_CHARS,
  hardenRenderedMarkdown,
  renderSafeMarkdown,
  sanitizeUntrustedMarkdown,
} from '../src/ui/markdown';

class MiniNode {
  tagName: string;
  children: MiniNode[] = [];
  parentElement: MiniNode | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  className = '';
  textContent = '';

  constructor(tag: string, public readonly ownerDocument: MiniDoc) {
    this.tagName = tag.toUpperCase();
  }

  get attributes() {
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }));
  }

  get classList() {
    return {
      contains: (c: string) => this.classes.has(c) || this.className.split(/\s+/).includes(c),
      add: (c: string) => { this.classes.add(c); },
    };
  }

  get firstChild(): MiniNode | null { return this.children[0] ?? null; }
  get firstElementChild(): MiniNode | null { return this.children[0] ?? null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  addClass(c: string): void { this.classes.add(c); }
  removeClass(c: string): void { this.classes.delete(c); }
  setText(t: string): void { this.children = []; this.textContent = t; }
  empty(): void { this.children = []; this.textContent = ''; }
  appendChild<T extends MiniNode>(node: T): T {
    if (node.parentElement) {
      node.parentElement.children = node.parentElement.children.filter(c => c !== node);
    }
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
  }
  querySelectorAll(sel: string): MiniNode[] {
    const tags = new Set(sel.split(',').map(s => s.trim().toUpperCase()));
    const res: MiniNode[] = [];
    const walk = (n: MiniNode) => {
      for (const c of n.children) {
        if (tags.has(c.tagName)) res.push(c);
        walk(c);
      }
    };
    walk(this);
    return res;
  }
}

class MiniDoc {
  createElement(tag: string): MiniNode {
    return new MiniNode(tag, this);
  }
}

describe('safe native markdown sanitization & rendering', () => {
  it('rewrites executable/plugin fences to text while keeping passive code fences, math, and unclosed fences', () => {
    const input = [
      '# Heading',
      '![[Private.md]] and ![img](https://example.org/track) and ![ref][1]',
      '[ok](https://example.com) and [wrapped](<https://example.com/x>) and [bad](javascript:alert(1)) and [](javascript:void(0)) and [ctrl](https://example.com/\x01) and [obs](obsidian://open?vault=x)',
      '<script>alert(1)</script> and $$a < b$$ and inline `<img src=x>`',
      '```dataviewjs',
      'await dv.io.load("Private.md")',
      '```',
      '~~~templater custom=arg',
      '<% tp.file.title %>',
      '~~~',
      '```ts',
      'const answer = 42;',
    ].join('\n\n');

    const { markdown, inertFallback } = sanitizeUntrustedMarkdown(input);
    expect(inertFallback).toBe(false);
    expect(markdown).toContain('# Heading');
    expect(markdown).toContain('\\![[Private.md]]');
    expect(markdown).toContain('\\![img](https://example.org/track)');
    expect(markdown).toContain('\\![ref][1]');
    expect(markdown).toContain('[ok](https://example.com)');
    expect(markdown).toContain('[wrapped](https://example.com/x)');
    expect(markdown).toContain('bad (blocked link)');
    expect(markdown).toContain('link (blocked link)');
    expect(markdown).not.toContain('blocked link))');
    expect(markdown).toContain('ctrl (blocked link)');
    expect(markdown).toContain('obs (blocked link)');
    expect(markdown).toContain('&lt;script>alert(1)&lt;/script>');
    expect(markdown).toContain('$$a < b$$');
    expect(markdown).toContain('`<img src=x>`');
    expect(markdown).toContain('```text\n\nawait dv.io.load("Private.md")');
    expect(markdown).toContain('~~~text\n\n<% tp.file.title %>');
    expect(markdown).toContain('```ts\n\nconst answer = 42;');
  });

  it('keeps empty fences, unbalanced brackets/parens, and falls back to inert plain text above 40,000 chars', () => {
    const emptyFence = sanitizeUntrustedMarkdown('```\nplain\n```');
    expect(emptyFence.inertFallback).toBe(false);
    expect(emptyFence.markdown).toBe('```\nplain\n```');

    const unclosedBacktickInInfo = sanitizeUntrustedMarkdown('```js`notfence');
    expect(unclosedBacktickInInfo.inertFallback).toBe(false);

    const balancedWiki = sanitizeUntrustedMarkdown('[wiki](https://en.wikipedia.org/wiki/A_(b)) and [unbalanced](http://x and [text](noturl');
    expect(balancedWiki.markdown).toContain('[wiki](https://en.wikipedia.org/wiki/A_(b))');
    expect(balancedWiki.markdown).toContain('[unbalanced](http://x');

    const huge = 'x'.repeat(MAX_RICH_MARKDOWN_CHARS + 1);
    expect(sanitizeUntrustedMarkdown(huge)).toEqual({ markdown: huge, inertFallback: true });
  });

  it('hardens rendered DOM against active elements, event handlers, untrusted SVGs, and unsafe links', () => {
    const doc = new MiniDoc();
    const root = doc.createElement('div');
    const script = doc.createElement('script');
    const badSvg = doc.createElement('svg');
    const btn = doc.createElement('button');
    btn.className = 'copy-code-button';
    const copySvg = doc.createElement('svg');
    btn.appendChild(copySvg);

    const p = doc.createElement('p');
    p.setAttribute('onclick', 'alert(1)');
    const goodLink = doc.createElement('a');
    goodLink.setAttribute('href', 'https://t3.codes');
    const badLink = doc.createElement('a');
    badLink.setAttribute('href', 'obsidian://advanced-uri');
    p.appendChild(goodLink);
    p.appendChild(badLink);

    root.appendChild(script);
    root.appendChild(badSvg);
    root.appendChild(btn);
    root.appendChild(p);

    hardenRenderedMarkdown(root as unknown as HTMLElement);

    expect(root.querySelectorAll('script')).toHaveLength(0);
    expect(root.children).not.toContain(badSvg);
    expect(btn.children).toContain(copySvg);
    expect(p.getAttribute('onclick')).toBeNull();
    expect(goodLink.getAttribute('href')).toBe('https://t3.codes');
    expect(goodLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(badLink.getAttribute('href')).toBeNull();
    expect(badLink.classList.contains('is-blocked-link')).toBe(true);
  });

  it('renders via MarkdownRenderer safely and falls back to inert plain text on oversize or renderer failure', async () => {
    const doc = new MiniDoc();
    const container = doc.createElement('div');
    const comp = new Component();
    const app = new App();

    await renderSafeMarkdown(app, '# Safe', container as unknown as HTMLElement, comp);
    expect(container.classes.has('t3c-msg-plain')).toBe(false);
    expect(container.children.length).toBeGreaterThan(0);

    await renderSafeMarkdown(app, 'a'.repeat(MAX_RICH_MARKDOWN_CHARS + 1), container as unknown as HTMLElement, comp);
    expect(container.classes.has('t3c-msg-plain')).toBe(true);

    vi.spyOn(MarkdownRenderer, 'render').mockRejectedValueOnce(new Error('render failed'));
    await renderSafeMarkdown(app, '# Broken', container as unknown as HTMLElement, comp);
    expect(container.classes.has('t3c-msg-plain')).toBe(true);
    expect(container.textContent).toBe('# Broken');
    vi.restoreAllMocks();
  });
});
