import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-comment-visibility-'));
const repoRoot = path.resolve(import.meta.dir, '..');

try {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-html-content-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).__commentEditor = (window as any).HtmlContentHarness.createEditor({
        parent: document.getElementById('app'),
        text: 'Intro\n\nInline <!-- secret --> text\n\n<!-- block\nsecret -->\n\n<div>before<!-- nested -->after</div>\n\n<div>\n<!-- nested multiline\ncomment -->\n<p>after</p>\n</div>\n\n```html\n<!-- example -->\n```',
        initialMode: 'live',
        uiLanguage: 'en',
        onApplyChanges() {}
      });
    });
    assert.equal((await page.$$('.meo-md-collapsed-comment')).length, 0);
    await page.evaluate(() => (window as any).__commentEditor.setLiveShowComments(false));
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-collapsed-comment').length === 4);
    await page.evaluate(() => (window as any).__commentEditor.setUiLanguage('zh-CN'));
    await page.waitForFunction(() => document.querySelector('.meo-md-collapsed-comment')?.textContent === '注释');
    await page.click('.meo-md-collapsed-comment');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-collapsed-comment').length === 3);
    await page.evaluate(() => (window as any).__commentEditor.setLiveShowComments(true));
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-collapsed-comment').length === 0);
    await page.evaluate(() => (window as any).__commentEditor.destroy());
    await page.close();
  } finally {
    await browser.close();
  }
  console.log('Comment visibility browser test passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
