import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-webview-viewport-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function positionPreviewElement(page: Page, selector: string, ratio = 0): Promise<void> {
  await page.evaluate(({ targetSelector, targetRatio }) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const element = frameDocument.querySelector<HTMLElement>(targetSelector)!;
    const rect = element.getBoundingClientRect();
    frameDocument.scrollingElement!.scrollTop += rect.top + rect.height * targetRatio;
  }, { targetSelector: selector, targetRatio: ratio });
}

function createFixture(): string {
  const lines = Array.from({ length: 280 }, (_, index) => `stable line ${index + 1}`);
  lines[14] = '```javascript';
  for (let index = 15; index <= 34; index += 1) lines[index] = `const collapsed${index - 14} = ${index - 14};`;
  lines[35] = '```';
  lines[44] = '```python';
  for (let index = 45; index <= 54; index += 1) lines[index] = `short_${index - 44} = ${index - 44}`;
  lines[55] = '```';
  lines[77] = '## Short Mermaid';
  lines[78] = '```mermaid';
  lines[79] = 'flowchart LR';
  lines[80] = '  Start --> Done';
  lines[81] = '```';
  lines[108] = '```mermaid';
  lines[109] = 'sequenceDiagram';
  lines[110] = '  User->>Editor: Update';
  lines[111] = '  Editor-->>User: Render';
  lines[112] = '```';
  lines[132] = '```';
  for (let index = 133; index <= 220; index += 1) lines[index] = `const line${index - 132} = ${index - 132};`;
  lines[221] = '```';
  lines[230] = '## Tall Mermaid';
  lines[231] = '```mermaid';
  lines[232] = 'flowchart TD';
  lines[233] = '  Start --> Step18 --> End';
  lines[234] = '```';
  return lines.join('\n');
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    page.on('console', (message) => console.log(message.text()));
    await page.setViewport({ width: 420, height: 520, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body class="vscode-light"><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({ content: ':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#24292f;--vscode-sideBar-background:#f6f8fa;--vscode-panel-border:#d0d7de;--vscode-toolbar-hoverBackground:#eaeef2} html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    const previewMermaidRuntimeSrc = `data:text/javascript;base64,${Buffer.from(`
      window.__mermaidInitializeConfigs = [];
      window.__mermaidConfig = null;
      window.mermaid = {
        initialize(config) {
          window.__mermaidConfig = config;
          window.__mermaidInitializeConfigs.push(config);
        },
        async render(id, source) {
          const variables = window.__mermaidConfig?.themeVariables ?? {};
          const fill = variables.primaryColor ?? '#ffffff';
          const stroke = variables.primaryBorderColor ?? '#000000';
          return { svg: '<svg width="800" height="120" viewBox="0 0 800 120"><rect data-mermaid-node width="160" height="80" fill="' + fill + '" stroke="' + stroke + '"></rect></svg>' };
        }
      };
    `, 'utf8').toString('base64')}`;
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.__mermaidInitializeConfigs = [];
      window.__mermaidConfig = null;
      window.__holdTallMermaidRender = false;
      window.__pendingTallMermaidRenders = [];
      window.__releaseTallMermaidRender = () => {
        const pending = window.__pendingTallMermaidRenders.splice(0);
        if (pending.length === 0) throw new Error('No pending tall Mermaid render to release');
        window.__holdTallMermaidRender = false;
        for (const resolve of pending) resolve();
      };
      document.body.dataset.meoMermaidSrc = ${JSON.stringify(previewMermaidRuntimeSrc)};
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
      window.mermaid = {
        initialize(config) {
          window.__mermaidConfig = config;
          window.__mermaidInitializeConfigs.push(config);
        },
        async render(id, source) {
          if (source.includes('Step18') && window.__holdTallMermaidRender) {
            await new Promise(resolve => window.__pendingTallMermaidRenders.push(resolve));
          } else {
            await new Promise(resolve => setTimeout(resolve, source.includes('Step18') ? 650 : source.includes('Check') ? 80 : 5));
          }
          const height = source.includes('Step18') ? 3000 : source.includes('sequenceDiagram') ? 260 : 120;
          const variables = window.__mermaidConfig?.themeVariables ?? {};
          const fill = variables.primaryColor ?? '#ffffff';
          const stroke = variables.primaryBorderColor ?? '#000000';
          return { svg: '<svg width="800" height="' + height + '" viewBox="0 0 800 ' + height + '"><rect data-mermaid-node width="160" height="80" fill="' + fill + '" stroke="' + stroke + '"></rect></svg>' };
        }
      };
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await waitForFrames(page, 4);
    const pendingLanguageProjection = await page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.mode-toolbar')!;
      const visibleText = Array.from(toolbar.querySelectorAll<HTMLElement>('button, [role="button"], input'))
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map((element) => element.textContent?.trim() || element.getAttribute('aria-label') || element.title)
        .filter(Boolean);
      return { ariaHidden: toolbar.getAttribute('aria-hidden'), visibleText };
    });
    if (pendingLanguageProjection.ariaHidden !== 'true' || pendingLanguageProjection.visibleText.length !== 0) {
      throw new Error(`Unresolved UI language projected fallback English chrome: ${JSON.stringify(pendingLanguageProjection)}`);
    }

    const initialText = createFixture();
    await page.evaluate(({ text, theme }) => {
      const init = {
        type: 'init', documentId: 'file:///viewport.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark',
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      };
      window.dispatchEvent(new MessageEvent('message', { data: init }));
    }, { text: initialText, theme: darkBuiltInVisuals });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForFrames(page);
    const resolvedLanguageLayout = await page.evaluate(() => {
      const toolbarRight = document.querySelector<HTMLElement>('.toolbar-right')!;
      const visibleGroup = document.querySelector<HTMLElement>('.format-group')!;
      const rightBoundary = toolbarRight.getBoundingClientRect().left;
      const crossedBoundary = Array.from(visibleGroup.children).some((child) => {
        if (!(child instanceof HTMLElement) || getComputedStyle(child).display === 'none') return false;
        return child.getBoundingClientRect().right > rightBoundary + 1;
      });
      return {
        crossedBoundary,
        migratedCount: document.querySelectorAll('.toolbar-overflow-panel > .is-toolbar-overflow-item').length
      };
    });
    if (resolvedLanguageLayout.crossedBoundary || resolvedLanguageLayout.migratedCount === 0) {
      throw new Error(`Resolved language did not refresh toolbar overflow currentness: ${JSON.stringify(resolvedLanguageLayout)}`);
    }
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await waitForFrames(page, 4);
    const chineseChrome = await page.evaluate(() => ({
      language: document.documentElement.lang,
      previewTools: document.querySelector('.preview-format-group')?.getAttribute('aria-label'),
      sourceColoring: document.querySelector('.preview-source-coloring .preview-select-label')?.textContent?.trim(),
      exports: Array.from(document.querySelectorAll('[data-format]')).map((element) => element.textContent?.trim()),
      previewFrameTitle: document.querySelector('iframe.preview-frame')?.getAttribute('title'),
      previewAppearance: document.querySelector('.preview-appearance-control')?.getAttribute('aria-label'),
      editorAppearance: document.querySelector('.editor-appearance-control')?.getAttribute('aria-label'),
      outline: document.querySelector('.outline-sidebar')?.getAttribute('aria-label'),
      outlineLabel: document.querySelector('.outline-header-label')?.textContent,
      outlineClose: document.querySelector('[data-action="close"]')?.getAttribute('aria-label'),
      toolbar: document.querySelector('.mode-toolbar')?.getAttribute('aria-label'),
      formatting: document.querySelector('.format-group')?.getAttribute('aria-label'),
      heading: document.querySelector('[data-action="heading"]')?.getAttribute('title'),
      save: document.querySelector('[data-action="save"]')?.getAttribute('aria-label'),
      line: document.querySelector('.line-jump-input')?.getAttribute('placeholder'),
      dismissNotice: document.querySelector('.editor-notice-close')?.getAttribute('aria-label'),
      mode: document.querySelector('.mode-group')?.getAttribute('aria-label'),
      modeLabels: Array.from(document.querySelectorAll('.mode-group [data-mode]')).map((element) => element.textContent?.trim()),
      selectionMenu: document.querySelector('.selection-inline-menu')?.getAttribute('aria-label'),
      selectionLabels: Array.from(document.querySelectorAll('.selection-inline-menu [data-action]')).map((element) => element.getAttribute('aria-label')),
      scrollToTop: Array.from(document.querySelectorAll('.document-scroll-top')).map((element) => element.getAttribute('aria-label'))
    }));
    if (JSON.stringify(chineseChrome) !== JSON.stringify({
      language: 'zh-CN',
      previewTools: '预览工具',
      sourceColoring: '代码着色',
      exports: ['导出 HTML', '导出 PDF'],
      previewFrameTitle: 'Markdown 预览',
      previewAppearance: '预览外观',
      editorAppearance: '编辑器外观',
      outline: '文档目录',
      outlineLabel: '目录',
      outlineClose: '关闭目录',
      toolbar: '编辑器工具栏',
      formatting: '格式',
      heading: '标题',
      save: '保存文档',
      line: '行号',
      dismissNotice: '关闭通知',
      mode: 'Markdown 模式',
      modeLabels: ['实时', '源码', '预览'],
      selectionMenu: '行内 Markdown 格式',
      selectionLabels: ['加粗', '斜体', '删除线', '高亮', '行内代码', '链接', 'Wiki 链接', '按键', '下划线'],
      scrollToTop: ['回到顶部', '回到顶部']
    })) {
      throw new Error(`Resolved UI language did not project into the current Webview: ${JSON.stringify(chineseChrome)}`);
    }
    const liveLineNumberBoundary = await page.evaluate(() => ({
      gutter: Boolean(document.querySelector('.editor-host .cm-lineNumbers')),
      meoToggle: Boolean(document.querySelector('[data-action="lineNumbers"]'))
    }));
    await page.click('[data-mode="source"]');
    const sourceLineNumberGutter = await page.$('.editor-host .cm-lineNumbers');
    await page.click('[data-mode="live"]');
    if (!liveLineNumberBoundary.gutter || liveLineNumberBoundary.meoToggle || !sourceLineNumberGutter) {
      throw new Error(`Line-number ownership boundary regressed: ${JSON.stringify(liveLineNumberBoundary)}`);
    }
    await page.evaluate((position) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'revealSelection', anchor: position, head: position, focus: false }
    })), initialText.indexOf('stable line 83'));
    await waitForFrames(page);
    const liveHeadingFolding = await page.evaluate(() => ({
      gutterCount: document.querySelectorAll('.meo-md-fold-gutter').length,
      toggleCount: document.querySelectorAll('.meo-md-fold-toggle').length,
      sectionContentVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('stable line 83'))
    }));
    if (
      liveHeadingFolding.gutterCount !== 0 ||
      liveHeadingFolding.toggleCount !== 0 ||
      !liveHeadingFolding.sectionContentVisible
    ) {
      throw new Error(`Live exposed custom heading folding: ${JSON.stringify(liveHeadingFolding)}`);
    }
    await page.evaluate((position) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'revealSelection', anchor: position, head: position, focus: false }
    })), initialText.indexOf('stable line 139'));
    await waitForFrames(page);
    await page.click('[data-action="outline-right"]');
    await waitForFrames(page, 2);
    const outlineDragSurface = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('.outline-item'));
      const source = items[0]!;
      const target = items[1]!;
      const dataTransfer = new DataTransfer();
      const dragStartAllowed = source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: target.getBoundingClientRect().bottom,
        dataTransfer
      }));
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: target.getBoundingClientRect().bottom,
        dataTransfer
      }));
      return {
        itemCount: items.length,
        draggable: source.draggable,
        dragStartAllowed,
        ariaGrabbed: source.hasAttribute('aria-grabbed'),
        indicatorCount: document.querySelectorAll('.outline-drop-before, .outline-drop-after').length
      };
    });
    if (
      outlineDragSurface.itemCount < 2 ||
      outlineDragSurface.draggable ||
      !outlineDragSurface.dragStartAllowed ||
      outlineDragSurface.ariaGrabbed ||
      outlineDragSurface.indicatorCount !== 0
    ) {
      throw new Error(`Outline exposed a heading drag surface: ${JSON.stringify(outlineDragSurface)}`);
    }
    await page.click('.outline-header [data-action="close"]');
    await waitForFrames(page, 2);
    const darkEditorOnLightHost = await page.evaluate(() => ({
      appearance: document.documentElement.dataset.editorAppearance,
      background: getComputedStyle(document.body).backgroundColor
    }));
    if (
      darkEditorOnLightHost.appearance !== 'dark' ||
      darkEditorOnLightHost.background !== 'rgb(36, 41, 46)'
    ) {
      throw new Error(`Dark editor appearance followed the light VS Code host: ${JSON.stringify(darkEditorOnLightHost)}`);
    }
    const initialPreviewPreloadRequests = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'requestPreviewRender').length);
    if (initialPreviewPreloadRequests !== 1) {
      throw new Error(`Live initialization must preload Preview exactly once, received ${initialPreviewPreloadRequests}`);
    }
    await page.evaluate(() => {
      for (const requestId of ['browser-snapshot-1', 'browser-snapshot-2']) {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'requestExportSnapshot', requestId }
        }));
      }
    });
    await page.waitForFunction(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportSnapshotResult').length === 2);
    const snapshotResults = await page.evaluate(() => (
      (window as typeof window & {
        __hostMessages?: Array<{
          type?: string;
          requestId?: string;
          result?: { ok?: boolean; value?: { text?: string; environment?: { editorBackgroundColor?: string } } };
        }>;
      }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportSnapshotResult').map((message) => ({
      requestId: message.requestId,
      ok: message.result?.ok,
      text: message.result?.value?.text,
      hasCurrentText: message.result?.value?.text?.includes('## Tall Mermaid') === true,
      hasStyleEnvironment: typeof message.result?.value?.environment?.editorBackgroundColor === 'string'
    })));
    if (JSON.stringify(snapshotResults) !== JSON.stringify([
      { requestId: 'browser-snapshot-1', ok: true, text: initialText, hasCurrentText: true, hasStyleEnvironment: true },
      { requestId: 'browser-snapshot-2', ok: true, text: initialText, hasCurrentText: true, hasStyleEnvironment: true }
    ])) {
      throw new Error(`Export snapshot lifecycle did not return independent decoded responses: ${JSON.stringify(snapshotResults)}`);
    }
    const toolbarLayout = await page.evaluate(() => {
      const label = (element: HTMLElement): string => {
        if (element.dataset.action) return element.dataset.action;
        if (element.classList.contains('line-jump-control')) return 'line-jump';
        if (element.classList.contains('format-separator')) return 'separator';
        if (element.classList.contains('changes-controls')) return 'changes';
        if (element.classList.contains('more-tools-wrapper')) return 'more';
        return element.className;
      };
      return {
        left: Array.from(document.querySelector<HTMLElement>('.format-group')!.children).map(label),
        right: Array.from(document.querySelector<HTMLElement>('.right-group')!.children).map(label),
        changes: Array.from(document.querySelector<HTMLElement>('.changes-controls')!.children).map(label)
      };
    });
    if (
      JSON.stringify(toolbarLayout.left.slice(0, 5)) !== JSON.stringify(['outline-left', 'line-jump', 'save', 'discard', 'separator']) ||
      JSON.stringify(toolbarLayout.right) !== JSON.stringify(['changes', 'separator', 'find', 'outline-right', 'more']) ||
      JSON.stringify(toolbarLayout.changes) !== JSON.stringify(['changes-review-trigger', 'changes-review-panel'])
    ) {
      throw new Error(`Unexpected toolbar layout: ${JSON.stringify(toolbarLayout)}`);
    }
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitChangesGutterChanged', enabled: false }
    })));
    await waitForFrames(page, 2);
    await page.click('.changes-review-trigger');
    const inactiveMarkerSetting = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-baseline="none"]')!;
      const sourceOnlyButton = document.querySelector<HTMLButtonElement>('[data-toggle="before-content"]')!;
      const panel = document.querySelector<HTMLElement>('.changes-review-panel')!;
      const trigger = document.querySelector<HTMLElement>('.changes-review-trigger')!;
      const triggerRect = trigger.getBoundingClientRect();
      const triggerCenter = triggerRect.top + triggerRect.height / 2;
      const centerOffset = (selector: string) => {
        const rect = trigger.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return Math.round((rect.top + rect.height / 2 - triggerCenter) * 100) / 100;
      };
      return {
        checked: button.getAttribute('aria-checked'),
        label: button.querySelector('.changes-review-option-label')?.textContent,
        headerText: panel.querySelector('.changes-review-header')?.textContent,
        headerHeight: panel.querySelector<HTMLElement>('.changes-review-header')?.getBoundingClientRect().height,
        headerPadding: [
          getComputedStyle(panel.querySelector<HTMLElement>('.changes-review-header')!).paddingTop,
          getComputedStyle(panel.querySelector<HTMLElement>('.changes-review-header')!).paddingBottom
        ],
        baselineLabels: Array.from(panel.querySelectorAll<HTMLElement>('[data-baseline] .changes-review-option-label'))
          .map((label) => label.textContent),
        baselineLabelsClipped: Array.from(panel.querySelectorAll<HTMLElement>('[data-baseline] .changes-review-option-label'))
          .some((label) => label.scrollWidth > label.clientWidth),
        baselineIconCount: panel.querySelectorAll('[data-baseline] .changes-review-option-icon svg').length,
        selectedBaselineCheckCount: panel.querySelectorAll('[data-baseline] .changes-review-check svg').length,
        snapshotIconCount: panel.querySelectorAll('.changes-review-snapshot-select .changes-review-option-icon svg').length,
        snapshotCreateHint: panel.querySelector('.changes-review-snapshot-create-hint')?.textContent,
        snapshotActionCount: panel.querySelectorAll('.changes-review-snapshot-action').length,
        snapshotSelectAction: panel.querySelector<HTMLElement>('.changes-review-snapshot-select')?.dataset.action,
        snapshotSelectDisabled: panel.querySelector<HTMLButtonElement>('.changes-review-snapshot-select')?.disabled,
        panelWidth: panel.getBoundingClientRect().width,
        panelClientWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        triggerHeight: trigger.getBoundingClientRect().height,
        triggerIconSize: trigger.querySelector<SVGElement>('.changes-review-trigger-icon svg')?.getAttribute('width'),
        triggerCenterOffsets: [
          centerOffset('.changes-review-trigger-icon'),
          centerOffset('.changes-review-counts'),
          centerOffset('.changes-review-chevron')
        ],
        chevronCount: trigger.querySelectorAll('.changes-review-chevron').length,
        chevronSize: trigger.querySelector<SVGElement>('.changes-review-chevron svg')?.getAttribute('width'),
        baselineGaps: Array.from(panel.querySelectorAll<HTMLElement>('.changes-review-baseline-option'))
          .map((option, index, options) => index === 0
            ? null
            : option.getBoundingClientRect().top - options[index - 1]!.getBoundingClientRect().bottom)
          .slice(1),
        sourceOnlyDisabled: sourceOnlyButton.disabled,
        sourceOnlyOpacity: getComputedStyle(sourceOnlyButton).opacity,
        sourceOnlyMatchesMarkerColor: getComputedStyle(sourceOnlyButton).color === getComputedStyle(button).color
      };
    });
    if (JSON.stringify(inactiveMarkerSetting) !== JSON.stringify({
      checked: 'true',
      label: '关闭比较',
      headerText: '不比较',
      headerHeight: 36,
      headerPadding: ['2px', '3px'],
      baselineLabels: ['关闭比较', '与最近保存版本比较', '与 Agent 编辑前版本比较', '与 Git HEAD 比较'],
      baselineLabelsClipped: false,
      baselineIconCount: 4,
      selectedBaselineCheckCount: 1,
      snapshotIconCount: 1,
      snapshotCreateHint: '点击创建',
      snapshotActionCount: 0,
      snapshotSelectAction: 'create-snapshot',
      snapshotSelectDisabled: false,
      panelWidth: 268,
      panelClientWidth: 266,
      panelScrollWidth: 266,
      triggerHeight: 24,
      triggerIconSize: '16',
      triggerCenterOffsets: [0, 0, 0],
      chevronCount: 1,
      chevronSize: '12',
      baselineGaps: [2, 2, 2],
      sourceOnlyDisabled: true,
      sourceOnlyOpacity: '1',
      sourceOnlyMatchesMarkerColor: false
    })) {
      throw new Error(`Change marker setting did not reflect host state: ${JSON.stringify(inactiveMarkerSetting)}`);
    }
    await page.click('[data-baseline="current-edit"]');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'gitBaselineChanged', version: 1,
      payload: {
        available: false, tracked: false, mode: 'current-edit', generation: 0, reason: 'too-large'
      }
    }})));
    await waitForFrames(page, 2);
    const unavailableSavedBaseline = await page.evaluate(() => ({
      trigger: document.querySelector('.changes-review-trigger')?.textContent,
      header: document.querySelector('.changes-review-header')?.textContent
    }));
    if (JSON.stringify(unavailableSavedBaseline) !== JSON.stringify({
      trigger: '无法比较',
      header: '无法比较·文件过大'
    })) {
      throw new Error(`Unavailable Saved File baseline looked like no changes: ${JSON.stringify(unavailableSavedBaseline)}`);
    }
    await page.evaluate((baseText) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'gitBaselineChanged', version: 1,
      payload: {
        available: true, tracked: true, mode: 'current-edit', generation: 0, baseText
      }
    }})), initialText);
    await waitForFrames(page, 2);
    const createSnapshotMessageCount = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; enabled?: boolean }> })
        .__hostMessages ?? [];
      const before = messages.filter((message) => message.type === 'setFixedBaseline' && message.enabled === true).length;
      document.querySelector<HTMLButtonElement>('.changes-review-snapshot-select')!.click();
      const after = messages.filter((message) => message.type === 'setFixedBaseline' && message.enabled === true).length;
      return { before, after };
    });
    if (createSnapshotMessageCount.after !== createSnapshotMessageCount.before + 1) {
      throw new Error(`Clicking the empty snapshot row did not request creation: ${JSON.stringify(createSnapshotMessageCount)}`);
    }
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-ui-language="en"]')!.click());
    await waitForFrames(page, 2);
    const englishReviewMenu = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll<HTMLElement>('.changes-review-option-label'));
      const header = document.querySelector<HTMLElement>('.changes-review-header')!;
      const headerBaseline = header.querySelector<HTMLElement>('.changes-review-header-baseline')!;
      return {
        labels: labels.map((label) => label.textContent),
        headerText: header.textContent,
        settingsHeading: document.querySelector<HTMLElement>('.more-tools-section-label')?.textContent,
        stickyHeaderLabel: document.querySelector<HTMLElement>(
          '[data-action="tableStickyHeader"] .more-tools-option-label'
        )?.textContent,
        clipped: labels.some((label) => label.scrollWidth > label.clientWidth)
          || header.scrollWidth > header.clientWidth
          || headerBaseline.scrollWidth > headerBaseline.clientWidth
      };
    });
    if (JSON.stringify(englishReviewMenu) !== JSON.stringify({
      labels: [
        'Turn Off Comparison',
        'Last Saved Version',
        'Before Agent Edits',
        'Git HEAD',
        'Manual Snapshot',
        'Show Original · Source Only'
      ],
      headerText: 'No Changes·vs. Last Saved Version',
      settingsHeading: 'Editor Settings',
      stickyHeaderLabel: 'Sticky table header',
      clipped: false
    })) {
      throw new Error(`English change review labels did not fit the shared menu width: ${JSON.stringify(englishReviewMenu)}`);
    }
    const stickyHeaderSetting = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<Record<string, unknown>> })
        .__hostMessages ?? [];
      const button = document.querySelector<HTMLButtonElement>('[data-action="tableStickyHeader"]')!;
      button.click();
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        message: messages.at(-1)
      };
    });
    if (JSON.stringify(stickyHeaderSetting) !== JSON.stringify({
      active: false,
      checked: 'false',
      message: { type: 'setTableStickyHeader', enabled: false }
    })) {
      throw new Error(`Sticky table header setting did not post its disabled state: ${JSON.stringify(stickyHeaderSetting)}`);
    }
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'tableStickyHeaderChanged', enabled: true }
    })));
    await waitForFrames(page, 2);
    const restoredStickyHeaderSetting = await page.$eval<HTMLElement, [boolean, string | null]>(
      '[data-action="tableStickyHeader"]',
      (button) => [button.classList.contains('is-active'), button.getAttribute('aria-checked')]
    );
    if (JSON.stringify(restoredStickyHeaderSetting) !== JSON.stringify([true, 'true'])) {
      throw new Error(`Sticky table header host update was not applied: ${JSON.stringify(restoredStickyHeaderSetting)}`);
    }
    const recentSaveHeaders = await page.evaluate(() => {
      const read = () => {
        const header = document.querySelector<HTMLElement>('.changes-review-header')!;
        const baseline = header.querySelector<HTMLElement>('.changes-review-header-baseline')!;
        return {
          text: header.textContent,
          clipped: header.scrollWidth > header.clientWidth || baseline.scrollWidth > baseline.clientWidth
        };
      };
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffBaselineModeChanged', mode: 'recent-save'
      }}));
      const english = read();
      document.querySelector<HTMLButtonElement>('[data-ui-language="zh-CN"]')!.click();
      const chinese = read();
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'diffBaselineModeChanged', mode: 'current-edit'
      }}));
      return { english, chinese };
    });
    if (JSON.stringify(recentSaveHeaders) !== JSON.stringify({
      english: { text: 'No Changes·vs. Before Agent Edits', clipped: false },
      chinese: { text: '无更改·与Agent 编辑前版本对比', clipped: false }
    })) {
      throw new Error(`Recent-save headers did not fit both languages: ${JSON.stringify(recentSaveHeaders)}`);
    }
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-ui-language="zh-CN"]')!.click());
    await waitForFrames(page, 2);
    await page.click('[data-baseline="git-head"]');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'gitBaselineChanged',
      version: 1,
      payload: {
        available: false,
        tracked: false,
        mode: 'git-head',
        generation: 0,
        reason: 'not-repo'
      }
    }})));
    const unavailableGitBaseline = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-baseline="git-head"]')!;
      return {
        label: button.querySelector('.changes-review-option-label')?.textContent,
        checked: button.getAttribute('aria-checked'),
        ariaDisabled: button.getAttribute('aria-disabled'),
        disabled: button.disabled,
        cursor: getComputedStyle(button).cursor,
        checkIconCount: button.querySelectorAll('.changes-review-check:not(.is-warning) svg').length,
        warningIconCount: button.querySelectorAll('.changes-review-check.is-warning svg').length,
        circleWarningIconCount: button.querySelectorAll('.changes-review-check.is-warning svg circle').length,
        warningColor: getComputedStyle(button.querySelector<HTMLElement>('.changes-review-check')!).color,
        headerText: document.querySelector('.changes-review-header')?.textContent,
        triggerText: document.querySelector('.changes-review-trigger')?.textContent
      };
    });
    if (JSON.stringify(unavailableGitBaseline) !== JSON.stringify({
      label: '与 Git HEAD 比较 · 非 Git 仓库',
      checked: 'true',
      ariaDisabled: null,
      disabled: false,
      cursor: 'pointer',
      checkIconCount: 0,
      warningIconCount: 1,
      circleWarningIconCount: 1,
      warningColor: 'rgb(241, 76, 76)',
      headerText: '无法比较·非 Git 仓库',
      triggerText: '无法比较'
    })) {
      throw new Error(`Unavailable Git baseline was not explained inline: ${JSON.stringify(unavailableGitBaseline)}`);
    }
    const gitStateLayout = await page.evaluate(() => {
      const cases = [
        { available: false, tracked: false, reason: 'git-unavailable' },
        { available: false, tracked: false, reason: 'not-repo' },
        { available: false, tracked: false, reason: 'ignored' },
        { available: true, tracked: false, headOid: 'abc123' },
        { available: true, tracked: true, headOid: null },
        { available: false, tracked: false, reason: 'not-file' },
        { available: true, tracked: true, headOid: 'abc123', reason: 'too-large' },
        { available: true, tracked: true, headOid: 'abc123', reason: 'binary' },
        { available: true, tracked: true, headOid: 'abc123', reason: 'error' },
        { available: true, tracked: true, headOid: 'abc123' }
      ];
      const run = (language: 'zh-CN' | 'en') => {
        document.querySelector<HTMLButtonElement>(`[data-ui-language="${language}"]`)!.click();
        return cases.map((payload) => {
          window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'gitBaselineChanged', version: 1,
            payload: { ...payload, mode: 'git-head', generation: 0 }
          }}));
          const panel = document.querySelector<HTMLElement>('.changes-review-panel')!;
          const optionLabel = panel.querySelector<HTMLElement>('[data-baseline="git-head"] .changes-review-option-label')!;
          const header = panel.querySelector<HTMLElement>('.changes-review-header')!;
          const headerBaseline = panel.querySelector<HTMLElement>('.changes-review-header-baseline')!;
          return {
            label: optionLabel.textContent,
            header: header.textContent,
            disabled: panel.querySelector<HTMLButtonElement>('[data-baseline="git-head"]')!.disabled,
            warning: optionLabel.parentElement?.querySelectorAll('.changes-review-check.is-warning svg').length === 1,
            check: optionLabel.parentElement?.querySelectorAll('.changes-review-check:not(.is-warning) svg').length === 1,
            clipped: optionLabel.scrollWidth > optionLabel.clientWidth
              || headerBaseline.scrollWidth > headerBaseline.clientWidth
              || header.scrollWidth > header.clientWidth
              || panel.scrollWidth > panel.clientWidth
          };
        });
      };
      const result = { chinese: run('zh-CN'), english: run('en') };
      document.querySelector<HTMLButtonElement>('[data-ui-language="zh-CN"]')!.click();
      return result;
    });
    const expectedGitLabels = {
      chinese: [
        '与 Git HEAD 比较 · Git 不可用', '与 Git HEAD 比较 · 非 Git 仓库', '与 Git HEAD 比较 · Git 已忽略',
        '与 Git HEAD 比较 · 未跟踪文件', '与 Git HEAD 比较 · 暂无提交', '与 Git HEAD 比较 · 非本地文件',
        '与 Git HEAD 比较 · 文件过大', '与 Git HEAD 比较 · 二进制文件', '与 Git HEAD 比较 · 暂不可用', '与 Git HEAD 比较'
      ],
      english: [
        'Git HEAD · Git Unavailable', 'Git HEAD · Not a Git Repo', 'Git HEAD · Ignored by Git',
        'Git HEAD · Untracked File', 'Git HEAD · No Commits', 'Git HEAD · Not a Local File',
        'Git HEAD · File Too Large', 'Git HEAD · Binary File', 'Git HEAD · Temporary Error', 'Git HEAD'
      ]
    };
    for (const language of ['chinese', 'english'] as const) {
      const states = gitStateLayout[language];
      if (
        JSON.stringify(states.map((entry) => entry.label)) !== JSON.stringify(expectedGitLabels[language])
        || states.some((entry) => entry.clipped)
        || states.some((entry) => entry.disabled)
        || states.map((entry) => entry.warning).join(',') !== 'true,true,true,false,false,true,true,true,true,false'
        || states.map((entry) => entry.check).join(',') !== 'false,false,false,true,true,false,false,false,false,true'
      ) {
        throw new Error(`Git review states did not fit the shared menu in ${language}: ${JSON.stringify(states)}`);
      }
    }
    await page.click('[data-baseline="current-edit"]');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'diffBaselineModeChanged', mode: 'current-edit'
    }})));
    const unselectedGitWarning = await page.$eval('[data-baseline="git-head"]', (button) => ({
      checked: button.getAttribute('aria-checked'),
      warningIconCount: button.querySelectorAll('.changes-review-check.is-warning svg').length,
      checkIconCount: button.querySelectorAll('.changes-review-check:not(.is-warning) svg').length
    }));
    if (JSON.stringify(unselectedGitWarning) !== JSON.stringify({
      checked: 'false', warningIconCount: 0, checkIconCount: 0
    })) {
      throw new Error(`Unselected Git baseline should not show a warning: ${JSON.stringify(unselectedGitWarning)}`);
    }
    await page.click('[data-toggle="before-content"]');
    const liveBeforeContentSetting = await page.evaluate(() => ({
      checked: document.querySelector<HTMLElement>('[data-toggle="before-content"]')?.getAttribute('aria-checked'),
      rendered: document.querySelector<HTMLElement>('.editor-host > .cm-editor')
        ?.classList.contains('meo-git-diff-details-visible')
    }));
    if (JSON.stringify(liveBeforeContentSetting) !== JSON.stringify({ checked: 'true', rendered: false })) {
      throw new Error(`Live mode did not retain the source-only preference independently: ${JSON.stringify(liveBeforeContentSetting)}`);
    }
    await page.click('[data-toggle="before-content"]');
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitChangesGutterChanged', enabled: true }
    })));
    await page.click('.more-tools-wrapper > button');
    const moreToolsLayout = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.more-tools-panel')!;
      const options = Array.from(panel.querySelectorAll<HTMLElement>(':scope > .more-tools-option'));
      return {
        labels: options.map((option) => option.querySelector('.more-tools-option-label')?.textContent),
        topHeading: panel.querySelector<HTMLElement>(':scope > .more-tools-section-label')?.textContent,
        languageAutoLabel: panel.querySelector<HTMLElement>('[data-ui-language="auto"] .segmented-control-button-label')?.textContent,
        directChildren: options.every((option) => option.parentElement === panel),
        separatorCount: panel.querySelectorAll(':scope > .more-tools-separator').length,
        feedbackPrompt: panel.querySelector<HTMLElement>('.more-tools-feedback-prompt')?.textContent,
        feedbackLabel: panel.querySelector<HTMLElement>('.more-tools-feedback-link')?.textContent?.trim(),
        width: panel.getBoundingClientRect().width,
        clientWidth: panel.clientWidth,
        scrollWidth: panel.scrollWidth,
        fontSizeModeHeight: panel.querySelector<HTMLElement>('.editor-font-size-mode-control')
          ?.getBoundingClientRect().height,
        fontSizeStepperHeight: panel.querySelector<HTMLElement>('.editor-font-size-stepper')
          ?.getBoundingClientRect().height
      };
    });
    if (
      JSON.stringify(moreToolsLayout.labels) !== JSON.stringify([
        '显示行号', '折叠长代码块', '限制内容宽度', '表格浮动表头', '打开时恢复上一次阅读位置'
      ]) ||
      moreToolsLayout.topHeading !== '编辑器设置' ||
      moreToolsLayout.languageAutoLabel !== '自动' ||
      !moreToolsLayout.directChildren ||
      moreToolsLayout.separatorCount !== 1 ||
      moreToolsLayout.feedbackPrompt !== '使用中遇到问题？' ||
      moreToolsLayout.feedbackLabel !== '欢迎反馈' ||
      moreToolsLayout.width > 268 ||
      moreToolsLayout.scrollWidth > moreToolsLayout.clientWidth ||
      moreToolsLayout.fontSizeModeHeight !== 26 ||
      moreToolsLayout.fontSizeStepperHeight !== 26
    ) {
      throw new Error(`Unexpected flat More tools layout: ${JSON.stringify(moreToolsLayout)}`);
    }
    await page.click('.more-tools-feedback-link');
    const feedbackAction = await page.evaluate(() => ({
      panelClosed: document.querySelector<HTMLElement>('.more-tools-panel')!.hidden,
      message: window.__hostMessages.at(-1)
    }));
    if (!feedbackAction.panelClosed || JSON.stringify(feedbackAction.message) !== JSON.stringify({
      type: 'openLink',
      href: 'https://github.com/huangko555/meo-enhanced/issues/new'
    })) {
      throw new Error(`Unexpected feedback action: ${JSON.stringify(feedbackAction)}`);
    }
    const measureToolbarStart = () => page.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.mode-toolbar')!;
      const firstButton = document.querySelector<HTMLElement>('.format-group > .format-button')!;
      const modeControl = document.querySelector<HTMLElement>('.mode-group')!;
      const activeModeButton = modeControl.querySelector<HTMLElement>('.is-active')!;
      const modeButtons = Array.from(modeControl.querySelectorAll<HTMLElement>('.segmented-control-button'));
      const activeModeIndicator = activeModeButton.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
      const activeModeLabel = activeModeButton.querySelector<HTMLElement>('.segmented-control-button-label')!;
      const modeControlBounds = modeControl.getBoundingClientRect();
      const activeModeBounds = activeModeIndicator.getBoundingClientRect();
      const activeModeLabelBounds = activeModeLabel.getBoundingClientRect();
      return {
        paddingLeft: Number.parseFloat(getComputedStyle(toolbar).paddingLeft),
        firstButtonOffset: firstButton.getBoundingClientRect().left - toolbar.getBoundingClientRect().left,
        toolbarHeight: toolbar.getBoundingClientRect().height,
        modeControlHeight: modeControl.getBoundingClientRect().height,
        modeControlRadius: Number.parseFloat(getComputedStyle(modeControl).borderRadius),
        activeModeRadius: Number.parseFloat(getComputedStyle(activeModeIndicator).borderRadius),
        activeModeLabelOffset: activeModeBounds.top + activeModeBounds.height / 2
          - (activeModeLabelBounds.top + activeModeLabelBounds.height / 2),
        modeButtonWidths: Object.fromEntries(modeButtons.map((button) => [
          button.dataset.mode,
          button.getBoundingClientRect().width
        ])),
        activeModeInsets: {
          top: activeModeBounds.top - modeControlBounds.top,
          bottom: modeControlBounds.bottom - activeModeBounds.bottom,
          left: activeModeBounds.left - modeControlBounds.left
        },
        modeSegmentGap: modeButtons[1].getBoundingClientRect().left - modeButtons[0].getBoundingClientRect().right,
        modeUsesSharedComponent: modeControl.classList.contains('segmented-control')
      };
    });
    const initialToolbarStart = await measureToolbarStart();
    await page.hover('[data-mode="source"]');
    const inactiveModeHoverBackground = await page.$eval<HTMLElement, string>(
      '[data-mode="source"]',
      (element) => getComputedStyle(element).backgroundColor
    );
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'contentMaxWidthChanged', enabled: true } }));
    });
    await waitForFrames(page);
    const toggledToolbarStart = await measureToolbarStart();
    const constrainedWidthState = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="contentMaxWidth"]')!;
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        widthOverride: document.documentElement.style.getPropertyValue('--meo-content-max-width'),
        hostWidth: document.querySelector('.editor-host')!.getBoundingClientRect().width,
        viewportWidth: document.querySelector('.editor-host > .cm-editor')!.getBoundingClientRect().width,
        toolbarWidth: document.querySelector('.mode-toolbar')!.getBoundingClientRect().width
      };
    });
    if (
      initialToolbarStart.paddingLeft !== 10 ||
      Math.abs(initialToolbarStart.firstButtonOffset - 10) > 0.5 ||
      initialToolbarStart.toolbarHeight !== 40 ||
      initialToolbarStart.modeControlHeight !== 26 ||
      initialToolbarStart.modeControlRadius !== 8 ||
      initialToolbarStart.activeModeRadius !== 5 ||
      initialToolbarStart.activeModeLabelOffset !== 0.5 ||
      Object.values(initialToolbarStart.modeButtonWidths).some((width) => width !== 56) ||
      JSON.stringify(initialToolbarStart.activeModeInsets) !== JSON.stringify({ top: 3, bottom: 3, left: 4 }) ||
      initialToolbarStart.modeSegmentGap !== 0 ||
      !initialToolbarStart.modeUsesSharedComponent ||
      inactiveModeHoverBackground !== 'rgba(0, 0, 0, 0)' ||
      toggledToolbarStart.paddingLeft !== 10 ||
      Math.abs(toggledToolbarStart.firstButtonOffset - 10) > 0.5 ||
      !constrainedWidthState.active ||
      constrainedWidthState.checked !== 'true' ||
      constrainedWidthState.widthOverride !== '800px' ||
      constrainedWidthState.hostWidth !== 900 ||
      constrainedWidthState.viewportWidth !== 900 ||
      constrainedWidthState.toolbarWidth !== 900
    ) {
      throw new Error(`Toolbar settings did not update as expected: ${JSON.stringify({ initialToolbarStart, toggledToolbarStart, constrainedWidthState })}`);
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'contentMaxWidthChanged', enabled: false } }));
    });
    await waitForFrames(page);
    const unconstrainedWidthState = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="contentMaxWidth"]')!;
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        widthOverride: document.documentElement.style.getPropertyValue('--meo-content-max-width')
      };
    });
    if (
      unconstrainedWidthState.active ||
      unconstrainedWidthState.checked !== 'false' ||
      unconstrainedWidthState.widthOverride !== ''
    ) {
      throw new Error(`Disabled constrained width still changed the layout: ${JSON.stringify(unconstrainedWidthState)}`);
    }
    const darkAppearanceState = await page.evaluate(() => ({
      heading: document.documentElement.style.getPropertyValue('--meo-semantic-headingForeground'),
      searchBackground: document.documentElement.style.getPropertyValue('--meo-semantic-searchMatchBackground'),
      sidebar: document.documentElement.style.getPropertyValue('--vscode-sideBar-background')
    }));
    await page.click('.more-tools-wrapper > .format-button');
    await page.click('.editor-appearance-button[data-editor-appearance="light"]');
    await waitForFrames(page, 2);
    const lightAppearanceState = await page.evaluate(() => ({
      appearance: document.documentElement.dataset.editorAppearance,
      background: getComputedStyle(document.body).backgroundColor,
      heading: document.documentElement.style.getPropertyValue('--meo-semantic-headingForeground'),
      lineNumber: getComputedStyle(document.querySelector<HTMLElement>('.cm-lineNumbers')!).color,
      searchBackground: document.documentElement.style.getPropertyValue('--meo-semantic-searchMatchBackground'),
      searchForeground: document.documentElement.style.getPropertyValue('--meo-semantic-searchMatchForeground'),
      activeSearchForeground: document.documentElement.style.getPropertyValue('--meo-semantic-searchMatchActiveForeground'),
      gitColors: {
        added: getComputedStyle(document.documentElement).getPropertyValue('--git-added').trim(),
        changed: getComputedStyle(document.documentElement).getPropertyValue('--git-changed').trim(),
        deleted: getComputedStyle(document.documentElement).getPropertyValue('--git-deleted').trim()
      },
      active: document.querySelector<HTMLElement>('.editor-appearance-button.is-active')?.dataset.editorAppearance,
      labelExists: Boolean(document.querySelector('.more-tools-appearance-label')),
      indicatorInsets: (() => {
        const button = document.querySelector<HTMLElement>('.editor-appearance-button.is-active')!;
        const indicator = button.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
        const buttonBounds = button.getBoundingClientRect();
        const indicatorBounds = indicator.getBoundingClientRect();
        return {
          top: indicatorBounds.top - buttonBounds.top,
          right: buttonBounds.right - indicatorBounds.right,
          bottom: buttonBounds.bottom - indicatorBounds.bottom,
          left: indicatorBounds.left - buttonBounds.left
        };
      })(),
      messages: ((window as typeof window & {
        __hostMessages?: Array<{ type?: string; appearance?: string }>;
      }).__hostMessages ?? [])
        .filter((message) => message.type === 'setEditorAppearance')
        .map((message) => message.appearance)
    }));
    if (
      lightAppearanceState.appearance !== 'light' ||
      lightAppearanceState.background !== 'rgb(255, 255, 255)' ||
      lightAppearanceState.heading !== '#0550ae' ||
      lightAppearanceState.lineNumber !== 'rgb(175, 184, 193)' ||
      lightAppearanceState.searchBackground !== darkAppearanceState.searchBackground ||
      lightAppearanceState.searchForeground !== 'inherit' ||
      lightAppearanceState.activeSearchForeground !== 'inherit' ||
      JSON.stringify(lightAppearanceState.gitColors) !== JSON.stringify({
        added: '#2da44e',
        changed: '#0969da',
        deleted: '#cf222e'
      }) ||
      lightAppearanceState.active !== 'light' ||
      lightAppearanceState.labelExists ||
      Object.values(lightAppearanceState.indicatorInsets).some((inset) => Math.abs(inset - 3) > 0.5) ||
      JSON.stringify(lightAppearanceState.messages) !== JSON.stringify(['light'])
    ) {
      throw new Error(`Editor light appearance did not preserve established accents: ${JSON.stringify({ darkAppearanceState, lightAppearanceState })}`);
    }
    await page.evaluate(() => {
      document.body.className = 'vscode-dark';
      document.documentElement.style.setProperty('--vscode-editor-background', '#010203');
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#040506');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'vscodeCodeThemeChanged',
        appearance: 'dark',
        vscodeTheme: { name: 'Host Dark', type: 'dark', colors: {}, tokenColors: [] }
      }}));
    });
    await waitForFrames(page, 2);
    const lightAfterHostThemeChange = await page.evaluate(() => ({
      appearance: document.documentElement.dataset.editorAppearance,
      background: getComputedStyle(document.body).backgroundColor,
      sidebar: document.documentElement.style.getPropertyValue('--vscode-sideBar-background'),
      heading: document.documentElement.style.getPropertyValue('--meo-semantic-headingForeground')
    }));
    if (JSON.stringify(lightAfterHostThemeChange) !== JSON.stringify({
      appearance: 'light',
      background: 'rgb(255, 255, 255)',
      sidebar: '#f6f8fa',
      heading: '#0550ae'
    })) {
      throw new Error(`VS Code host theme changed the manual light appearance: ${JSON.stringify(lightAfterHostThemeChange)}`);
    }
    await page.click('.changes-review-trigger');
    const todaySnapshotTimestamp = await page.evaluate(() => {
      const date = new Date();
      date.setHours(7, 5, 0, 0);
      return date.getTime();
    });
    await page.evaluate((updatedAt) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: true, active: true, updatedAt
      }}));
    }, todaySnapshotTimestamp);
    const activeSnapshot = await page.$eval('.changes-review-snapshot-row', (row) => {
      const select = row.querySelector<HTMLElement>('.changes-review-snapshot-select')!;
      const action = row.querySelector<HTMLElement>('.changes-review-snapshot-action')!;
      const previous = row.previousElementSibling as HTMLElement | null;
      const selectRect = select.getBoundingClientRect();
      const actionRect = action.getBoundingClientRect();
      const checkRect = select.querySelector<HTMLElement>('.changes-review-check')!.getBoundingClientRect();
      return {
      selected: select.classList.contains('is-selected'),
      actionSelected: action.classList.contains('is-selected'),
      rowSelected: row.classList.contains('is-selected'),
      label: row.querySelector('.changes-review-option-label')?.textContent,
      action: action.textContent,
      actionIconCount: action.querySelectorAll('svg').length,
      actionAriaLabel: action.getAttribute('aria-label'),
      actionTitle: action.title,
      actionBackground: getComputedStyle(action).backgroundColor,
      selectHeight: selectRect.height,
      actionHeight: actionRect.height,
      actionGap: actionRect.left - selectRect.right,
      checkRightInset: selectRect.right - checkRect.right,
      matchingSelectedBackground: getComputedStyle(select).backgroundColor === getComputedStyle(action).backgroundColor,
      previousGap: previous ? selectRect.top - previous.getBoundingClientRect().bottom : null,
      selectAction: select.dataset.action,
      clipped: Array.from(row.querySelectorAll<HTMLElement>('.changes-review-option-label, .changes-review-snapshot-action'))
        .some((element) => element.scrollWidth > element.clientWidth)
    };
    });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: true, active: false, updatedAt: 2_000
      }}));
    });
    const standbySnapshot = await page.$eval('.changes-review-snapshot-row', (row) => ({
      selected: row.querySelector('.changes-review-snapshot-select')?.classList.contains('is-selected'),
      actionSelected: row.querySelector('.changes-review-snapshot-action')?.classList.contains('is-selected'),
      rowSelected: row.classList.contains('is-selected'),
      action: row.querySelector('.changes-review-snapshot-action')?.textContent,
      actionBackground: getComputedStyle(row.querySelector<HTMLElement>('.changes-review-snapshot-action')!).backgroundColor
    }));
    await page.hover('.changes-review-snapshot-action');
    const hoveredSnapshotActionBackground = await page.$eval(
      '.changes-review-snapshot-action',
      (action) => getComputedStyle(action).backgroundColor
    );
    await page.mouse.down();
    const pressedSnapshotActionBackground = await page.$eval(
      '.changes-review-snapshot-action',
      (action) => getComputedStyle(action).backgroundColor
    );
    await page.mouse.move(0, 0);
    await page.mouse.up();
    if (
      !activeSnapshot.selected ||
      activeSnapshot.actionSelected ||
      activeSnapshot.rowSelected ||
      activeSnapshot.label !== '与手动快照比较（07:05）' ||
      activeSnapshot.action !== '更新' ||
      activeSnapshot.actionIconCount !== 0 ||
      activeSnapshot.actionAriaLabel !== '更新手动快照' ||
      activeSnapshot.actionTitle !== '更新手动快照' ||
      activeSnapshot.selectHeight !== 28 ||
      activeSnapshot.actionHeight !== 28 ||
      activeSnapshot.actionGap !== 2 ||
      activeSnapshot.checkRightInset !== 6 ||
      activeSnapshot.actionBackground !== 'rgba(0, 0, 0, 0)' ||
      activeSnapshot.matchingSelectedBackground ||
      hoveredSnapshotActionBackground === 'rgba(0, 0, 0, 0)' ||
      pressedSnapshotActionBackground === 'rgba(0, 0, 0, 0)' ||
      activeSnapshot.previousGap !== 2 ||
      activeSnapshot.selectAction !== 'select-snapshot' ||
      activeSnapshot.clipped ||
      standbySnapshot.selected ||
      standbySnapshot.actionSelected ||
      standbySnapshot.rowSelected ||
      standbySnapshot.action !== '更新' ||
      standbySnapshot.actionBackground !== 'rgba(0, 0, 0, 0)'
    ) {
      throw new Error(`Manual snapshot states were not readable: ${JSON.stringify({ activeSnapshot, standbySnapshot })}`);
    }
    const snapshotStates = await page.evaluate(() => {
      const read = () => {
        const panel = document.querySelector<HTMLElement>('.changes-review-panel')!;
        const row = panel.querySelector<HTMLElement>('.changes-review-snapshot-row')!;
        const label = row.querySelector<HTMLElement>('.changes-review-option-label')!;
        const action = row.querySelector<HTMLButtonElement>('.changes-review-snapshot-action');
        const hint = row.querySelector<HTMLElement>('.changes-review-snapshot-create-hint');
        const select = row.querySelector<HTMLElement>('.changes-review-snapshot-select')!;
        const header = panel.querySelector<HTMLElement>('.changes-review-header')!;
        const headerBaseline = panel.querySelector<HTMLElement>('.changes-review-header-baseline')!;
        const overflow = {
          label: label.scrollWidth > label.clientWidth,
          action: action ? action.scrollWidth > action.clientWidth : false,
          row: row.scrollWidth > row.clientWidth,
          header: header.scrollWidth > header.clientWidth,
          headerBaseline: headerBaseline.scrollWidth > headerBaseline.clientWidth,
          panel: panel.scrollWidth > panel.clientWidth
        };
        return {
          label: label.textContent ?? '',
          hint: hint?.textContent ?? null,
          hintColor: hint ? getComputedStyle(hint).color : null,
          selectColor: getComputedStyle(select).color,
          action: action?.textContent ?? null,
          actionIconCount: action?.querySelectorAll('svg').length ?? 0,
          actionAriaLabel: action?.getAttribute('aria-label') ?? null,
          selectAction: row.querySelector<HTMLElement>('.changes-review-snapshot-select')!.dataset.action,
          selectAriaLabel: row.querySelector<HTMLElement>('.changes-review-snapshot-select')!.getAttribute('aria-label'),
          selectDisabled: row.querySelector<HTMLButtonElement>('.changes-review-snapshot-select')!.disabled,
          labelWidth: { client: label.clientWidth, scroll: label.scrollWidth },
          actionWidth: action ? { client: action.clientWidth, scroll: action.scrollWidth } : null,
          overflow,
          clipped: Object.values(overflow).some(Boolean)
        };
      };
      const updateSnapshot = (date: Date) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'fixedBaselineChanged', pinned: true, active: true, updatedAt: date.getTime()
        }}));
        return read();
      };
      const run = (language: 'zh-CN' | 'en') => {
        document.querySelector<HTMLButtonElement>(`[data-ui-language="${language}"]`)!.click();
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'fixedBaselineChanged', pinned: false, active: false
        }}));
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'fixedBaselineChanged', pinned: true, active: true
        }}));
        const noTimestamp = read();
        const today = new Date();
        today.setHours(7, 5, 0, 0);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(23, 4, 0, 0);
        const older = new Date();
        older.setDate(older.getDate() - 2);
        older.setHours(18, 37, 0, 0);
        const previousYear = new Date();
        previousYear.setFullYear(previousYear.getFullYear() - 1, 6, 9);
        previousYear.setHours(12, 34, 0, 0);
        return {
          noTimestamp,
          today: updateSnapshot(today),
          yesterday: updateSnapshot(yesterday),
          older: updateSnapshot(older),
          previousYear: updateSnapshot(previousYear)
        };
      };
      const chinese = run('zh-CN');
      const english = run('en');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: false, active: false
      }}));
      const englishNone = read();
      document.querySelector<HTMLButtonElement>('[data-ui-language="zh-CN"]')!.click();
      const chineseNone = read();
      return {
        chinese: { ...chinese, none: chineseNone },
        english: { ...english, none: englishNone }
      };
    });
    if (
      snapshotStates.chinese.today.label !== '与手动快照比较（07:05）' ||
      snapshotStates.chinese.noTimestamp.label !== '与手动快照比较' ||
      snapshotStates.chinese.yesterday.label !== '与手动快照比较（昨天）' ||
      snapshotStates.english.today.label !== 'Manual Snapshot' ||
      snapshotStates.english.noTimestamp.label !== 'Manual Snapshot' ||
      snapshotStates.english.yesterday.label !== 'Manual Snapshot' ||
      snapshotStates.chinese.older.label !== '与手动快照比较（较早）' ||
      snapshotStates.english.older.label !== 'Manual Snapshot' ||
      snapshotStates.chinese.previousYear.label !== '与手动快照比较（较早）' ||
      snapshotStates.english.previousYear.label !== 'Manual Snapshot' ||
      snapshotStates.chinese.none.label !== '与手动快照比较' ||
      snapshotStates.chinese.none.hint !== '点击创建' ||
      snapshotStates.chinese.none.hintColor !== snapshotStates.chinese.none.selectColor ||
      snapshotStates.chinese.none.action !== null ||
      snapshotStates.chinese.none.actionIconCount !== 0 ||
      snapshotStates.chinese.none.actionAriaLabel !== null ||
      snapshotStates.chinese.none.selectAction !== 'create-snapshot' ||
      snapshotStates.chinese.none.selectAriaLabel !== '创建手动快照' ||
      snapshotStates.chinese.none.selectDisabled ||
      snapshotStates.english.none.label !== 'Manual Snapshot' ||
      snapshotStates.english.none.hint !== 'Click to Create' ||
      snapshotStates.english.none.hintColor !== snapshotStates.english.none.selectColor ||
      snapshotStates.english.none.action !== null ||
      snapshotStates.english.none.actionIconCount !== 0 ||
      snapshotStates.english.none.actionAriaLabel !== null ||
      snapshotStates.english.none.selectAction !== 'create-snapshot' ||
      snapshotStates.english.none.selectAriaLabel !== 'Create Manual Snapshot' ||
      snapshotStates.english.none.selectDisabled ||
      Object.values(snapshotStates).some((languageStates) =>
        Object.values(languageStates).some((entry) => entry.clipped)
      )
    ) {
      throw new Error(`Manual snapshot states were not compact: ${JSON.stringify(snapshotStates)}`);
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: false, active: false
      }}));
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      const input = document.querySelector<HTMLInputElement>('.find-input')!;
      input.value = 'stable';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('.meo-search-match');
    const lightSearchColors = await page.$eval('.meo-search-match', (match) => ({
      match: getComputedStyle(match).color,
      line: getComputedStyle(match.closest('.cm-line')!).color
    }));
    if (lightSearchColors.match !== lightSearchColors.line) {
      throw new Error(`Light search changed the matched text color: ${JSON.stringify(lightSearchColors)}`);
    }
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.find-input')!;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
    });
    await page.click('.more-tools-wrapper > button');
    await page.click('.editor-appearance-button[data-editor-appearance="dark"]');
    await waitForFrames(page, 2);
    const restoredDarkAppearanceState = await page.evaluate(() => ({
      appearance: document.documentElement.dataset.editorAppearance,
      sidebar: document.documentElement.style.getPropertyValue('--vscode-sideBar-background'),
      active: document.querySelector<HTMLElement>('.editor-appearance-button.is-active')?.dataset.editorAppearance,
      messages: ((window as typeof window & {
        __hostMessages?: Array<{ type?: string; appearance?: string }>;
      }).__hostMessages ?? [])
        .filter((message) => message.type === 'setEditorAppearance')
        .map((message) => message.appearance)
    }));
    if (
      restoredDarkAppearanceState.appearance !== 'dark' ||
      restoredDarkAppearanceState.sidebar !== darkAppearanceState.sidebar ||
      restoredDarkAppearanceState.active !== 'dark' ||
      JSON.stringify(restoredDarkAppearanceState.messages) !== JSON.stringify(['light', 'dark'])
    ) {
      throw new Error(`Editor dark appearance was not restored exactly: ${JSON.stringify({ darkAppearanceState, restoredDarkAppearanceState })}`);
    }
    await page.evaluate(() => {
      document.body.className = 'vscode-light';
      document.documentElement.style.setProperty('--vscode-editor-background', '#fafafa');
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#f0f0f0');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'vscodeCodeThemeChanged',
        appearance: 'light',
        vscodeTheme: { name: 'Host Light', type: 'light', colors: {}, tokenColors: [] }
      }}));
    });
    await waitForFrames(page, 2);
    const darkAfterHostThemeChange = await page.evaluate(() => ({
      appearance: document.documentElement.dataset.editorAppearance,
      background: getComputedStyle(document.body).backgroundColor,
      sidebar: document.documentElement.style.getPropertyValue('--vscode-sideBar-background')
    }));
    if (JSON.stringify(darkAfterHostThemeChange) !== JSON.stringify({
      appearance: 'dark',
      background: 'rgb(36, 41, 46)',
      sidebar: '#1f2428'
    })) {
      throw new Error(`VS Code host theme changed the manual dark appearance: ${JSON.stringify(darkAfterHostThemeChange)}`);
    }
    const toolbarBaselineText = initialText.replace(
      'stable line 40',
      `${Array.from({ length: 18 }, (_, index) => `removed baseline line ${index + 1}`).join('\n')}\nstable line 40`
    );
    await page.evaluate((baseText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'gitBaselineChanged',
        version: 1,
        payload: {
          available: true,
          tracked: true,
          mode: 'current-edit',
          generation: 1,
          baseText
        }
      }}));
    }, toolbarBaselineText);
    await waitForFrames(page, 8);
    await page.click('[data-mode="source"]');
    await page.evaluate((selection) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
    }, initialText.indexOf('stable line 40'));
    await waitForFrames(page, 4);
    const changesMenuExpanded = await page.$eval(
      '.changes-review-trigger',
      (button) => button.getAttribute('aria-expanded') === 'true'
    );
    if (!changesMenuExpanded) await page.click('.changes-review-trigger');
    await page.click('[data-toggle="before-content"]');
    await waitForFrames(page, 4);
    const sourceDiffDetails = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-diff-original-line'));
      const numbers = Array.from(document.querySelectorAll<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-original-line-number'
      ));
      const firstContent = rows[0]?.querySelector<HTMLElement>('.meo-git-diff-original-content');
      const currentContent = document.querySelector<HTMLElement>('.editor-host .cm-content');
      const reviewCounts = Array.from(document.querySelectorAll<HTMLElement>('.changes-review-count'));
      const reviewCountSigns = Array.from(document.querySelectorAll<HTMLElement>('.changes-review-count-sign'));
      return {
        rowCount: rows.length,
        numberCount: numbers.length,
        firstNumber: numbers[0]?.textContent,
        firstContent: firstContent?.textContent,
        oldContentEditable: rows[0]?.getAttribute('contenteditable'),
        oldContentUserSelect: firstContent ? getComputedStyle(firstContent).userSelect : null,
        currentContentEditable: currentContent?.getAttribute('contenteditable'),
        reviewCountStyles: reviewCounts.map((count) => ({
          fontSize: getComputedStyle(count).fontSize,
          fontWeight: getComputedStyle(count).fontWeight,
          inHeader: Boolean(count.closest('.changes-review-header'))
        })),
        reviewCountSignTransforms: reviewCountSigns.map((sign) => getComputedStyle(sign).transform)
      };
    });
    if (
      sourceDiffDetails.rowCount === 0 ||
      sourceDiffDetails.numberCount !== sourceDiffDetails.rowCount ||
      sourceDiffDetails.firstNumber !== '40' ||
      sourceDiffDetails.firstContent !== 'removed baseline line 1' ||
      sourceDiffDetails.oldContentEditable !== 'false' ||
      sourceDiffDetails.oldContentUserSelect !== 'none' ||
      sourceDiffDetails.currentContentEditable !== 'true' ||
      sourceDiffDetails.reviewCountStyles.length < 2 ||
      sourceDiffDetails.reviewCountStyles.some(({ fontSize, fontWeight, inHeader }) =>
        fontSize !== (inHeader ? '12px' : '13px') || fontWeight !== '600'
      ) ||
      sourceDiffDetails.reviewCountSignTransforms.length < 2 ||
      sourceDiffDetails.reviewCountSignTransforms.some((transform) => transform === 'none')
    ) {
      throw new Error(`Source diff detail rendering regressed: ${JSON.stringify(sourceDiffDetails)}`);
    }
    await page.click('[data-toggle="before-content"]');
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 4);
    const toolbarDocumentActions = [
      { name: 'save', selector: '[data-action="save"]' },
      { name: 'reload', selector: '[data-action="discard"]' },
      { name: 'changes', selector: '.changes-review-trigger' },
      { name: 'settings', selector: '[data-action="settings"]' }
    ];
    const toolbarDocumentActionTraces: Array<{
      name: string;
      before: { scrollTop: number; anchorText: string; anchorTop: number };
      samples: Array<{ scrollTop: number; anchorTop: number | null }>;
      editorOwnsFocus: boolean;
    }> = [];
    for (const action of toolbarDocumentActions) {
      await page.$eval<HTMLElement>('.editor-host .cm-content', (content) => {
        content.focus({ preventScroll: true });
      });
      await page.$eval<HTMLElement>('.editor-host > .cm-editor .cm-scroller', (scroller) => {
        scroller.scrollTop = Math.min(1400, scroller.scrollHeight - scroller.clientHeight);
      });
      await waitForFrames(page, 2);
      const before = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
        const scrollerTop = scroller.getBoundingClientRect().top;
        const anchor = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
          .find((line) => {
            const rect = line.getBoundingClientRect();
            return rect.top >= scrollerTop && rect.bottom <= scroller.getBoundingClientRect().bottom
              && line.textContent?.startsWith('stable line ');
          });
        if (!anchor?.textContent) throw new Error('Missing visible toolbar viewport anchor');
        return {
          scrollTop: scroller.scrollTop,
          anchorText: anchor.textContent,
          anchorTop: anchor.getBoundingClientRect().top
        };
      });
      await page.evaluate((anchorText) => {
        const targetWindow = window as typeof window & {
          __toolbarActionScrollTrace?: Array<{ scrollTop: number; anchorTop: number | null }>;
        };
        const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
        const readAnchorTop = () => {
          const anchor = Array.from(document.querySelectorAll<HTMLElement>('.editor-host .cm-line'))
            .find((line) => line.textContent === anchorText);
          return anchor?.getBoundingClientRect().top ?? null;
        };
        targetWindow.__toolbarActionScrollTrace = [{
          scrollTop: scroller.scrollTop,
          anchorTop: readAnchorTop()
        }];
        let remainingFrames = 16;
        const sample = () => {
          targetWindow.__toolbarActionScrollTrace!.push({
            scrollTop: scroller.scrollTop,
            anchorTop: readAnchorTop()
          });
          remainingFrames -= 1;
          if (remainingFrames > 0) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, before.anchorText);
      await page.click(action.selector);
      await waitForFrames(page, 18);
      const samples = await page.evaluate(() => (
        (window as typeof window & {
          __toolbarActionScrollTrace?: Array<{ scrollTop: number; anchorTop: number | null }>;
        }).__toolbarActionScrollTrace ?? []
      ));
      const editorOwnsFocus = await page.evaluate(() => (
        Boolean(document.activeElement && document.querySelector('.editor-host')?.contains(document.activeElement))
      ));
      toolbarDocumentActionTraces.push({ name: action.name, before, samples, editorOwnsFocus });
      if (action.name === 'settings') await page.keyboard.press('Escape');
    }
    const movedToolbarDocumentAction = toolbarDocumentActionTraces.find((trace) => (
      !trace.editorOwnsFocus ||
      trace.samples.some((sample) => (
        sample.anchorTop === null || Math.abs(sample.anchorTop - trace.before.anchorTop) > 1
      ))
    ));
    if (movedToolbarDocumentAction) {
      throw new Error(`Toolbar document action moved the Live viewport: ${JSON.stringify(toolbarDocumentActionTraces)}`);
    }
    const embeddedToolbarScrollBefore = await page.evaluate(() => {
      const editorDom = document.querySelector<HTMLElement>('.editor-host > .cm-editor')!;
      const nestedInput = document.createElement('textarea');
      nestedInput.dataset.testNestedEditorFocus = 'true';
      nestedInput.style.position = 'absolute';
      nestedInput.style.width = '1px';
      nestedInput.style.height = '1px';
      nestedInput.style.opacity = '0';
      editorDom.appendChild(nestedInput);
      nestedInput.focus({ preventScroll: true });
      return editorDom.querySelector<HTMLElement>('.cm-scroller')!.scrollTop;
    });
    await page.click('[data-action="settings"]');
    await waitForFrames(page, 4);
    const embeddedToolbarFocus = await page.evaluate((before) => {
      const nestedInput = document.querySelector<HTMLTextAreaElement>('[data-test-nested-editor-focus]')!;
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const result = {
        focused: document.activeElement === nestedInput,
        scrollDelta: scroller.scrollTop - before
      };
      nestedInput.remove();
      return result;
    }, embeddedToolbarScrollBefore);
    await page.keyboard.press('Escape');
    if (!embeddedToolbarFocus.focused || Math.abs(embeddedToolbarFocus.scrollDelta) > 1) {
      throw new Error(`Toolbar did not retain embedded editor focus: ${JSON.stringify(embeddedToolbarFocus)}`);
    }
    await waitForFrames(page, 2);
    const saveMessages = await page.evaluate(() => (
      (window as typeof window & {
        __hostMessages?: Array<{ type?: string; requestId?: string; revision?: { version?: number; text?: string } }>;
      }).__hostMessages ?? []
    ).filter((message) => message.type === 'saveDocumentRevision'));
    if (
      saveMessages.length !== 1
      || typeof saveMessages[0]?.requestId !== 'string'
      || saveMessages[0]?.revision?.version !== 1
      || typeof saveMessages[0]?.revision?.text !== 'string'
    ) {
      throw new Error(`Toolbar save did not request an exact Revision save: ${JSON.stringify(saveMessages)}`);
    }
    for (const mode of ['source', 'live'] as const) {
      await page.click(`[data-mode="${mode}"]`);
      await waitForFrames(page, 2);
      const persistedMode = await page.evaluate(() => (
        (window as typeof window & { __webviewState?: { mode?: string } }).__webviewState?.mode
      ));
      if (persistedMode !== mode) {
        throw new Error(`Webview did not persist ${mode} mode: ${persistedMode}`);
      }
      const headingFoldControls = await page.evaluate(() => ({
        gutterCount: document.querySelectorAll('.meo-md-fold-gutter').length,
        toggleCount: document.querySelectorAll('.meo-md-fold-toggle').length
      }));
      if (headingFoldControls.gutterCount !== 0 || headingFoldControls.toggleCount !== 0) {
        throw new Error(`${mode} exposed custom heading folding: ${JSON.stringify(headingFoldControls)}`);
      }
    }
    const editorScrollTopBeforePreview = await page.$eval<HTMLElement, number>(
      '.editor-host > .cm-editor .cm-scroller',
      (element) => element.scrollTop
    );
    await page.click('[data-mode="preview"]');
    const persistedPreviewMode = await page.evaluate(() => (
      (window as typeof window & { __webviewState?: { mode?: string } }).__webviewState?.mode
    ));
    if (persistedPreviewMode !== 'preview') {
      throw new Error(`Webview did not persist preview mode: ${persistedPreviewMode}`);
    }
    const previewHeadingFoldControls = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      return {
        mainGutterCount: document.querySelectorAll('.meo-md-fold-gutter').length,
        mainToggleCount: document.querySelectorAll('.meo-md-fold-toggle').length,
        frameToggleCount: frameDocument?.querySelectorAll('.meo-md-fold-toggle, [data-heading-fold]').length ?? 0
      };
    });
    if (Object.values(previewHeadingFoldControls).some((count) => count !== 0)) {
      throw new Error(`Preview exposed custom heading folding: ${JSON.stringify(previewHeadingFoldControls)}`);
    }
    const previewToolbarLayout = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>('.preview-format-group')!;
      const selects = Array.from(group.querySelectorAll<HTMLButtonElement>('.preview-toolbar-dropdown'));
      const settingsButton = document.querySelector<HTMLButtonElement>('[data-action="settings"]')!;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        toolbarHeight: document.querySelector<HTMLElement>('.mode-toolbar')!.getBoundingClientRect().height,
        selectCount: selects.length,
        selectHeights: selects.map((select) => select.getBoundingClientRect().height),
        selectRadii: selects.map((select) => Number.parseFloat(getComputedStyle(select).borderRadius)),
        labels: Array.from(group.querySelectorAll('.preview-select-label')).map((label) => label.textContent?.trim()),
        appearance: group.querySelector<HTMLSelectElement>('.preview-appearance-select')?.value,
        colorSchemes: selects.map((select) => getComputedStyle(select.closest<HTMLElement>('.preview-select-control')!).colorScheme),
        oldAppearanceButtons: group.querySelectorAll('.preview-appearance-button').length,
        oldColorButtons: group.querySelectorAll('button.preview-source-coloring').length,
        visible: getComputedStyle(group).display !== 'none',
        moreExports: document.querySelectorAll('.more-tools-panel [data-format]').length,
        floatingThemeToggle: Boolean(document.querySelector('.preview-host .preview-theme-toggle')),
        settingsVisible: getComputedStyle(settingsButton).display !== 'none',
        settingsTitle: settingsButton.title,
        settingsAfterOutline: settingsButton.closest('.more-tools-wrapper')?.previousElementSibling
          === document.querySelector('[data-action="outline-right"]'),
        settingsIcon: Boolean(
          settingsButton.querySelector('svg path[d^="M9.671 4.136"]')
          && settingsButton.querySelector('svg circle[cx="12"][cy="12"][r="3"]')
        )
      };
    });
    if (
      !previewToolbarLayout.visible ||
      Math.abs(previewToolbarLayout.toolbarHeight - initialToolbarStart.toolbarHeight) > 0.5 ||
      previewToolbarLayout.selectCount !== 3 ||
      previewToolbarLayout.selectHeights.some((height) => height !== 26) ||
      previewToolbarLayout.selectRadii.some((radius) => radius !== 8) ||
      JSON.stringify(previewToolbarLayout.labels) !== JSON.stringify(['预览字体', '代码着色', '预览外观']) ||
      previewToolbarLayout.appearance !== 'light' ||
      previewToolbarLayout.colorSchemes.some((scheme) => scheme !== 'dark') ||
      previewToolbarLayout.oldAppearanceButtons !== 0 ||
      previewToolbarLayout.oldColorButtons !== 0 ||
      previewToolbarLayout.moreExports !== 0 ||
      previewToolbarLayout.floatingThemeToggle ||
      !previewToolbarLayout.settingsVisible ||
      previewToolbarLayout.settingsTitle !== '设置' ||
      !previewToolbarLayout.settingsAfterOutline ||
      !previewToolbarLayout.settingsIcon
    ) {
      throw new Error(`Unexpected Preview toolbar: ${JSON.stringify({ initialToolbarStart, previewToolbarLayout })}`);
    }
    await page.select('.preview-appearance-select', 'dark');
    await page.evaluate(() => {
      const testWindow = window as typeof window & { __hostMessages?: Array<{ type?: string }> };
      testWindow.__hostMessages = (testWindow.__hostMessages ?? []).filter(
        (message) => (
          message.type !== 'setPreviewAppearance' &&
          message.type !== 'setPreviewSourceColoring' &&
          message.type !== 'exportDocument'
        )
      );
    });
    const previewToolbarReachability = await page.evaluate(() => {
      const describe = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const hit = document.elementFromPoint(center.x, center.y);
        return {
          connected: element.isConnected,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
          pointerEvents: style.pointerEvents,
          hit: Boolean(hit && element.contains(hit)),
          center
        };
      };
      return {
        font: describe(document.querySelector<HTMLButtonElement>('.preview-font-family-dropdown')!),
        sourceColoring: describe(document.querySelector<HTMLButtonElement>('.preview-source-coloring-dropdown')!),
        html: describe(document.querySelector<HTMLButtonElement>('.preview-toolbar-action[data-format="html"]')!),
        pdf: describe(document.querySelector<HTMLButtonElement>('.preview-toolbar-action[data-format="pdf"]')!)
      };
    });
    await page.mouse.click(previewToolbarReachability.font.center.x, previewToolbarReachability.font.center.y);
    const previewFontFocused = await page.evaluate(() => (
      document.activeElement === document.querySelector('.preview-font-family-dropdown')
    ));
    await page.select('.preview-source-coloring-select', 'false');
    const sourceColoringAfterPointer = await page.evaluate(() => ({
      value: document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')?.value,
      commands: (
        (window as typeof window & {
          __hostMessages?: Array<{ type?: string; enabled?: boolean }>;
        }).__hostMessages ?? []
      ).filter((message) => message.type === 'setPreviewSourceColoring')
        .map((message) => ({ enabled: message.enabled }))
    }));
    await page.select('.preview-source-coloring-select', 'true');
    const sourceColoringAfterKeyboard = await page.evaluate(() => ({
      value: document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')?.value,
      commands: (
        (window as typeof window & {
          __hostMessages?: Array<{ type?: string; enabled?: boolean }>;
        }).__hostMessages ?? []
      ).filter((message) => message.type === 'setPreviewSourceColoring')
        .map((message) => ({ enabled: message.enabled }))
    }));
    await page.mouse.click(previewToolbarReachability.html.center.x, previewToolbarReachability.html.center.y);
    await page.mouse.click(previewToolbarReachability.pdf.center.x, previewToolbarReachability.pdf.center.y);
    const previewExportRequests = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; format?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportDocument').map((message) => ({ format: message.format })));
    const toolbarTargets = Object.values(previewToolbarReachability);
    if (
      toolbarTargets.some((target) => (
        !target.connected || !target.visible || target.pointerEvents === 'none' || !target.hit
      )) ||
      !previewFontFocused ||
      sourceColoringAfterPointer.value !== 'false' ||
      JSON.stringify(sourceColoringAfterPointer.commands) !== JSON.stringify([{ enabled: false }]) ||
      sourceColoringAfterKeyboard.value !== 'true' ||
      JSON.stringify(sourceColoringAfterKeyboard.commands) !== JSON.stringify([
        { enabled: false },
        { enabled: true }
      ]) ||
      JSON.stringify(previewExportRequests) !== JSON.stringify([{ format: 'html' }, { format: 'pdf' }])
    ) {
      throw new Error(`Preview toolbar commands are not pointer reachable at 900px: ${JSON.stringify({
        previewToolbarReachability,
        previewFontFocused,
        sourceColoringAfterPointer,
        sourceColoringAfterKeyboard,
        previewExportRequests
      })}`);
    }
    let previewRequestId = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> }).__hostMessages ?? [];
      return messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    });
    if (!previewRequestId) {
      throw new Error('Preview mode did not request rendered Markdown');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderResult', requestId,
        result: { ok: false, error: { code: 'operation-failed', message: 'Preview test error' } }
      }}));
    }, previewRequestId);
    const previewError = await page.$eval('.preview-status', (element) => element.textContent);
    if (previewError !== '预览生成失败') {
      throw new Error(`Preview render error was not shown: ${previewError}`);
    }
    const stalePreviewRequestId = previewRequestId;
    await page.click('[data-mode="live"]');
    await page.$eval<HTMLElement, number>('.editor-host > .cm-editor .cm-scroller', (element, scrollTop) => {
      element.scrollTop = scrollTop;
    }, editorScrollTopBeforePreview);
    await waitForFrames(page, 2);
    await page.click('[data-mode="preview"]');
    previewRequestId = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; requestId?: string }> }).__hostMessages ?? [];
      return messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    });
    if (!previewRequestId || previewRequestId === stalePreviewRequestId) {
      throw new Error('Re-entering Preview did not create a new render request');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderResult', requestId, result: { ok: true, value: {
        html: '<h1 id="stale">Stale</h1>', hasMermaid: false,
        styles: { dark: 'body{background:red}', light: 'body{background:red}' } } }
      }}));
    }, stalePreviewRequestId);
    await waitForFrames(page, 2);
    const stalePreviewApplied = await page.evaluate(() => (
      Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('#stale'))
    ));
    if (stalePreviewApplied) {
      throw new Error('A stale Preview response replaced the current request');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderResult',
        requestId,
        result: { ok: true, value: {
          html: '<h1 id="intro" data-source-line="1">Intro</h1><div id="preview-wide-math" class="meo-export-math meo-export-math-display meo-export-math-fenced-display" data-source-line="3" data-source-end-line="5"><span class="katex-display"><span class="katex" style="display:inline-block;white-space:nowrap;font-family:serif;font-size:1.21em">WIDE_FORMULA_ALPHA_BETA_GAMMA_DELTA_EPSILON_ZETA_ETA_THETA_IOTA_KAPPA_LAMBDA_MU_NU_XI_OMICRON_PI_RHO_SIGMA_TAU</span></span></div><p>Footnote reference <a id="fnref-1" href="#fn-1">1</a></p><pre id="collapsed-long-code" data-source-line="15" data-source-end-line="36" style="height:440px">Long code block</pre><pre id="short-code" data-source-line="45" data-source-end-line="56" style="height:240px">Short code block</pre><div style="height:600px"></div><h2 id="short-mermaid" data-source-line="78">Short Mermaid</h2><div style="height:900px"></div><pre id="anchor-133" data-source-line="133" data-source-end-line="222" style="height:900px">Code block</pre><div style="height:600px"></div><h2 id="tall-mermaid" data-source-line="231">Tall Mermaid</h2><div style="height:900px"></div><div class="meo-export-mermaid" data-source-b64="Zmxvd2NoYXJ0IExSClN0YXJ0IC0tPiBEb25l" style="display:none"></div><ol><li id="fn-1">Footnote content <a href="#fnref-1">Back</a></li></ol>',
          hasMermaid: true,
          styles: {
          dark: 'html,body{margin:0;background:#20252b;color:#fff}.meo-export-doc{padding:20px}',
          light: 'html,body{margin:0;background:#fff;color:#1f2328}.meo-export-doc{padding:20px}'
          }
        } }
      }}));
    }, previewRequestId);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.querySelector('#tall-mermaid');
    });
    await page.waitForFunction(() => Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('.meo-export-mermaid.is-rendered [data-mermaid-node]')
    ));
    const darkPreviewMermaidFill = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<SVGElement>('[data-mermaid-node]')!.getAttribute('fill')
    ));
    if (!darkPreviewMermaidFill || darkPreviewMermaidFill === '#ffffff') {
      throw new Error(`Dark Preview Mermaid used a light node fill: ${darkPreviewMermaidFill}`);
    }
    const previewPdfNode = await page.$('.preview-toolbar-action[data-format="pdf"]');
    if (!previewPdfNode) throw new Error('Preview PDF action is missing before toolbar migration');
    await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await waitForFrames(page, 4);
    const narrowPreviewToolbar = await page.evaluate((pdfNode) => {
      const moreButton = document.querySelector<HTMLButtonElement>('.more-tools-wrapper > .format-button')!;
      const moreBounds = moreButton.getBoundingClientRect();
      const moreCenter = { x: moreBounds.left + moreBounds.width / 2, y: moreBounds.top + moreBounds.height / 2 };
      const moreHit = document.elementFromPoint(moreCenter.x, moreCenter.y);
      return {
        overflowIndicatorVisible: !document.querySelector<HTMLElement>('.toolbar-overflow-indicator')!.hidden,
        migratedCount: document.querySelectorAll('.toolbar-overflow-panel > .is-toolbar-overflow-item').length,
        pdfMigrated: pdfNode.parentElement?.classList.contains('toolbar-overflow-panel') === true,
        moreVisible: getComputedStyle(moreButton).display !== 'none',
        moreHit: Boolean(moreHit && moreButton.contains(moreHit)),
        moreCenter,
        toolbarHeight: document.querySelector<HTMLElement>('.mode-toolbar')!.getBoundingClientRect().height,
        pageFitsViewport: document.documentElement.scrollWidth <= window.innerWidth
      };
    }, previewPdfNode);
    if (
      !narrowPreviewToolbar.overflowIndicatorVisible ||
      narrowPreviewToolbar.migratedCount === 0 ||
      !narrowPreviewToolbar.pdfMigrated ||
      !narrowPreviewToolbar.moreVisible ||
      !narrowPreviewToolbar.moreHit ||
      narrowPreviewToolbar.toolbarHeight !== 40 ||
      !narrowPreviewToolbar.pageFitsViewport
    ) {
      throw new Error(`Narrow Preview toolbar overflow regressed: ${JSON.stringify(narrowPreviewToolbar)}`);
    }
    await page.click('.toolbar-overflow-indicator');
    const migratedPdfTarget = await page.evaluate((pdfNode) => {
      const bounds = pdfNode.getBoundingClientRect();
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      return {
        panelOpen: !document.querySelector<HTMLElement>('.toolbar-overflow-panel')!.hidden,
        hit: Boolean(hit && pdfNode.contains(hit)),
        center
      };
    }, previewPdfNode);
    if (!migratedPdfTarget.panelOpen || !migratedPdfTarget.hit) {
      throw new Error(`Migrated Preview PDF action is not reachable: ${JSON.stringify(migratedPdfTarget)}`);
    }
    await page.mouse.click(migratedPdfTarget.center.x, migratedPdfTarget.center.y);
    const narrowExportRequests = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; format?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportDocument').map((message) => ({ format: message.format })));
    if (JSON.stringify(narrowExportRequests) !== JSON.stringify([
      { format: 'html' },
      { format: 'pdf' },
      { format: 'pdf' }
    ])) {
      throw new Error(`Migrated Preview PDF action lost its command identity: ${JSON.stringify(narrowExportRequests)}`);
    }
    const previewMathFit = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const viewport = frameDocument.querySelector<HTMLElement>('#preview-wide-math')!;
      const canvas = viewport.querySelector<HTMLElement>('.meo-latex-math-canvas')!;
      const viewportRect = viewport.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const fontScale = Number.parseFloat(canvas.style.fontSize) || 1;
      const residualScale = Number.parseFloat(canvas.style.zoom) || 1;
      const renderedScale = fontScale * residualScale;
      return {
        scale: renderedScale,
        viewportWidth: viewportRect.width,
        renderedWidth: canvasRect.width,
        naturalWidth: canvasRect.width / renderedScale,
        fits: canvasRect.left >= viewportRect.left - 1 && canvasRect.right <= viewportRect.right + 1,
        controls: viewport.querySelectorAll('.meo-latex-math-zoom-controls').length,
        transform: canvas.style.transform
      };
    });
    if (
      previewMathFit.scale >= 1 ||
      previewMathFit.naturalWidth <= previewMathFit.viewportWidth ||
      !previewMathFit.fits ||
      previewMathFit.controls !== 0 ||
      previewMathFit.transform
    ) {
      throw new Error(`Preview mode did not fit the block formula cleanly: ${JSON.stringify(previewMathFit)}`);
    }
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await waitForFrames(page, 4);
    const widePreviewToolbar = await page.evaluate((pdfNode) => {
      const describe = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const hit = document.elementFromPoint(center.x, center.y);
        return {
          visible: getComputedStyle(element).visibility !== 'hidden',
          hit: Boolean(hit && element.contains(hit))
        };
      };
      return {
        overflowIndicatorHidden: document.querySelector<HTMLElement>('.toolbar-overflow-indicator')!.hidden,
        pdfRestored: pdfNode.parentElement?.classList.contains('preview-format-group') === true,
        overflowSectionEmpty: document.querySelector('.toolbar-overflow-panel')?.childElementCount === 0,
        html: describe(document.querySelector<HTMLButtonElement>('.preview-toolbar-action[data-format="html"]')!),
        pdf: describe(document.querySelector<HTMLButtonElement>('.preview-toolbar-action[data-format="pdf"]')!),
        labelsVisible: Array.from(document.querySelectorAll<HTMLElement>('.preview-toolbar-action-label'))
          .every((label) => getComputedStyle(label).display !== 'none')
      };
    }, previewPdfNode);
    if (
      !widePreviewToolbar.overflowIndicatorHidden ||
      !widePreviewToolbar.pdfRestored ||
      !widePreviewToolbar.overflowSectionEmpty ||
      !widePreviewToolbar.html.visible || !widePreviewToolbar.html.hit ||
      !widePreviewToolbar.pdf.visible || !widePreviewToolbar.pdf.hit ||
      !widePreviewToolbar.labelsVisible
    ) {
      throw new Error(`Wide Preview toolbar layout regressed: ${JSON.stringify(widePreviewToolbar)}`);
    }
    await positionPreviewElement(page, '#collapsed-long-code', 0.7);
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 16);
    const collapsedLongBlockState = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (collapsedLongBlockState.placeholders !== 1 || collapsedLongBlockState.footers !== 0) {
      throw new Error(`Preview positioning expanded a collapsed long code block: ${JSON.stringify(collapsedLongBlockState)}`);
    }

    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page, 2);
    await page.click('[data-mode="preview"]');
    await waitForFrames(page, 2);
    await positionPreviewElement(page, '#collapsed-long-code', 0.7);
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 16);
    const expandedLongBlockState = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (expandedLongBlockState.placeholders !== 0 || expandedLongBlockState.footers !== 1) {
      throw new Error(`Preview positioning lost a manually expanded long code block: ${JSON.stringify(expandedLongBlockState)}`);
    }

    await page.click('[data-mode="preview"]');
    await waitForFrames(page, 2);
    await positionPreviewElement(page, '#short-code', 0.5);
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 16);
    const shortCodeBlockVisible = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).some((line) => {
        const rect = line.getBoundingClientRect();
        return line.textContent?.startsWith('short_') && rect.bottom >= scroller.top && rect.top <= scroller.bottom;
      });
    });
    if (!shortCodeBlockVisible) {
      throw new Error('Preview positioning did not preserve a short code block location');
    }
    await page.click('[data-mode="preview"]');
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLAnchorElement>('#fnref-1')!.click();
    });
    await waitForFrames(page, 2);
    const footnoteJumpState = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return {
        documentPresent: Boolean(frameDocument.querySelector('.meo-export-doc')),
        targetTop: frameDocument.querySelector<HTMLElement>('#fn-1')?.getBoundingClientRect().top ?? null,
        viewportHeight: frameDocument.defaultView?.innerHeight ?? 0
      };
    });
    if (
      !footnoteJumpState.documentPresent ||
      footnoteJumpState.targetTop === null ||
      footnoteJumpState.targetTop < 0 ||
      footnoteJumpState.targetTop >= footnoteJumpState.viewportHeight
    ) {
      throw new Error(`Preview footnote navigation replaced or missed the document: ${JSON.stringify(footnoteJumpState)}`);
    }
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      frameDocument.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f',
        code: 'KeyF',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      }));
    });
    const previewFindPanelOpened = await page.$eval('.find-panel', (element) => element.classList.contains('is-visible'));
    if (!previewFindPanelOpened) {
      throw new Error('Ctrl+F inside Preview did not open the find panel');
    }
    const findClearColors = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.find-panel')!;
      panel.style.setProperty('--vscode-input-placeholderForeground', 'rgb(128, 136, 144)');
      panel.style.setProperty('--vscode-descriptionForeground', 'rgb(255, 255, 255)');
      panel.style.setProperty('--vscode-editor-foreground', 'rgb(255, 255, 255)');
      const findInput = panel.querySelector<HTMLInputElement>('.find-row:first-child .find-input')!;
      const replaceInput = panel.querySelector<HTMLInputElement>('.find-replace-row .find-input')!;
      return {
        findPlaceholder: getComputedStyle(findInput, '::placeholder').color,
        replacePlaceholder: getComputedStyle(replaceInput, '::placeholder').color,
        findClear: getComputedStyle(panel.querySelector<HTMLElement>('.find-row:first-child .find-clear-button')!).color,
        replaceClear: getComputedStyle(panel.querySelector<HTMLElement>('.find-replace-row .find-clear-button')!).color
      };
    });
    await page.hover('.find-panel .find-row:first-child .find-clear-button');
    const hoveredFindClearColor = await page.$eval(
      '.find-panel .find-row:first-child .find-clear-button',
      (element) => getComputedStyle(element).color
    );
    if (
      findClearColors.findPlaceholder !== 'rgb(128, 136, 144)' ||
      findClearColors.replacePlaceholder !== findClearColors.findPlaceholder ||
      findClearColors.findClear !== findClearColors.findPlaceholder ||
      findClearColors.replaceClear !== findClearColors.replacePlaceholder ||
      hoveredFindClearColor !== findClearColors.findPlaceholder
    ) {
      throw new Error(`Find and Replace clear icons did not match their placeholder text: ${JSON.stringify({ ...findClearColors, hoveredFindClearColor })}`);
    }
    await page.type('.find-panel .find-row:first-child .find-input', 'Tall Mermaid');
    await waitForFrames(page, 2);
    const previewFindState = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const replaceRow = document.querySelector<HTMLElement>('.find-replace-row')!;
      const replaceInput = replaceRow.querySelector<HTMLInputElement>('.find-input')!;
      return {
        status: document.querySelector<HTMLElement>('.find-status')?.textContent,
        matches: frameDocument.querySelectorAll('.meo-preview-search-match').length,
        replaceVisible: getComputedStyle(replaceRow).display !== 'none',
        replaceDisabled: replaceInput.disabled
      };
    });
    if (
      previewFindState.status !== '1 个匹配项' ||
      previewFindState.matches !== 1 ||
      !previewFindState.replaceVisible ||
      !previewFindState.replaceDisabled
    ) {
      throw new Error(`Preview content search is unavailable: ${JSON.stringify(previewFindState)}`);
    }
    await page.keyboard.press('Enter');
    await waitForFrames(page, 2);
    const activePreviewMatch = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const match = frameDocument.querySelector<HTMLElement>('.meo-preview-search-match.is-active');
      const rect = match?.getBoundingClientRect();
      return {
        status: document.querySelector<HTMLElement>('.find-status')?.textContent,
        visible: Boolean(rect && rect.bottom > 0 && rect.top < (frameDocument.defaultView?.innerHeight ?? 0))
      };
    });
    if (activePreviewMatch.status !== '1/1' || !activePreviewMatch.visible) {
      throw new Error(`Preview search did not reveal the active match: ${JSON.stringify(activePreviewMatch)}`);
    }
    await page.click('[data-action="find"]');
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const anchor = frameDocument.querySelector<HTMLElement>('#anchor-133')!;
      const scrollElement = frameDocument.scrollingElement!;
      const rect = anchor.getBoundingClientRect();
      scrollElement.scrollTop += rect.top + rect.height * ((138 - 133) / (222 - 133 + 1));
    });
    const darkPreviewState = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const select = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
        previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
        appearance: select.value,
        background: getComputedStyle(frame.contentDocument!.body).backgroundColor
      };
    });
    if (
      darkPreviewState.mode !== 'preview' ||
      !darkPreviewState.editorHidden ||
      darkPreviewState.previewHidden ||
      darkPreviewState.appearance !== 'dark' ||
      darkPreviewState.background !== 'rgb(32, 37, 43)'
    ) {
      throw new Error(`Unexpected dark Preview state: ${JSON.stringify(darkPreviewState)}`);
    }
    const restoredPreviewAnchor = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('#anchor-133')!;
      const rect = anchor.getBoundingClientRect();
      return rect.top + rect.height * ((138 - 133) / (222 - 133 + 1));
    });
    if (Math.abs(restoredPreviewAnchor) > 4) {
      throw new Error(`Preview did not restore the editor viewport: ${restoredPreviewAnchor}`);
    }
    const previewScrollBeforeSameDocumentMessage = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const scrollingElement = frame.contentDocument!.scrollingElement!;
      scrollingElement.scrollTop += 13;
      return scrollingElement.scrollTop;
    });
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'docChanged', text, version: 2 }
      }));
    }, initialText);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await waitForFrames(page, 2);
    const previewScrollAfterSameDocumentMessage = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    ));
    if (Math.abs(previewScrollAfterSameDocumentMessage - previewScrollBeforeSameDocumentMessage) > 0.5) {
      throw new Error(`Unchanged docChanged moved the Preview viewport: ${JSON.stringify({
        previewScrollBeforeSameDocumentMessage,
        previewScrollAfterSameDocumentMessage
      })}`);
    }
    await page.click('[data-action="outline-right"]');
    const outlineWidthBefore = await page.$eval<HTMLElement, number>('.outline-sidebar', (element) => element.getBoundingClientRect().width);
    const resizerBox = await page.$eval<HTMLElement, { x: number; y: number }>('.outline-resizer', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 80 };
    });
    await page.mouse.move(resizerBox.x, resizerBox.y);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x - 80, resizerBox.y, { steps: 8 });
    await page.mouse.up();
    const resizedOutline = await page.evaluate(() => ({
      width: document.querySelector<HTMLElement>('.outline-sidebar')!.getBoundingClientRect().width,
      resizing: document.body.classList.contains('outline-resizing')
    }));
    if (resizedOutline.width < outlineWidthBefore + 60 || resizedOutline.resizing) {
      throw new Error(`Preview outline resize stalled over the iframe: ${JSON.stringify({ outlineWidthBefore, resizedOutline })}`);
    }
    const scrollBeforeResizeWheel = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.scrollingElement!.scrollTop = 300;
      return frame.contentDocument!.scrollingElement!.scrollTop;
    });
    const previewBox = await page.$eval<HTMLIFrameElement, { x: number; y: number }>('.preview-frame', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(previewBox.x, previewBox.y);
    await page.mouse.wheel({ deltaY: 180 });
    await waitForFrames(page, 2);
    const resizeWheelState = await page.evaluate(({ x, y }) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return {
        scrollTop: frame.contentDocument!.scrollingElement!.scrollTop,
        pointerTarget: document.elementFromPoint(x, y)?.className ?? null,
        parentActive: document.activeElement?.className ?? null,
        frameActive: frame.contentDocument!.activeElement?.tagName ?? null
      };
    }, previewBox);
    if (resizeWheelState.scrollTop <= scrollBeforeResizeWheel) {
      throw new Error(`Preview scrolling remained stuck after resizing the outline: ${JSON.stringify(resizeWheelState)}`);
    }
    const syntheticWheelBefore = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const scrollingElement = frame.contentDocument!.scrollingElement!;
      const before = scrollingElement.scrollTop;
      frame.contentDocument!.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
      return before;
    });
    await waitForFrames(page, 2);
    const syntheticWheelAfter = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    ));
    if (syntheticWheelAfter <= syntheticWheelBefore) {
      throw new Error(`Preview wheel fallback did not recover scrolling: ${JSON.stringify({ syntheticWheelBefore, syntheticWheelAfter })}`);
    }
    await page.click('.outline-item[title="Tall Mermaid"]');
    await waitForFrames(page, 2);
    const outlineScrollTop = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    ));
    if (outlineScrollTop <= 0) {
      throw new Error('Preview outline did not jump to the selected heading');
    }
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.querySelector<HTMLElement>('#short-mermaid')!.scrollIntoView({ block: 'start' });
      frame.contentDocument!.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const topOutlineVisible = await page.$eval('.outline-item[title="Short Mermaid"]', (element) => element.classList.contains('is-visible'));
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      frame.contentDocument!.scrollingElement!.scrollTop = frame.contentDocument!.scrollingElement!.scrollHeight;
      frame.contentDocument!.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const bottomOutlineVisible = await page.$eval('.outline-item[title="Tall Mermaid"]', (element) => element.classList.contains('is-visible'));
    if (!topOutlineVisible || !bottomOutlineVisible) {
      throw new Error(`Preview scrolling did not update the outline: ${JSON.stringify({ topOutlineVisible, bottomOutlineVisible })}`);
    }
    const resizedBox = await page.$eval<HTMLElement, { x: number; y: number }>('.outline-resizer', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + 80 };
    });
    await page.mouse.move(resizedBox.x, resizedBox.y);
    await page.mouse.down();
    await page.mouse.move(resizedBox.x + 80, resizedBox.y, { steps: 8 });
    await page.mouse.up();
    await page.click('[data-action="outline-right"]');
    await page.evaluate(() => {
      const frameBody = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body;
      frameBody.dataset.themeSwitchSentinel = 'preserve-document';
    });
    await page.select('.preview-appearance-select', 'light');
    await page.waitForFunction(() => {
      return document.querySelector<HTMLSelectElement>('.preview-appearance-select')?.value === 'light';
    });
    await waitForFrames(page, 4);
    await page.waitForFunction((darkFill) => {
      const node = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<SVGElement>('[data-mermaid-node]');
      return Boolean(node?.getAttribute('fill') && node.getAttribute('fill') !== darkFill);
    }, {}, darkPreviewMermaidFill);
    const lightPreviewBackground = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return getComputedStyle(frame.contentDocument!.body).backgroundColor;
    });
    if (lightPreviewBackground !== 'rgb(255, 255, 255)') {
      throw new Error(`Preview light theme did not render: ${lightPreviewBackground}`);
    }
    const themeSwitchPreservedDocument = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body.dataset.themeSwitchSentinel
    ));
    if (themeSwitchPreservedDocument !== 'preserve-document') {
      throw new Error('Preview theme switching rebuilt the iframe document');
    }
    const appearanceMessages = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; appearance?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'setPreviewAppearance').map((message) => message.appearance));
    if (JSON.stringify(appearanceMessages) !== JSON.stringify(['light'])) {
      throw new Error(`Preview appearance was not persisted globally: ${JSON.stringify(appearanceMessages)}`);
    }
    const mermaidThemeIsolation = await page.evaluate(() => {
      const editorConfigs = (window as typeof window & {
        __mermaidInitializeConfigs?: Array<{ themeVariables?: { darkMode?: boolean } }>;
      }).__mermaidInitializeConfigs ?? [];
      return {
        previewSawDark: editorConfigs.some((config) => config.themeVariables?.darkMode === true),
        previewSawLight: editorConfigs.some((config) => config.themeVariables?.darkMode === false),
        editorEndedDark: editorConfigs.at(-1)?.themeVariables?.darkMode === true
      };
    });
    if (!mermaidThemeIsolation.previewSawDark || !mermaidThemeIsolation.previewSawLight || !mermaidThemeIsolation.editorEndedDark) {
      throw new Error(`Preview Mermaid theme was not isolated: ${JSON.stringify(mermaidThemeIsolation)}`);
    }
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 2);
    const previewExitVisibleLine = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).some((line) => {
        const rect = line.getBoundingClientRect();
        return line.textContent === '## Tall Mermaid' && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    });
    if (!previewExitVisibleLine) {
      throw new Error('Leaving Preview did not preserve the visible document position');
    }
    const backwardSelectionText = 'stable line 120';
    await page.evaluate(({ text, selectedText }) => {
      const head = text.indexOf(selectedText);
      if (head < 0) throw new Error(`Missing selection fixture: ${selectedText}`);
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection',
        anchor: head + selectedText.length,
        head,
        focus: true
      }}));
    }, { text: initialText, selectedText: backwardSelectionText });
    const editableSelectionMatches = (selectedText: string) => {
      const selection = window.getSelection();
      if (!selection || selection.toString() !== selectedText || !selection.anchorNode || !selection.focusNode) {
        return false;
      }
      const content = document.querySelector<HTMLElement>('.editor-host .cm-content');
      const active = document.activeElement;
      if (!content || !(active instanceof HTMLElement) || !content.contains(active)) return false;
      const anchorRange = document.createRange();
      anchorRange.setStart(selection.anchorNode, selection.anchorOffset);
      anchorRange.collapse(true);
      const focusRange = document.createRange();
      focusRange.setStart(selection.focusNode, selection.focusOffset);
      focusRange.collapse(true);
      return anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) > 0;
    };
    await page.waitForFunction(editableSelectionMatches, {}, backwardSelectionText);
    await page.click('[data-mode="source"]');
    await page.waitForFunction(editableSelectionMatches, {}, backwardSelectionText);
    await page.click('[data-mode="preview"]');
    await page.waitForSelector('.preview-host:not([hidden]) .preview-frame');
    await page.click('[data-mode="source"]');
    await page.waitForFunction(editableSelectionMatches, {}, backwardSelectionText);
    await page.evaluate((text) => {
      const selection = text.indexOf('## Short Mermaid');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      scroller.scrollTop = scroller.scrollHeight * (77 / 280);
    }, initialText);
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const shortHeading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Short Mermaid');
      if (shortHeading) {
        scroller.scrollTop += shortHeading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    });
    await waitForFrames(page, 2);
    const previewRequestsBeforeCachedSwitch = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'requestPreviewRender').length);
    await page.click('[data-mode="preview"]');
    await waitForFrames(page, 2);
    const cachedSwitchState = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? [];
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      return {
        requests: messages.filter((message) => message.type === 'requestPreviewRender').length,
        shortHeadingTop: frame.contentDocument!.querySelector<HTMLElement>('#short-mermaid')!.getBoundingClientRect().top
      };
    });
    if (
      cachedSwitchState.requests !== previewRequestsBeforeCachedSwitch ||
      Math.abs(cachedSwitchState.shortHeadingTop) > 4
    ) {
      throw new Error(`Unchanged Preview switch was not immediate: ${JSON.stringify({ previewRequestsBeforeCachedSwitch, cachedSwitchState })}`);
    }
    await page.click('[data-mode="source"]');
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      scroller.scrollTop = scroller.scrollHeight * (230 / 280);
    });
    await waitForFrames(page, 4);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const tallHeading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      if (tallHeading) {
        scroller.scrollTop += tallHeading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    });
    await waitForFrames(page, 2);
    const sourceHeadingTop = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      return heading ? heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
    });
    if (sourceHeadingTop === null || Math.abs(sourceHeadingTop) > 4) {
      throw new Error(`Source test setup did not position the target heading: ${sourceHeadingTop}`);
    }
    await page.click('[data-mode="preview"]');
    await waitForFrames(page, 2);
    const sourcePreviewHeadingTop = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('#tall-mermaid')!.getBoundingClientRect().top
    ));
    if (Math.abs(sourcePreviewHeadingTop) > 4) {
      throw new Error(`Source to Preview lost the visible document position: ${sourcePreviewHeadingTop}`);
    }
    await positionPreviewElement(page, '#short-mermaid', 0);
    await page.click('[data-mode="source"]');
    await waitForFrames(page, 2);
    const previewSourceVisibleLine = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).some((line) => {
        const rect = line.getBoundingClientRect();
        return line.textContent === '## Short Mermaid' && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    });
    if (!previewSourceVisibleLine) {
      throw new Error('Preview to Source lost the visible document position');
    }
    const sourceLiveFrames = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const sample = () => {
        const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent === '## Short Mermaid');
        const viewport = scroller.getBoundingClientRect();
        return {
          mode: document.querySelector<HTMLElement>('.editor-root')?.dataset.mode,
          targetTop: heading ? heading.getBoundingClientRect().top - viewport.top : null,
          viewportHeight: viewport.height
        };
      };
      document.querySelector<HTMLButtonElement>('[data-mode="live"]')!.click();
      const frames = [];
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push(sample());
      }
      return frames;
    });
    const liveFrames = sourceLiveFrames.filter((frame) => frame.mode === 'live');
    const liveTargetTops = liveFrames
      .map((frame) => frame.targetTop)
      .filter((top): top is number => top !== null);
    if (
      liveFrames.length === 0
      || liveTargetTops.length !== liveFrames.length
      || liveFrames.some((frame) => frame.targetTop! < -4 || frame.targetTop! > frame.viewportHeight + 4)
      || Math.max(...liveTargetTops) - Math.min(...liveTargetTops) > 4
    ) {
      throw new Error(`Source to Live painted an unstable viewport frame: ${JSON.stringify(sourceLiveFrames)}`);
    }
    const sourceLiveVisibleLine = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).some((line) => {
        const rect = line.getBoundingClientRect();
        return line.textContent === '## Short Mermaid' && rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
    });
    if (!sourceLiveVisibleLine) {
      throw new Error('Source to Live lost the visible document position');
    }
    await page.evaluate((text) => {
      const selection = text.indexOf('## Tall Mermaid');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
    }, initialText);
    await page.waitForFunction(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller');
      const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      if (!scroller || !heading) return false;
      const viewport = scroller.getBoundingClientRect();
      const rect = heading.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    await page.click('[data-mode="source"]');
    await page.waitForFunction(() => {
      if (document.querySelector('.editor-root')?.getAttribute('data-mode') !== 'source') return false;
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller');
      const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      if (!scroller || !heading) return false;
      const viewport = scroller.getBoundingClientRect();
      const rect = heading.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const liveSourceViewport = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      const headingRect = heading?.getBoundingClientRect();
      const firstVisible = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).find((line) => {
        const rect = line.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      return {
        headingTop: headingRect?.top ?? null,
        headingBottom: headingRect?.bottom ?? null,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        scrollTop: scroller.scrollTop,
        firstVisible: firstVisible?.textContent ?? null
      };
    });
    if (
      liveSourceViewport.headingTop === null ||
      liveSourceViewport.headingBottom === null ||
      liveSourceViewport.headingBottom <= liveSourceViewport.viewportTop ||
      liveSourceViewport.headingTop >= liveSourceViewport.viewportBottom
    ) {
      throw new Error(`Live to Source lost the visible document position: ${JSON.stringify(liveSourceViewport)}`);
    }
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 2);
    await page.evaluate((text) => {
      const selection = text.indexOf('## Tall Mermaid');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
    }, initialText);
    await waitForFrames(page, 8);
    await page.waitForFunction(() => Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]')), { timeout: 3000 });
    await page.evaluate((text) => {
      const selection = text.indexOf('const line10');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false
      }}));
    }, initialText);
    await waitForFrames(page, 2);
    const persistentCodeAnchor = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent === 'const line10 = 10;');
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null;
    });
    if (!persistentCodeAnchor) throw new Error('Could not expand the long viewport anchor block');
    await page.mouse.click(persistentCodeAnchor.x, persistentCodeAnchor.y);
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const anchorCodeLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'const line10 = 10;');
      if (anchorCodeLine) {
        scroller.scrollTop += anchorCodeLine.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    });
    await waitForFrames(page, 2);
    await page.click('[data-action="outline-right"]');
    await waitForFrames(page, 8);
    const readViewport = () => page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      const visibleCodeLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .map((line) => ({ text: line.textContent ?? '', rect: line.getBoundingClientRect() }))
        .filter(({ text, rect }) => text.startsWith('const line') && rect.bottom > viewport.top && rect.top < viewport.bottom)
        .sort((left, right) => left.rect.top - right.rect.top)[0];
      return {
        text: visibleCodeLine?.text ?? null,
        top: visibleCodeLine?.rect.top ?? null,
        scrollTop: scroller.scrollTop
      };
    });

    const before = await readViewport();
    const updatedText = initialText.replace('Start --> Done', 'Start --> Check --> Done');
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 2 } }));
      const selection = text.indexOf('const line6');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false, preserveViewport: true
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    }, updatedText);
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await waitForFrames(page, 8);
    const afterUpdate = await readViewport();

    const previewRequestsBeforeTheme = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'requestPreviewRender').length);
    await page.evaluate(() => {
      (window as any).__holdTallMermaidRender = true;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'vscodeCodeThemeChanged',
          appearance: 'dark',
          vscodeTheme: { name: 'Current Dark', type: 'dark', colors: {}, tokenColors: [] }
        }
      }));
    });
    await waitForFrames(page);
    const afterTheme = await readViewport();
    const previewRequestsAfterTheme = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'requestPreviewRender').length);
    if (previewRequestsAfterTheme !== previewRequestsBeforeTheme) {
      throw new Error(`Theme switch restarted Preview rendering: ${previewRequestsBeforeTheme} -> ${previewRequestsAfterTheme}`);
    }

    await page.mouse.move(450, 260);
    const wheelScrollTops: number[] = [];
    const wheelVisualPositions: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.wheel({ deltaY: -80 });
      await waitForFrames(page, 1);
      wheelScrollTops.push(await page.evaluate(() =>
        document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.scrollTop
      ));
      wheelVisualPositions.push(await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
        const scrollerRect = scroller.getBoundingClientRect();
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).find((candidate) => {
          if (!/^(?:stable line \d+|const line\d+)/.test(candidate.textContent ?? '')) return false;
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
        });
        const text = line?.textContent ?? '';
        const stableMatch = text.match(/^stable line (\d+)/);
        const codeMatch = text.match(/^const line(\d+)/);
        const documentLine = stableMatch ? Number(stableMatch[1]) : codeMatch ? 133 + Number(codeMatch[1]) : 0;
        const lineHeight = line ? Number.parseFloat(getComputedStyle(line).lineHeight) : 0;
        return documentLine > 0 && lineHeight > 0
          ? documentLine * lineHeight - line!.getBoundingClientRect().top
          : Number.NaN;
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitForFrames(page);
    const afterUpwardScroll = await readViewport();

    const lineNumber = (value: string | null): number | null => {
      const match = value?.match(/^const line(\d+)/);
      return match ? Number(match[1]) : null;
    };
    const beforeLine = lineNumber(before.text);
    const afterUpdateLine = lineNumber(afterUpdate.text);
    const afterThemeLine = lineNumber(afterTheme.text);
    const wheelMovedOnlyUp = wheelVisualPositions.every((position, index) => (
      Number.isFinite(position) && (index === 0 || position <= wheelVisualPositions[index - 1] + 1)
    ));
    if (
      beforeLine === null || afterUpdateLine === null || afterThemeLine === null ||
      Math.abs(afterUpdateLine - beforeLine) > 1 ||
      Math.abs(afterThemeLine - afterUpdateLine) > 1 ||
      Math.abs((afterTheme.top ?? 0) - (afterUpdate.top ?? 0)) > 1 ||
      !wheelMovedOnlyUp
    ) {
      throw new Error(`Implicit webview updates moved the visual anchor: ${JSON.stringify({ before, afterUpdate, afterTheme, wheelScrollTops, wheelVisualPositions, afterUpwardScroll })}`);
    }

    const tallMermaidBefore = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      scroller.scrollTop = scroller.scrollHeight;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const pending = document.querySelector<HTMLElement>(
          '.meo-mermaid-block[aria-busy="true"]:has(svg[height="3000"])'
        );
        if (pending) {
          const viewportTop = scroller.getBoundingClientRect().top;
          scroller.scrollTop += pending.getBoundingClientRect().bottom - viewportTop - 220;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const pendingBottom = pending.getBoundingClientRect().bottom;
          const anchor = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
            .find((line) => (
              line.getBoundingClientRect().top >= pendingBottom &&
              Boolean(line.textContent?.trim()) && line.textContent?.trim() !== '```'
            ));
          return {
            text: anchor?.textContent ?? null,
            top: anchor?.getBoundingClientRect().top ?? null,
            blockTop: pending.getBoundingClientRect().top,
            blockHeight: pending.getBoundingClientRect().height,
            scrollTop: scroller.scrollTop
          };
        }
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 120);
      }
      return null;
    });
    if (!tallMermaidBefore || tallMermaidBefore.top === null) {
      throw new Error(`Tall Mermaid did not enter the controlled pending state: ${JSON.stringify(tallMermaidBefore)}`);
    }
    const tallMermaidWheelDelta = -20;
    const tallMermaidWheelCount = 6;
    const pendingWheelCount = tallMermaidWheelCount / 2;
    for (let index = 0; index < pendingWheelCount; index += 1) {
      await page.mouse.wheel({ deltaY: tallMermaidWheelDelta });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await page.evaluate(() => (window as any).__releaseTallMermaidRender());
    await page.waitForFunction(() => (
      !document.querySelector('.meo-mermaid-block[aria-busy="true"]:has(svg[height="3000"])') &&
      Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]'))
    ));
    for (let index = pendingWheelCount; index < tallMermaidWheelCount; index += 1) {
      await page.mouse.wheel({ deltaY: tallMermaidWheelDelta });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await waitForFrames(page);
    const tallMermaidAfter = await page.evaluate((anchorText) => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const anchor = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === anchorText);
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block:has(svg[height="3000"])');
      return {
        text: anchor?.textContent ?? null,
        top: anchor?.getBoundingClientRect().top ?? null,
        rendered: Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]')),
        scrollTop: scroller.scrollTop,
        blockTop: block?.getBoundingClientRect().top ?? null,
        blockHeight: block?.getBoundingClientRect().height ?? null,
        visibleLines: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .filter((line) => {
            const rect = line.getBoundingClientRect();
            const viewport = scroller.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })
          .slice(0, 8)
          .map((line) => line.textContent)
      };
    }, tallMermaidBefore?.text ?? null);
    if (
      !tallMermaidAfter.rendered || tallMermaidAfter.top === null ||
      tallMermaidAfter.blockTop === null || tallMermaidAfter.blockHeight === null ||
      Math.abs(tallMermaidAfter.blockHeight - tallMermaidBefore.blockHeight) > 1 ||
      Math.abs(
        (tallMermaidAfter.top - tallMermaidAfter.blockTop) -
        (tallMermaidBefore.top - tallMermaidBefore.blockTop)
      ) > 1 ||
      Math.abs(
        tallMermaidAfter.top - tallMermaidBefore.top +
        tallMermaidWheelDelta * tallMermaidWheelCount
      ) > 12
    ) {
      throw new Error(`Tall Mermaid displaced the visible reading anchor: ${JSON.stringify({ tallMermaidBefore, tallMermaidAfter })}`);
    }

    const testEditorScrollToTop = async (mode: 'live' | 'source') => {
      await page.click(`[data-mode="${mode}"]`);
      await waitForFrames(page);
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));
      });
      await waitForFrames(page, 2);
      const hiddenAtTop = await page.$eval('.editor-host > .document-scroll-top', (button) => (button as HTMLButtonElement).hidden);
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.editor-host .cm-scroller')!;
        scroller.scrollTop = 320;
        scroller.dispatchEvent(new Event('scroll'));
      });
      await waitForFrames(page, 2);
      const visibleAfterScroll = await page.$eval('.editor-host > .document-scroll-top', (button) => !(button as HTMLButtonElement).hidden);
      const visibleGeometry = await page.$eval('.editor-host > .document-scroll-top', (button) => {
        const icon = button.querySelector<SVGSVGElement>('svg')!;
        const buttonRect = button.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return {
          centerXDelta: iconRect.left + iconRect.width / 2 - (buttonRect.left + buttonRect.width / 2),
          centerYDelta: iconRect.top + iconRect.height / 2 - (buttonRect.top + buttonRect.height / 2),
          iconLeftFraction: Math.abs(iconRect.left - Math.round(iconRect.left)),
          iconTopFraction: Math.abs(iconRect.top - Math.round(iconRect.top))
        };
      });
      await page.click('.editor-host > .document-scroll-top');
      await page.mouse.move(0, 0);
      const afterClick = await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.editor-host > .document-scroll-top')!;
        const style = getComputedStyle(button);
        return {
          hidden: button.hidden,
          scrollTop: document.querySelector<HTMLElement>('.editor-host .cm-scroller')!.scrollTop,
          width: style.width,
          height: style.height,
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
          documentBackground: getComputedStyle(document.querySelector<HTMLElement>('.editor-host')!).backgroundColor
        };
      });
      if (
        !hiddenAtTop || !visibleAfterScroll || afterClick.scrollTop !== 0 || !afterClick.hidden ||
        afterClick.width !== afterClick.height || afterClick.borderRadius !== '50%' ||
        afterClick.background !== afterClick.documentBackground ||
        Math.abs(visibleGeometry.centerXDelta) > 0.01 || Math.abs(visibleGeometry.centerYDelta + 1) > 0.01 ||
        visibleGeometry.iconLeftFraction > 0.01 || visibleGeometry.iconTopFraction > 0.01
      ) {
        throw new Error(`${mode} scroll-to-top button failed: ${JSON.stringify({
          hiddenAtTop,
          visibleAfterScroll,
          visibleGeometry,
          afterClick
        })}`);
      }
    };

    await testEditorScrollToTop('live');
    await testEditorScrollToTop('source');

    // A changed editable document starts a fresh Preview render, but the cached
    // frame is still the first surface the user sees. It must be repositioned
    // synchronously instead of painting its old scroll location first.
    await page.evaluate((text) => {
      const position = text.indexOf('stable line 240');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: position, head: position, focus: true
      }}));
    }, updatedText);
    await page.keyboard.type('x');
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const heading = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === '## Tall Mermaid');
      if (heading) {
        scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    });
    await waitForFrames(page, 2);
    const requestsBeforePendingPreviewSwitch = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'requestPreviewRender').length);
    await page.click('[data-mode="preview"]');
    const pendingPreviewFirstSurface = await page.evaluate(() => {
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? [];
      const heading = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('#tall-mermaid');
      return {
        requests: messages.filter((message) => message.type === 'requestPreviewRender').length,
        headingTop: heading?.getBoundingClientRect().top ?? null
      };
    });
    if (
      pendingPreviewFirstSurface.requests !== requestsBeforePendingPreviewSwitch + 1 ||
      pendingPreviewFirstSurface.headingTop === null ||
      Math.abs(pendingPreviewFirstSurface.headingTop) > 4
    ) {
      throw new Error(`Pending Preview switch painted a stale viewport first: ${JSON.stringify({
        requestsBeforePendingPreviewSwitch,
        pendingPreviewFirstSurface
      })}`);
    }

    await page.waitForSelector('.preview-host:not([hidden]) .preview-frame');
    await waitForFrames(page);
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      frameDocument.scrollingElement!.scrollTop = 0;
      frameDocument.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const previewHiddenAtTop = await page.$eval('.preview-host > .document-scroll-top', (button) => (button as HTMLButtonElement).hidden);
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      frameDocument.scrollingElement!.scrollTop = 320;
      frameDocument.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 2);
    const previewVisibleAfterScroll = await page.$eval('.preview-host > .document-scroll-top', (button) => !(button as HTMLButtonElement).hidden);
    await page.click('.preview-host > .document-scroll-top');
    const previewAfterClick = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const button = document.querySelector<HTMLButtonElement>('.preview-host > .document-scroll-top')!;
      return { hidden: button.hidden, scrollTop: frameDocument.scrollingElement!.scrollTop };
    });
    if (
      !previewHiddenAtTop || !previewVisibleAfterScroll ||
      previewAfterClick.scrollTop !== 0 || !previewAfterClick.hidden
    ) {
      throw new Error(`Preview scroll-to-top button failed: ${JSON.stringify({
        previewHiddenAtTop,
        previewVisibleAfterScroll,
        previewAfterClick
      })}`);
    }
    console.log('webview viewport checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
