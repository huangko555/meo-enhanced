import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-notice-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-notice-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="notice" class="editor-notice"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(() => {
      const banner = document.getElementById('notice') as HTMLElement;
      let dismissCount = 0;
      const controller = (window as any).EditorNoticeHarness.createEditorNoticeController(banner, () => {
        dismissCount += 1;
      });
      controller.setEditorNotice('First warning', 'warning');
      const closeButton = banner.querySelector<HTMLButtonElement>('.editor-notice-close');
      const firstState = {
        visible: banner.classList.contains('is-visible') && !banner.hidden,
        text: banner.querySelector('.editor-notice-message')?.textContent ?? '',
        closeLabel: closeButton?.getAttribute('aria-label') ?? '',
        closeIsLast: banner.lastElementChild === closeButton
      };
      closeButton?.click();
      const dismissed = banner.hidden && !banner.classList.contains('is-visible');
      controller.setEditorNotice('Second warning', 'error');
      const secondState = {
        visible: banner.classList.contains('is-visible') && !banner.hidden,
        text: banner.querySelector('.editor-notice-message')?.textContent ?? '',
        kind: banner.dataset.kind
      };
      return { firstState, dismissed, dismissCount, secondState };
    });

    if (!result.firstState.visible || result.firstState.text !== 'First warning' ||
      result.firstState.closeLabel !== 'Dismiss notification' || !result.firstState.closeIsLast) {
      throw new Error(`notice close control was incorrect: ${JSON.stringify(result.firstState)}`);
    }
    if (!result.dismissed || result.dismissCount !== 1) throw new Error('notice could not be dismissed');
    if (!result.secondState.visible || result.secondState.text !== 'Second warning' || result.secondState.kind !== 'error') {
      throw new Error(`notice did not reopen: ${JSON.stringify(result.secondState)}`);
    }
    console.log('editor notice checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
