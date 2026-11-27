import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

const context = await esbuild.context({
  absWorkingDir: repoRoot,
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  outfile: 'main.js',
  external: ['obsidian', 'electron', 'node:*', ...builtinModules],
  minify: production,
  sourcemap: production ? false : 'external',
  treeShaking: true,
  logLevel: 'info',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
