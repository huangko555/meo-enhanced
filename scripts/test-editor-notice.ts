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
    const result = await page.evaluate(async () => {
      const banner = document.getElementById('notice') as HTMLElement;
      let dismissCount = 0;
      let actionCount = 0;
      const controller = (window as any).EditorNoticeHarness.createEditorNoticeController(banner, 'zh-CN', () => {
        dismissCount += 1;
      });
      controller.setEditorNotice({
        message: 'First warning',
        actions: [{
          id: 'retry',
          label: '重试',
          emphasis: 'primary',
          run: () => { actionCount += 1; }
        }]
      }, 'warning');
      const closeButton = banner.querySelector<HTMLButtonElement>('.editor-notice-close');
      const retryButton = banner.querySelector<HTMLButtonElement>('[data-action="retry"]');
      const firstState = {
        visible: banner.classList.contains('is-visible') && !banner.hidden,
        text: banner.querySelector('.editor-notice-message')?.textContent ?? '',
        title: banner.querySelector('.editor-notice-title')?.textContent ?? '',
        closeText: closeButton?.textContent ?? '',
        closeLabel: closeButton?.getAttribute('aria-label') ?? '',
        closeIsLast: closeButton?.parentElement?.lastElementChild === closeButton,
        role: banner.getAttribute('role'),
        live: banner.getAttribute('aria-live'),
        retryText: retryButton?.textContent ?? ''
      };
      retryButton?.click();
      await Promise.resolve();
      closeButton?.click();
      const dismissed = banner.hidden && !banner.classList.contains('is-visible');
      controller.setEditorNotice('Second warning', 'error');
      const secondState = {
        visible: banner.classList.contains('is-visible') && !banner.hidden,
        text: banner.querySelector('.editor-notice-message')?.textContent ?? '',
        title: banner.querySelector('.editor-notice-title')?.textContent ?? '',
        kind: banner.dataset.kind,
        role: banner.getAttribute('role'),
        live: banner.getAttribute('aria-live')
      };
      controller.clearEditorNotice();

      let localizedMessage = '磁盘文件已修改';
      const manager = (window as any).EditorNoticeHarness.createFailureNoticeManager(controller);
      manager.setPersistentNotice(() => localizedMessage, 'warning');
      const persistentText = banner.querySelector('.editor-notice-message')?.textContent ?? '';
      manager.setFailureNotice('临时错误', 'error');
      const failureText = banner.querySelector('.editor-notice-message')?.textContent ?? '';
      manager.clearFailureNotice();
      const restoredPersistentText = banner.querySelector('.editor-notice-message')?.textContent ?? '';
      localizedMessage = 'The file changed on disk';
      manager.updateEditorNotice();
      const relocalizedText = banner.querySelector('.editor-notice-message')?.textContent ?? '';
      controller.setUiLanguage('en');
      manager.updateEditorNotice();
      const localizedChrome = {
        title: banner.querySelector('.editor-notice-title')?.textContent ?? '',
        closeText: banner.querySelector('.editor-notice-close')?.textContent ?? '',
        closeLabel: banner.querySelector('.editor-notice-close')?.getAttribute('aria-label') ?? ''
      };
      manager.dismissCurrentNotice();
      const persistentDismissed = banner.hidden;
      return {
        firstState, dismissed, dismissCount, actionCount, secondState,
        localizedChrome,
        persistentText, failureText, restoredPersistentText, relocalizedText, persistentDismissed
      };
    });

    if (!result.firstState.visible || result.firstState.text !== 'First warning' ||
      result.firstState.title !== '需要处理' || result.firstState.closeText !== '关闭' ||
      result.firstState.closeLabel !== '关闭通知' || !result.firstState.closeIsLast ||
      result.firstState.role !== 'status' || result.firstState.live !== 'polite' ||
      result.firstState.retryText !== '重试') {
      throw new Error(`notice close control was incorrect: ${JSON.stringify(result.firstState)}`);
    }
    if (!result.dismissed || result.dismissCount !== 1 || result.actionCount !== 1) {
      throw new Error('notice actions could not be invoked or dismissed');
    }
    if (!result.secondState.visible || result.secondState.text !== 'Second warning' ||
      result.secondState.title !== '编辑器问题' || result.secondState.kind !== 'error' ||
      result.secondState.role !== 'alert' || result.secondState.live !== 'assertive') {
      throw new Error(`notice did not reopen: ${JSON.stringify(result.secondState)}`);
    }
    if (result.persistentText !== '磁盘文件已修改' || result.failureText !== '临时错误' ||
      result.restoredPersistentText !== '磁盘文件已修改' || result.relocalizedText !== 'The file changed on disk' ||
      !result.persistentDismissed) {
      throw new Error(`persistent or localized notice lifecycle was incorrect: ${JSON.stringify(result)}`);
    }
    if (result.localizedChrome.title !== 'Action needed' || result.localizedChrome.closeText !== 'Dismiss' ||
      result.localizedChrome.closeLabel !== 'Dismiss notification') {
      throw new Error(`notice chrome did not relocalize: ${JSON.stringify(result.localizedChrome)}`);
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
