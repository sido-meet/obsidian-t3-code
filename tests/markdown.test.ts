import { expect, it } from 'vitest';
import { renderMarkdown } from '../src/ui/markdown';

it('renders model code inertly and blocks note embeds, remote images, and raw HTML', () => {
  const html = renderMarkdown([
    '# Heading', '![[Private.md]]', '![image](https://example.org/track)', '<script>alert(1)</script>',
    '```dataviewjs', 'await dv.io.load("Private.md")', '```',
  ].join('\n\n'));
  expect(html).toContain('<h1>Heading</h1>');
  expect(html).toContain('![[Private.md]]');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
  expect(html).toContain('<pre><code class="language-dataviewjs">');
});

it('highlights supported code fences and leaves an unclosed fence readable', () => {
  const html = renderMarkdown('```ts\nconst answer = 42;');
  expect(html).toContain('class="hljs-keyword">const');
  expect(html).toContain('class="hljs-number">42');
});
