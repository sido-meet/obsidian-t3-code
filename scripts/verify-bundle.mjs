import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBundleViolations, MAX_BUNDLE_BYTES } from './bundlePolicy.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = join(repoRoot, 'main.js');
const fail = (reason) => {
  console.error(`[verify-bundle] FAIL: ${reason}`);
  process.exit(1);
};

if (!statSync(bundlePath, { throwIfNoEntry: false })) {
  fail('main.js is missing at the repository root; run the build before verifying.');
}

const bundle = readFileSync(bundlePath, 'utf8');
const sizeBytes = statSync(bundlePath).size;

const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const violations = collectBundleViolations({
  bundleText: bundle,
  sizeBytes,
  manifestVersion: manifest.version,
  packageVersion: packageJson.version,
  releaseTag: process.argv[2],
});

if (violations.length > 0) {
  for (const violation of violations) {
    fail(violation);
  }
}

console.log(`[verify-bundle] OK: main.js ${sizeBytes} bytes (< ${MAX_BUNDLE_BYTES}), obsidian external, version ${manifest.version}.`);
