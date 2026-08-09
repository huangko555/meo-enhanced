import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-theme-heading-sizes-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-theme-heading-sizes-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const actual = await page.evaluate(() => ({
      missing: window.ThemeHeadingSizeHarness.apply([null, null, null, null, null, null]),
      valid: window.ThemeHeadingSizeHarness.apply([1, 1.25, 2, 3, 1.75, 2.5]),
      invalid: window.ThemeHeadingSizeHarness.apply([0, 4, Number.NaN, Number.POSITIVE_INFINITY, -1, null])
    }));

    assert.deepEqual(actual.missing, ['1.6em', '1.5em', '1.3em', '1.2em', '1.1em', '1em']);
    assert.deepEqual(actual.valid, ['1em', '1.25em', '2em', '3em', '1.75em', '2.5em']);
    assert.deepEqual(actual.invalid, ['1.6em', '1.5em', '1.3em', '1.2em', '1.1em', '1em']);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('Theme heading-size browser checks passed');
}).catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
