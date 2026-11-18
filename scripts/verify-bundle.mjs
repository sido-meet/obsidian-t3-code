import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = join(repoRoot, 'main.js');
const MAX_BUNDLE_BYTES = 200 * 1024;

const fail = (reason) => {
  console.error(`[verify-bundle] FAIL: ${reason}`);
  process.exit(1);
};

if (!statSync(bundlePath, { throwIfNoEntry: false })) {
  fail('main.js is missing at the repository root; run the build before verifying.');
}

const bundle = readFileSync(bundlePath, 'utf8');
const sizeBytes = statSync(bundlePath).size;

if (sizeBytes >= MAX_BUNDLE_BYTES) {
  fail(`main.js is ${sizeBytes} bytes, which is not below the ${MAX_BUNDLE_BYTES} byte limit.`);
}

if (!/require\(\s*["']obsidian["']\s*\)/.test(bundle)) {
  fail('main.js does not reference obsidian as an external module; it must not be bundled.');
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

if (manifest.version !== packageJson.version) {
  fail(`version mismatch: manifest.json is ${manifest.version} but package.json is ${packageJson.version}.`);
}

console.log(`[verify-bundle] OK: main.js ${sizeBytes} bytes (< ${MAX_BUNDLE_BYTES}), obsidian external, version ${manifest.version}.`);
