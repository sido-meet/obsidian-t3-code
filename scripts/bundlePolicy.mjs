export const MAX_BUNDLE_BYTES = 200 * 1024;

/**
 * Pure compliance policy for the built plugin bundle.
 * Returns one message per violation; an empty array means the bundle is compliant.
 *
 * @param {{ bundleText: string, sizeBytes: number, manifestVersion: string, packageVersion: string }} input
 * @returns {string[]}
 */
export function collectBundleViolations({ bundleText, sizeBytes, manifestVersion, packageVersion }) {
  const violations = [];

  if (sizeBytes >= MAX_BUNDLE_BYTES) {
    violations.push(
      `main.js is ${sizeBytes} bytes, which is not below the ${MAX_BUNDLE_BYTES} byte limit.`,
    );
  }

  if (!/require\(\s*["']obsidian["']\s*\)/.test(bundleText)) {
    violations.push(
      'main.js does not reference obsidian as an external module; it must not be bundled.',
    );
  }

  if (manifestVersion !== packageVersion) {
    violations.push(
      `version mismatch: manifest.json is ${manifestVersion} but package.json is ${packageVersion}.`,
    );
  }

  return violations;
}
