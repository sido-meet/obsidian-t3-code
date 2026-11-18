import { builtinModules } from 'node:module';
import esbuild from 'esbuild';

const production = process.argv.includes('--production');

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  outfile: 'main.js',
  external: ['obsidian', 'electron', 'node:*', ...builtinModules],
  minify: production,
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  logLevel: 'info',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
