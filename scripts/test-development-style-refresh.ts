import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-development-styles-'));

try {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'webview', 'src', 'index.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'webview.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><div id="app"></div></body>');
    await page.addScriptTag({ content: `
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'webview.js') });
    await page.waitForSelector('.mode-group');

    const applyStyles = async (css: string): Promise<string> => page.evaluate((content) => {
      const control = document.querySelector<HTMLElement>('.mode-group')!;
      control.dataset.testIdentity = 'preserved';
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'developmentStylesChanged', css: content }
      }));
      if (document.getElementById('meo-development-styles')?.textContent !== content) {
        throw new Error('Development stylesheet was not updated');
      }
      return getComputedStyle(control).backgroundColor;
    }, css);

    assert.equal(await applyStyles('.mode-group { background: rgb(12, 34, 56) !important; }'), 'rgb(12, 34, 56)');
    assert.equal(await applyStyles('.mode-group { background: rgb(65, 43, 21) !important; }'), 'rgb(65, 43, 21)');
    assert.equal(await page.$eval('.mode-group', (control) => (control as HTMLElement).dataset.testIdentity), 'preserved');
    console.log('Development style refresh checks passed');
  } finally {
    await closeTestBrowser(browser);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
