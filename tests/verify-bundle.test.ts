import { describe, expect, it } from 'vitest';
import { collectBundleViolations, MAX_BUNDLE_BYTES } from '../scripts/bundlePolicy.mjs';

const compliantBundle = 'var obsidian = require("obsidian");';

const check = (overrides: Partial<Parameters<typeof collectBundleViolations>[0]> = {}) =>
  collectBundleViolations({
    bundleText: compliantBundle,
    sizeBytes: 1024,
    manifestVersion: '0.1.0',
    packageVersion: '0.1.0',
    ...overrides,
  });

describe('bundle compliance policy', () => {
  it('accepts a compliant bundle', () => {
    expect(check()).toEqual([]);
  });

  it('rejects a bundle at or above the size limit', () => {
    expect(check({ sizeBytes: MAX_BUNDLE_BYTES })).toContainEqual(
      expect.stringContaining('byte limit'),
    );
  });

  it('rejects a bundle that inlined the obsidian runtime', () => {
    expect(check({ bundleText: 'var App = function () {};' })).toContainEqual(
      expect.stringContaining('external module'),
    );
  });

  it('rejects a manifest and package version mismatch', () => {
    expect(check({ manifestVersion: '0.1.0', packageVersion: '0.2.0' })).toContainEqual(
      expect.stringContaining('version mismatch'),
    );
  });

  it('reports every violation at once', () => {
    expect(
      check({
        bundleText: 'var App = function () {};',
        sizeBytes: MAX_BUNDLE_BYTES + 1,
        manifestVersion: '0.1.0',
        packageVersion: '0.2.0',
      }),
    ).toHaveLength(3);
  });
});
