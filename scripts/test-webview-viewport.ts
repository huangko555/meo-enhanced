import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

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
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
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
          await new Promise(resolve => setTimeout(resolve, source.includes('Step18') ? 650 : source.includes('Check') ? 80 : 5));
          const height = source.includes('Step18') ? 3000 : source.includes('sequenceDiagram') ? 260 : 120;
          const variables = window.__mermaidConfig?.themeVariables ?? {};
          const fill = variables.primaryColor ?? '#ffffff';
          const stroke = variables.primaryBorderColor ?? '#000000';
          return { svg: '<svg width="800" height="' + height + '" viewBox="0 0 800 ' + height + '"><rect data-mermaid-node width="160" height="80" fill="' + fill + '" stroke="' + stroke + '"></rect></svg>' };
        }
      };
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = createFixture();
    await page.evaluate(({ text, theme }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text, version: 1, diagnostics: [], mode: 'live', previewAppearance: 'light', editorAppearance: 'dark',
        lineNumbers: true, gitChangesGutter: false, gitDiffLineHighlights: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null,
        restoreTopLine: 139, restoreTopLineOffset: 0
      }}));
    }, { text: initialText, theme: defaultThemeSettings });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForFrames(page);
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
      JSON.stringify(toolbarLayout.right) !== JSON.stringify(['changes', 'more', 'separator', 'find', 'outline-right']) ||
      JSON.stringify(toolbarLayout.changes) !== JSON.stringify(['fixedBaseline', 'gitChangesGutter'])
    ) {
      throw new Error(`Unexpected toolbar layout: ${JSON.stringify(toolbarLayout)}`);
    }
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitChangesGutterChanged', enabled: false }
    })));
    await waitForFrames(page, 2);
    const inactiveToggleStyle = await page.$eval('[data-action="gitChangesGutter"]', (button) => {
      const style = getComputedStyle(button);
      return { color: style.color, opacity: style.opacity, background: style.backgroundColor };
    });
    await page.hover('[data-action="gitChangesGutter"]');
    const inactiveToggleHoverStyle = await page.$eval('[data-action="gitChangesGutter"]', (button) => {
      const style = getComputedStyle(button);
      return { color: style.color, opacity: style.opacity, background: style.backgroundColor };
    });
    if (
      inactiveToggleHoverStyle.color !== inactiveToggleStyle.color ||
      inactiveToggleHoverStyle.opacity !== inactiveToggleStyle.opacity ||
      inactiveToggleHoverStyle.background === inactiveToggleStyle.background
    ) {
      throw new Error(`Inactive toolbar hover changed its icon instead of only its background: ${JSON.stringify({ inactiveToggleStyle, inactiveToggleHoverStyle })}`);
    }
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'gitChangesGutterChanged', enabled: true }
    })));
    await page.click('[aria-label="More tools"]');
    const moreToolsLayout = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.more-tools-panel')!;
      const options = Array.from(panel.querySelectorAll<HTMLElement>(':scope > .more-tools-option'));
      return {
        labels: options.map((option) => option.querySelector('.more-tools-option-label')?.textContent),
        directChildren: options.every((option) => option.parentElement === panel),
        baselineIcons: options.slice(1, 4).map((option) => option.querySelector('.more-tools-option-icon svg')?.outerHTML),
        separatorCount: panel.querySelectorAll(':scope > .more-tools-separator').length
      };
    });
    if (
      JSON.stringify(moreToolsLayout.labels) !== JSON.stringify([
        'Release Fixed Baseline',
        'Current Edits', 'Recent Save', 'Git HEAD',
        'Constrain Width', 'Line Numbers', 'Line Authors', 'Fold Long Code Blocks', 'Spellcheck'
      ]) ||
      !moreToolsLayout.directChildren ||
      moreToolsLayout.separatorCount !== 2 ||
      moreToolsLayout.baselineIcons.some((icon) => !icon) ||
      new Set(moreToolsLayout.baselineIcons).size !== 1
    ) {
      throw new Error(`Unexpected flat More tools layout: ${JSON.stringify(moreToolsLayout)}`);
    }
    const longCodeFoldingInitial = await page.$eval('[data-action="longCodeBlockFolding"]', (button) => ({
      active: button.classList.contains('is-active'),
      checked: button.getAttribute('aria-checked')
    }));
    if (!longCodeFoldingInitial.active || longCodeFoldingInitial.checked !== 'true') {
      throw new Error(`Long code block folding was not enabled by default: ${JSON.stringify(longCodeFoldingInitial)}`);
    }
    await page.click('[data-action="longCodeBlockFolding"]');
    await waitForFrames(page, 2);
    const longCodeFoldingDisabled = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="longCodeBlockFolding"]')!;
      const messages = (window as typeof window & { __hostMessages?: Array<{ type?: string; enabled?: boolean }> }).__hostMessages ?? [];
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        posted: messages.some((message) => message.type === 'setLongCodeBlockFolding' && message.enabled === false)
      };
    });
    if (longCodeFoldingDisabled.active || longCodeFoldingDisabled.checked !== 'false' || !longCodeFoldingDisabled.posted) {
      throw new Error(`Long code block folding did not disable: ${JSON.stringify(longCodeFoldingDisabled)}`);
    }
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'longCodeBlockFoldingChanged', enabled: true }
    })));
    await waitForFrames(page, 2);
    await page.click('[aria-label="More tools"]');
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
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'lineNumbersChanged', enabled: false } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'contentMaxWidthChanged', enabled: true } }));
    });
    await waitForFrames(page);
    const toggledToolbarStart = await measureToolbarStart();
    const constrainedWidthState = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-action="contentMaxWidth"]')!;
      return {
        active: button.classList.contains('is-active'),
        checked: button.getAttribute('aria-checked'),
        widthOverride: document.documentElement.style.getPropertyValue('--meo-content-max-width')
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
      initialToolbarStart.modeButtonWidths.live !== 56 ||
      !(initialToolbarStart.modeButtonWidths.preview > initialToolbarStart.modeButtonWidths.source) ||
      !(initialToolbarStart.modeButtonWidths.source > initialToolbarStart.modeButtonWidths.live) ||
      JSON.stringify(initialToolbarStart.activeModeInsets) !== JSON.stringify({ top: 3, bottom: 3, left: 4 }) ||
      initialToolbarStart.modeSegmentGap !== 0 ||
      !initialToolbarStart.modeUsesSharedComponent ||
      inactiveModeHoverBackground !== 'rgba(0, 0, 0, 0)' ||
      toggledToolbarStart.paddingLeft !== 10 ||
      Math.abs(toggledToolbarStart.firstButtonOffset - 10) > 0.5 ||
      !constrainedWidthState.active ||
      constrainedWidthState.checked !== 'true' ||
      constrainedWidthState.widthOverride !== '800px'
    ) {
      throw new Error(`Toolbar settings did not update as expected: ${JSON.stringify({ initialToolbarStart, toggledToolbarStart, constrainedWidthState })}`);
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'lineNumbersChanged', enabled: true } }));
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
    await page.evaluate((theme) => {
      document.body.className = 'vscode-dark';
      document.documentElement.style.setProperty('--vscode-editor-background', '#010203');
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#040506');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'themeChanged', theme, codeTheme: null
      }}));
    }, defaultThemeSettings);
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
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: true, active: true
      }}));
    });
    const activeBaselineColors = await page.$eval('[data-action="fixedBaseline"]', (button) => ({
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor
    }));
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'fixedBaselineChanged', pinned: true, active: false
      }}));
    });
    const standbyBaselineColor = await page.$eval('[data-action="fixedBaseline"]', (button) => (
      getComputedStyle(button, '::before').backgroundColor
    ));
    if (
      JSON.stringify(activeBaselineColors) !== JSON.stringify({
        color: 'rgb(255, 255, 255)',
        background: 'rgb(45, 164, 78)'
      }) ||
      standbyBaselineColor !== 'rgb(26, 127, 55)'
    ) {
      throw new Error(`Editor light baseline colors were not readable: ${JSON.stringify({ activeBaselineColors, standbyBaselineColor })}`);
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
    await page.evaluate((theme) => {
      document.body.className = 'vscode-light';
      document.documentElement.style.setProperty('--vscode-editor-background', '#fafafa');
      document.documentElement.style.setProperty('--vscode-sideBar-background', '#f0f0f0');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'themeChanged', theme, codeTheme: null
      }}));
    }, defaultThemeSettings);
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
    await page.click('[data-action="save"]');
    await waitForFrames(page, 2);
    const saveMessages = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'saveDocument').length);
    if (saveMessages !== 1) {
      throw new Error(`Toolbar save did not request a save: ${saveMessages}`);
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
    const previewToolbarLayout = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>('.preview-format-group')!;
      const appearanceControl = group.querySelector<HTMLElement>('.preview-appearance-control')!;
      const activeAppearanceButton = appearanceControl.querySelector<HTMLElement>('.is-active')!;
      const appearanceButtons = Array.from(appearanceControl.querySelectorAll<HTMLElement>('.segmented-control-button'));
      const activeAppearanceIndicator = activeAppearanceButton.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
      const appearanceControlBounds = appearanceControl.getBoundingClientRect();
      const activeAppearanceBounds = activeAppearanceIndicator.getBoundingClientRect();
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        toolbarHeight: document.querySelector<HTMLElement>('.mode-toolbar')!.getBoundingClientRect().height,
        appearanceControlHeight: appearanceControl.getBoundingClientRect().height,
        appearanceControlRadius: Number.parseFloat(getComputedStyle(appearanceControl).borderRadius),
        activeAppearanceRadius: Number.parseFloat(getComputedStyle(activeAppearanceIndicator).borderRadius),
        activeAppearanceInsets: {
          top: activeAppearanceBounds.top - appearanceControlBounds.top,
          right: appearanceControlBounds.right - activeAppearanceBounds.right,
          bottom: appearanceControlBounds.bottom - activeAppearanceBounds.bottom
        },
        appearanceSegmentGap: appearanceButtons[1].getBoundingClientRect().left - appearanceButtons[0].getBoundingClientRect().right,
        appearanceUsesSharedComponent: appearanceControl.classList.contains('segmented-control'),
        activeAppearance: activeAppearanceButton.dataset.appearance,
        visible: getComputedStyle(group).display !== 'none',
        items: Array.from(group.querySelectorAll(':scope > button, :scope > .preview-appearance-control > button')).map((element) => (
          (element as HTMLElement).dataset.action ||
          (element as HTMLElement).dataset.appearance ||
          element.textContent?.trim()
        )),
        moreExports: document.querySelectorAll('.more-tools-panel [data-format]').length,
        floatingThemeToggle: Boolean(document.querySelector('.preview-host .preview-theme-toggle'))
      };
    });
    if (
      !previewToolbarLayout.visible ||
      Math.abs(previewToolbarLayout.toolbarHeight - initialToolbarStart.toolbarHeight) > 0.5 ||
      previewToolbarLayout.appearanceControlHeight !== 26 ||
      previewToolbarLayout.appearanceControlRadius !== 8 ||
      previewToolbarLayout.activeAppearanceRadius !== 5 ||
      JSON.stringify(previewToolbarLayout.activeAppearanceInsets) !== JSON.stringify({ top: 3, right: 3, bottom: 3 }) ||
      previewToolbarLayout.appearanceSegmentGap !== 0 ||
      !previewToolbarLayout.appearanceUsesSharedComponent ||
      previewToolbarLayout.activeAppearance !== 'dark' ||
      JSON.stringify(previewToolbarLayout.items) !== JSON.stringify([
        'outline-left', 'light', 'dark', 'Export HTML', 'Export PDF'
      ]) ||
      previewToolbarLayout.moreExports !== 0 ||
      previewToolbarLayout.floatingThemeToggle
    ) {
      throw new Error(`Unexpected Preview toolbar: ${JSON.stringify({ initialToolbarStart, previewToolbarLayout })}`);
    }
    const measureAppearanceIndicator = () => page.evaluate(() => {
      const control = document.querySelector<HTMLElement>('.preview-appearance-control')!;
      const activeButton = control.querySelector<HTMLElement>('.preview-appearance-button.is-active')!;
      const indicator = activeButton.querySelector<HTMLElement>('.segmented-control-button-indicator')!;
      const label = activeButton.querySelector<HTMLElement>('.segmented-control-button-label')!;
      const controlBounds = control.getBoundingClientRect();
      const indicatorBounds = indicator.getBoundingClientRect();
      const labelBounds = label.getBoundingClientRect();
      const appearanceButtons = Array.from(control.querySelectorAll<HTMLElement>('.preview-appearance-button'));
      return {
        active: activeButton.dataset.appearance,
        top: indicatorBounds.top - controlBounds.top,
        right: controlBounds.right - indicatorBounds.right,
        bottom: controlBounds.bottom - indicatorBounds.bottom,
        left: indicatorBounds.left - controlBounds.left,
        height: indicatorBounds.height,
        radius: getComputedStyle(indicator).borderTopLeftRadius,
        labelOffset: indicatorBounds.top + indicatorBounds.height / 2
          - (labelBounds.top + labelBounds.height / 2),
        controlWidth: controlBounds.width,
        buttonWidths: Object.fromEntries(appearanceButtons.map((button) => [
          button.dataset.appearance,
          button.getBoundingClientRect().width
        ]))
      };
    });
    const darkAppearanceGeometry = await measureAppearanceIndicator();
    await page.click('.preview-appearance-button[data-appearance="light"]');
    const lightAppearanceGeometry = await measureAppearanceIndicator();
    await page.click('.preview-appearance-button[data-appearance="dark"]');
    if (
      darkAppearanceGeometry.active !== 'dark' ||
      darkAppearanceGeometry.top !== 3 ||
      darkAppearanceGeometry.right !== 3 ||
      darkAppearanceGeometry.bottom !== 3 ||
      darkAppearanceGeometry.height !== 20 ||
      darkAppearanceGeometry.radius !== '5px' ||
      darkAppearanceGeometry.labelOffset !== 0.5 ||
      lightAppearanceGeometry.active !== 'light' ||
      lightAppearanceGeometry.top !== 3 ||
      lightAppearanceGeometry.bottom !== 3 ||
      lightAppearanceGeometry.left !== 3 ||
      lightAppearanceGeometry.height !== 20 ||
      lightAppearanceGeometry.radius !== '5px' ||
      lightAppearanceGeometry.labelOffset !== 0.5 ||
      darkAppearanceGeometry.buttonWidths.dark === darkAppearanceGeometry.buttonWidths.light ||
      darkAppearanceGeometry.buttonWidths.light < 56 ||
      darkAppearanceGeometry.buttonWidths.dark < 56 ||
      Math.abs(darkAppearanceGeometry.left - (darkAppearanceGeometry.buttonWidths.light + 3)) > 0.01 ||
      Math.abs(lightAppearanceGeometry.right - (lightAppearanceGeometry.buttonWidths.dark + 3)) > 0.01 ||
      Math.abs(darkAppearanceGeometry.controlWidth - (
        darkAppearanceGeometry.buttonWidths.light + darkAppearanceGeometry.buttonWidths.dark
      )) > 0.01
    ) {
      throw new Error(`Preview appearance control geometry is inconsistent: ${JSON.stringify({
        darkAppearanceGeometry,
        lightAppearanceGeometry
      })}`);
    }
    await page.evaluate(() => {
      const testWindow = window as typeof window & { __hostMessages?: Array<{ type?: string }> };
      testWindow.__hostMessages = (testWindow.__hostMessages ?? []).filter(
        (message) => message.type !== 'setPreviewAppearance'
      );
    });
    await page.click('.preview-toolbar-action[data-format="html"]');
    await page.click('.preview-toolbar-action[data-format="pdf"]');
    const previewExportRequests = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; format?: string; appearance?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportDocument').map((message) => ({
      format: message.format,
      appearance: message.appearance
    })));
    if (JSON.stringify(previewExportRequests) !== JSON.stringify([
      { format: 'html', appearance: 'dark' },
      { format: 'pdf', appearance: 'dark' }
    ])) {
      throw new Error(`Preview export buttons did not request both formats with the current appearance: ${JSON.stringify(previewExportRequests)}`);
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
        type: 'previewRenderError', requestId, message: 'Preview test error'
      }}));
    }, previewRequestId);
    const previewError = await page.$eval('.preview-status', (element) => element.textContent);
    if (previewError !== 'Preview test error') {
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
        type: 'previewRendered', requestId, html: '<h1 id="stale">Stale</h1>', hasMermaid: false,
        styles: { dark: 'body{background:red}', light: 'body{background:red}' }
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
        type: 'previewRendered',
        requestId,
        html: '<h1 id="intro" data-source-line="1">Intro</h1><div id="preview-wide-math" class="meo-export-math meo-export-math-display meo-export-math-fenced-display" data-source-line="3" data-source-end-line="5"><span class="katex-display"><span class="katex" style="display:inline-block;white-space:nowrap;font-family:serif;font-size:1.21em">WIDE_FORMULA_ALPHA_BETA_GAMMA_DELTA_EPSILON_ZETA_ETA_THETA_IOTA_KAPPA_LAMBDA_MU_NU_XI_OMICRON_PI_RHO_SIGMA_TAU</span></span></div><p>Footnote reference <a id="fnref-1" href="#fn-1">1</a></p><pre id="collapsed-long-code" data-source-line="15" data-source-end-line="36" style="height:440px">Long code block</pre><pre id="short-code" data-source-line="45" data-source-end-line="56" style="height:240px">Short code block</pre><div style="height:600px"></div><h2 id="short-mermaid" data-source-line="78">Short Mermaid</h2><div style="height:900px"></div><pre id="anchor-133" data-source-line="133" data-source-end-line="222" style="height:900px">Code block</pre><div style="height:600px"></div><h2 id="tall-mermaid" data-source-line="231">Tall Mermaid</h2><div style="height:900px"></div><div class="meo-export-mermaid" data-source-b64="Zmxvd2NoYXJ0IExSClN0YXJ0IC0tPiBEb25l" style="display:none"></div><ol><li id="fn-1">Footnote content <a href="#fnref-1">Back</a></li></ol>',
        hasMermaid: true,
        styles: {
          dark: 'html,body{margin:0;background:#20252b;color:#fff}.meo-export-doc{padding:20px}',
          light: 'html,body{margin:0;background:#fff;color:#1f2328}.meo-export-doc{padding:20px}'
        }
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
    await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await waitForFrames(page, 4);
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
      const findInput = panel.querySelector<HTMLInputElement>('[placeholder="Find"]')!;
      const replaceInput = panel.querySelector<HTMLInputElement>('[placeholder="Replace"]')!;
      return {
        findPlaceholder: getComputedStyle(findInput, '::placeholder').color,
        replacePlaceholder: getComputedStyle(replaceInput, '::placeholder').color,
        findClear: getComputedStyle(panel.querySelector<HTMLElement>('[aria-label="Clear Find"]')!).color,
        replaceClear: getComputedStyle(panel.querySelector<HTMLElement>('[aria-label="Clear Replace"]')!).color
      };
    });
    await page.hover('.find-panel [aria-label="Clear Find"]');
    const hoveredFindClearColor = await page.$eval(
      '.find-panel [aria-label="Clear Find"]',
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
    await page.type('.find-panel .find-input[placeholder="Find"]', 'Tall Mermaid');
    await waitForFrames(page, 2);
    const previewFindState = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const replaceRow = document.querySelector<HTMLElement>('.find-replace-row')!;
      const replaceInput = replaceRow.querySelector<HTMLInputElement>('[placeholder="Replace"]')!;
      return {
        status: document.querySelector<HTMLElement>('.find-status')?.textContent,
        matches: frameDocument.querySelectorAll('.meo-preview-search-match').length,
        replaceVisible: getComputedStyle(replaceRow).display !== 'none',
        replaceDisabled: replaceInput.disabled
      };
    });
    if (
      previewFindState.status !== '1 matches' ||
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
      const toggle = document.querySelector<HTMLElement>('.preview-appearance-button[data-appearance="light"]')!;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden,
        previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
        pressed: toggle.getAttribute('aria-pressed'),
        background: getComputedStyle(frame.contentDocument!.body).backgroundColor
      };
    });
    if (
      darkPreviewState.mode !== 'preview' ||
      !darkPreviewState.editorHidden ||
      darkPreviewState.previewHidden ||
      darkPreviewState.pressed !== 'false' ||
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
    await page.click('.preview-appearance-button[data-appearance="light"]');
    await page.waitForFunction(() => {
      return document.querySelector<HTMLElement>('.preview-appearance-button[data-appearance="light"]')?.getAttribute('aria-pressed') === 'true';
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
    await page.click('.preview-toolbar-action[data-format="html"]');
    const lightExportAppearance = await page.evaluate(() => (
      (window as typeof window & { __hostMessages?: Array<{ type?: string; appearance?: string }> }).__hostMessages ?? []
    ).filter((message) => message.type === 'exportDocument').at(-1)?.appearance);
    if (lightExportAppearance !== 'light') {
      throw new Error(`Light Preview export did not keep the active appearance: ${lightExportAppearance}`);
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
    await page.click('[data-mode="live"]');
    await waitForFrames(page, 2);
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
    await page.click('[data-mode="source"]');
    await waitForFrames(page, 8);
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

    await page.evaluate((theme) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'themeChanged', theme, codeTheme: null }
      }));
    }, {
      ...defaultThemeSettings,
      fonts: { ...defaultThemeSettings.fonts, liveFontSize: 18 }
    });
    await waitForFrames(page);
    const afterTheme = await readViewport();

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
        const pending = document.querySelector<HTMLElement>('.meo-mermaid-loading')
          ?.closest<HTMLElement>('.meo-mermaid-block') ?? null;
        if (pending) {
          const viewportTop = scroller.getBoundingClientRect().top;
          scroller.scrollTop += pending.getBoundingClientRect().top - viewportTop - 80;
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
            blockTop: pending.getBoundingClientRect().top
          };
        }
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 120);
      }
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const tallMermaidWheelDelta = -20;
    const tallMermaidWheelCount = 6;
    for (let index = 0; index < tallMermaidWheelCount; index += 1) {
      await page.mouse.wheel({ deltaY: tallMermaidWheelDelta });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await waitForFrames(page);
    const tallMermaidAfter = await page.evaluate((anchorText) => {
      const anchor = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === anchorText);
      return {
        text: anchor?.textContent ?? null,
        top: anchor?.getBoundingClientRect().top ?? null,
        rendered: Boolean(document.querySelector('.meo-mermaid-block svg[height="3000"]'))
      };
    }, tallMermaidBefore?.text ?? null);
    if (
      !tallMermaidBefore || tallMermaidBefore.top === null ||
      !tallMermaidAfter.rendered || tallMermaidAfter.top === null ||
      Math.abs(
        tallMermaidAfter.top - tallMermaidBefore.top +
        tallMermaidWheelDelta * tallMermaidWheelCount
      ) > 1
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

    await page.click('[data-mode="preview"]');
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
