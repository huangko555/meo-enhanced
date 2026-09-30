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
    await page.setViewport({ width: 1100, height: 800 });
    await page.setContent(`<!doctype html>
      <html data-editor-appearance="dark">
        <head><style>
          :root {
            --meo-background: rgb(30, 30, 30);
            --meo-foreground: rgb(220, 220, 220);
            --vscode-editor-background: rgb(30, 30, 30);
            --vscode-sideBar-background: rgb(37, 37, 38);
            --vscode-banner-background: rgba(73, 82, 91, 0.58);
            --vscode-banner-foreground: rgba(238, 241, 244, 0.72);
            --vscode-button-background: rgb(0, 100, 200);
            --vscode-button-foreground: rgb(255, 255, 255);
            --vscode-focusBorder: rgb(0, 127, 212);
            --vscode-notificationsWarningIcon-foreground: rgb(204, 167, 0);
            --vscode-notificationsErrorIcon-foreground: rgb(241, 76, 76);
          }
          body { margin: 0; }
          #portal-menu, #find-menu, #settings-menu, #document-menu {
            box-sizing: border-box;
            left: 20px;
            width: 220px;
            height: 72px;
          }
          #portal-menu { top: 48px; }
          #find-menu { right: auto; }
          #window-controls { left: 20px; right: auto; width: 220px; }
          #settings-menu { left: 0; right: auto; }
          #document-menu { top: 48px; transform: none; }
        </style></head>
        <body><div class="editor-root">
          <div class="mode-toolbar">
            <div id="window-controls" class="toolbar-right">
              <div id="settings-menu" class="more-tools-panel">Settings menu</div>
            </div>
            <div id="find-menu" class="find-panel is-visible">Find menu</div>
          </div>
          <div id="notice" class="editor-notice"></div>
          <div class="editor-wrapper">
            <div id="document-menu" class="selection-inline-menu is-visible is-below">Document menu</div>
          </div>
        </div>
        <div id="portal-menu" class="preview-dropdown-panel">Portalled window menu</div>
        <div id="modal" class="meo-md-image-fullscreen-scrim" hidden></div>
        </body>
      </html>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(async () => {
      const harness = (window as any).EditorNoticeHarness;
      harness.applyBuiltInVisualBaseline('dark');
      const banner = document.getElementById('notice') as HTMLElement;
      let dismissCount = 0;
      let actionCount = 0;
      const controller = harness.createEditorNoticeController(banner, 'zh-CN', () => {
        dismissCount += 1;
      });
      controller.setEditorNotice({
        title: '实时渲染暂时中断',
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
      const content = banner.querySelector<HTMLElement>('.editor-notice-content');
      const icon = banner.querySelector<HTMLElement>('.editor-notice-icon');
      const title = banner.querySelector<HTMLElement>('.editor-notice-title');
      const message = banner.querySelector<HTMLElement>('.editor-notice-message');
      const bannerStyle = getComputedStyle(banner);
      const retryStyle = retryButton ? getComputedStyle(retryButton) : null;
      const titleRect = title?.getBoundingClientRect();
      const messageRect = message?.getBoundingClientRect();
      const bannerRect = banner.getBoundingClientRect();
      const toolbarBottom = document.querySelector('.mode-toolbar')?.getBoundingClientRect().bottom ?? 0;
      const firstState = {
        visible: banner.classList.contains('is-visible') && !banner.hidden,
        text: message?.textContent ?? '',
        title: title?.textContent ?? '',
        closeText: closeButton?.textContent ?? '',
        closeLabel: closeButton?.getAttribute('aria-label') ?? '',
        closeIsLast: closeButton?.parentElement?.lastElementChild === closeButton,
        role: banner.getAttribute('role'),
        live: banner.getAttribute('aria-live'),
        retryText: retryButton?.textContent ?? '',
        fontSize: bannerStyle.fontSize,
        opacity: bannerStyle.opacity,
        contentHeight: content?.getBoundingClientRect().height ?? 0,
        titleTop: titleRect?.top ?? 0,
        messageTop: messageRect?.top ?? 0,
        background: bannerStyle.backgroundColor,
        injectedBannerBackground: getComputedStyle(document.documentElement).getPropertyValue('--vscode-banner-background').trim(),
        editorBackground: getComputedStyle(document.documentElement).getPropertyValue('--meo-background').trim(),
        titleColor: title ? getComputedStyle(title).color : '',
        messageColor: message ? getComputedStyle(message).color : '',
        primaryBackground: retryStyle?.backgroundColor ?? '',
        primaryForeground: retryStyle?.color ?? '',
        primaryBoxShadow: retryStyle?.boxShadow ?? '',
        primaryHeight: retryButton?.getBoundingClientRect().height ?? 0,
        iconBackground: icon ? getComputedStyle(icon).backgroundColor : '',
        iconWidth: icon?.getBoundingClientRect().width ?? 0,
        iconColor: icon ? getComputedStyle(icon).color : '',
        borderLeftWidth: bannerStyle.borderLeftWidth,
        left: bannerRect.left,
        right: bannerRect.right,
        top: bannerRect.top,
        toolbarBottom
      };
      const portalMenu = document.getElementById('portal-menu') as HTMLElement;
      const findMenu = document.getElementById('find-menu') as HTMLElement;
      const windowControls = document.getElementById('window-controls') as HTMLElement;
      const modal = document.getElementById('modal') as HTMLElement;
      const hitAtOverlap = () => document.elementFromPoint(30, 60)?.id ?? '';
      const portalMenuHit = hitAtOverlap();
      portalMenu.style.display = 'none';
      const settingsMenuHit = hitAtOverlap();
      windowControls.style.display = 'none';
      const findMenuHit = hitAtOverlap();
      findMenu.style.display = 'none';
      const noticeHit = hitAtOverlap();
      banner.hidden = true;
      banner.classList.remove('is-visible');
      const documentMenuHit = hitAtOverlap();
      banner.hidden = false;
      banner.classList.add('is-visible');
      modal.hidden = false;
      const modalHit = hitAtOverlap();
      modal.hidden = true;
      windowControls.style.display = '';
      findMenu.style.display = '';
      portalMenu.style.display = '';
      const layerState = {
        portalMenuHit,
        findMenuHit,
        settingsMenuHit,
        noticeHit,
        documentMenuHit,
        modalHit,
        noticeParent: banner.parentElement?.className ?? ''
      };
      harness.applyBuiltInVisualBaseline('light');
      const lightState = {
        appearance: document.documentElement.dataset.editorAppearance,
        background: getComputedStyle(banner).backgroundColor,
        titleColor: title ? getComputedStyle(title).color : '',
        messageColor: message ? getComputedStyle(message).color : '',
        primaryBackground: retryButton ? getComputedStyle(retryButton).backgroundColor : '',
        primaryForeground: retryButton ? getComputedStyle(retryButton).color : '',
        iconColor: icon ? getComputedStyle(icon).color : ''
      };
      harness.applyBuiltInVisualBaseline('dark');
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
        live: banner.getAttribute('aria-live'),
        background: getComputedStyle(banner).backgroundColor,
        iconColor: getComputedStyle(banner.querySelector('.editor-notice-icon') as HTMLElement).color
      };
      controller.setEditorNotice({
        message: '风险仍在',
        actions: [{
          id: 'save-copy',
          label: '另存副本',
          emphasis: 'primary',
          run: async () => { throw new Error('无法核验副本'); }
        }]
      }, 'warning');
      const copyButton = banner.querySelector<HTMLButtonElement>('[data-action="save-copy"]');
      copyButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      const failedActionVisible = !banner.hidden && copyButton?.disabled === false &&
        banner.querySelector('.editor-notice-message')?.textContent ===
          '风险仍在 操作失败： 无法核验副本';
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

      let keyedRenders = 0;
      const keyedManager = (window as any).EditorNoticeHarness.createFailureNoticeManager({
        setEditorNotice: () => { keyedRenders += 1; },
        clearEditorNotice: () => undefined
      });
      keyedManager.setFailureNotice('retrying', 'warning', 'editor-mount');
      keyedManager.setFailureNotice('retrying', 'warning', 'editor-mount');
      const duplicateCoalesced = keyedRenders === 1;
      keyedManager.dismissCurrentNotice();
      keyedManager.setFailureNotice('retrying', 'warning', 'editor-mount');
      const dismissedOccurrenceSuppressed = keyedRenders === 1;
      keyedManager.setFailureNotice('different issue', 'error', 'editor-update');
      const differentOccurrenceShown = keyedRenders === 2;
      keyedManager.clearFailureNotice('editor-update');
      keyedManager.setFailureNotice('new occurrence', 'error', 'editor-update');
      const recoveredOccurrenceCanReopen = keyedRenders === 3;
      keyedManager.clearFailureNotice('editor-update');
      keyedManager.setPersistentNotice('changed on disk', 'warning', 'external-file-modified');
      keyedManager.dismissCurrentNotice();
      keyedManager.setPersistentNotice('changed on disk', 'warning', 'external-file-modified');
      const dismissedPersistentOccurrenceSuppressed = keyedRenders === 4;
      keyedManager.setPersistentNotice('deleted on disk', 'warning', 'external-file-deleted');
      const differentPersistentOccurrenceShown = keyedRenders === 5;
      return {
        firstState, layerState, lightState, dismissed, dismissCount, actionCount, secondState, failedActionVisible,
        localizedChrome,
        persistentText, failureText, restoredPersistentText, relocalizedText, persistentDismissed,
        duplicateCoalesced, dismissedOccurrenceSuppressed,
        differentOccurrenceShown, recoveredOccurrenceCanReopen,
        dismissedPersistentOccurrenceSuppressed, differentPersistentOccurrenceShown
      };
    });

    if (!result.firstState.visible || result.firstState.text !== 'First warning' ||
      result.firstState.title !== '实时渲染暂时中断' || result.firstState.closeText !== '关闭' ||
      result.firstState.closeLabel !== '关闭通知' || !result.firstState.closeIsLast ||
      result.firstState.role !== 'status' || result.firstState.live !== 'polite' ||
      result.firstState.retryText !== '重试') {
      throw new Error(`notice close control was incorrect: ${JSON.stringify(result.firstState)}`);
    }
    if (result.firstState.fontSize !== '13px' || result.firstState.opacity !== '1' ||
      result.firstState.contentHeight > 21 ||
      Math.abs(result.firstState.titleTop - result.firstState.messageTop) > 2 ||
      result.firstState.background === result.firstState.editorBackground ||
      result.firstState.background === result.firstState.injectedBannerBackground ||
      result.firstState.messageColor !== result.firstState.titleColor ||
      result.firstState.primaryBackground === 'rgba(0, 0, 0, 0)' ||
      result.firstState.primaryBackground === result.firstState.background ||
      result.firstState.primaryBoxShadow !== 'none' || result.firstState.primaryHeight !== 30 ||
      result.firstState.iconBackground !== 'rgba(0, 0, 0, 0)' || result.firstState.iconWidth !== 18 ||
      result.firstState.borderLeftWidth !== '0px' || result.firstState.left !== 0 ||
      result.firstState.right !== 1100 || result.firstState.top > result.firstState.toolbarBottom ||
      result.firstState.top < result.firstState.toolbarBottom - 4) {
      throw new Error(`notice presentation was incorrect: ${JSON.stringify(result.firstState)}`);
    }
    if (result.layerState.portalMenuHit !== 'portal-menu' ||
      result.layerState.findMenuHit !== 'find-menu' ||
      result.layerState.settingsMenuHit !== 'settings-menu' ||
      result.layerState.noticeHit !== 'notice' ||
      result.layerState.documentMenuHit !== 'document-menu' ||
      result.layerState.modalHit !== 'modal' ||
      result.layerState.noticeParent !== 'editor-root') {
      throw new Error(`editor layer ownership was incorrect: ${JSON.stringify(result.layerState)}`);
    }
    if (result.lightState.appearance !== 'light' ||
      result.lightState.background === result.firstState.background ||
      result.lightState.titleColor === result.firstState.titleColor ||
      result.lightState.messageColor !== result.lightState.titleColor ||
      result.lightState.primaryBackground === result.firstState.primaryBackground ||
      result.lightState.iconColor === result.firstState.iconColor) {
      throw new Error(`notice did not follow the editor appearance: ${JSON.stringify({
        dark: result.firstState,
        light: result.lightState
      })}`);
    }
    if (!result.failedActionVisible) throw new Error('failed notice action hid the original risk or could not be retried');
    if (!result.dismissed || result.dismissCount !== 1 || result.actionCount !== 1) {
      throw new Error('notice actions could not be invoked or dismissed');
    }
    if (!result.secondState.visible || result.secondState.text !== 'Second warning' ||
      result.secondState.title !== '编辑器问题' || result.secondState.kind !== 'error' ||
      result.secondState.role !== 'alert' || result.secondState.live !== 'assertive' ||
      result.secondState.background !== result.firstState.background ||
      result.secondState.iconColor === result.firstState.iconColor) {
      throw new Error(`notice did not reopen: ${JSON.stringify(result.secondState)}`);
    }
    if (result.persistentText !== '磁盘文件已修改' || result.failureText !== '临时错误' ||
      result.restoredPersistentText !== '磁盘文件已修改' || result.relocalizedText !== 'The file changed on disk' ||
      !result.persistentDismissed) {
      throw new Error(`persistent or localized notice lifecycle was incorrect: ${JSON.stringify(result)}`);
    }
    if (!result.duplicateCoalesced || !result.dismissedOccurrenceSuppressed ||
      !result.differentOccurrenceShown || !result.recoveredOccurrenceCanReopen ||
      !result.dismissedPersistentOccurrenceSuppressed || !result.differentPersistentOccurrenceShown) {
      throw new Error(`keyed notice escalation was incorrect: ${JSON.stringify(result)}`);
    }
    if (result.localizedChrome.title !== 'Action needed' || result.localizedChrome.closeText !== 'Dismiss' ||
      result.localizedChrome.closeLabel !== 'Dismiss notification') {
      throw new Error(`notice chrome did not relocalize: ${JSON.stringify(result.localizedChrome)}`);
    }
    const productionSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'index.ts'), 'utf8');
    if (!productionSource.includes('root.replaceChildren(toolbar, editorNoticeBanner, editorWrapper)') ||
      productionSource.includes('toolbar.replaceChildren(formatGroup, previewFormatGroup, toolbarOverflowIndicator, toolbarOverflowSection, toolbarRight, findPanelElements.panel, editorNoticeBanner)')) {
      throw new Error('production editor notice was not mounted as a root document-status layer');
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
