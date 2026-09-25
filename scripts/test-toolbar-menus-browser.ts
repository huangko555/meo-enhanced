import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.__hostMessages=[];window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__hostMessages.push(message);}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '# Export menu';
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///preview-export-menu.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: 'zh-CN',
    sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
    previewShowComments: false,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview');

  const options = [
    ['html', false], ['html', true], ['pdf', false], ['pdf', true], ['docx', false], ['docx', true]
  ] as const;
  assert.equal(await page.$eval('.preview-export-trigger', element => element.textContent?.trim()), '导出为...');
  assert.equal(await page.$eval('.preview-export-trigger svg path', path => path.getAttribute('d')?.startsWith('M14 17a1 1 0 1 0 0 2z') && path.getAttribute('fill') === 'currentColor'), true);
  assert.equal(await page.$$eval('.preview-export-menu-action', elements => elements.length), 6);
  const formatIconColors = await page.$$eval('.preview-export-menu-action', elements => elements.map(element => {
    const icon = element.querySelector('img');
    const svg = icon ? decodeURIComponent(icon.src.split(',')[1] ?? '') : '';
    return [element.getAttribute('data-format'), icon?.getAttribute('src')?.startsWith('data:image/svg+xml,'), svg.includes('fill="#ffffff"'), svg.match(/fill="(#(?:e65100|ef5350|01579b))"/)?.[1]];
  }));
  assert.deepEqual(formatIconColors, options.map(([format]) => [format, true, true, { html: '#e65100', pdf: '#ef5350', docx: '#01579b' }[format]]));
  for (const [format, includeTableOfContents] of options) {
    await page.hover('.preview-export-trigger');
    await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!).visibility === 'visible');
    const geometry = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.preview-export-trigger')!.getBoundingClientRect();
      const menu = document.querySelector<HTMLElement>('.preview-export-menu')!.getBoundingClientRect();
      const menuStyle = getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!);
      const tableStyle = getComputedStyle(document.querySelector<HTMLElement>('.table-dropdown')!);
      return {
        below: menu.top >= button.bottom,
        leftAligned: Math.abs(menu.left - button.left) <= 0.5,
        inViewport: menu.left >= 0 && menu.right <= innerWidth,
        sameSurface: menuStyle.backgroundColor === tableStyle.backgroundColor
          && menuStyle.borderTopColor === tableStyle.borderTopColor
      };
    });
    assert.deepEqual(geometry, { below: true, leftAligned: true, inViewport: true, sameSurface: true });
    await page.click(`.preview-export-menu-action[data-format="${format}"][data-include-table-of-contents="${includeTableOfContents}"]`);
    assert.equal(await page.$eval('.preview-export-trigger', element => element.getAttribute('aria-expanded')), 'false');
    await page.mouse.move(0, 0);
  }
  const requests = await page.evaluate(() => (
    (window as typeof window & { __hostMessages: Array<{ type: string; format?: string; includeTableOfContents?: boolean }> }).__hostMessages
      .filter(message => message.type === 'exportDocument')
      .map(({ format, includeTableOfContents }) => [format, includeTableOfContents])
  ));
  assert.deepEqual(requests, options.map(option => [...option]));
  await page.hover('.preview-export-trigger');
  await page.click('.preview-export-trigger');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector<HTMLElement>('.preview-export-menu')!).visibility === 'hidden');
  assert.equal(await page.$eval('.preview-export-trigger', element => element.getAttribute('aria-expanded')), 'false');
  await page.setViewport({ width: 420, height: 700 });
  await page.waitForFunction(() => document.querySelector('.toolbar-overflow-panel .preview-export-control'));
  await page.click('.toolbar-overflow-indicator');
  await page.hover('.preview-export-trigger');
  const narrowMenu = await page.$eval('.preview-export-menu', element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, visibility: getComputedStyle(element).visibility };
  });
  assert.equal(narrowMenu.visibility, 'visible');
  assert.ok(narrowMenu.left >= 0 && narrowMenu.right <= 420, JSON.stringify(narrowMenu));
  await page.setViewport({ width: 1100, height: 700 });
  await page.click('.more-tools-wrapper > .format-button');
  const settingsChoices = [
    '.ui-language-button[data-ui-language="zh-CN"]',
    '.ui-language-button[data-ui-language="en"]',
    '.ui-language-button[data-ui-language="auto"]',
    '.editor-appearance-button[data-editor-appearance="light"]',
    '.editor-appearance-button[data-editor-appearance="dark"]',
    '.editor-appearance-button[data-editor-appearance="auto"]',
    '.editor-font-size-mode-button[data-editor-font-size-mode="custom"]',
    '.editor-font-size-mode-button[data-editor-font-size-mode="auto"]'
  ];
  const modeWidthsByLanguage: number[] = [];
  for (const selector of settingsChoices) {
    await page.click(selector);
    const menuState = await page.evaluate(() => ({
      hidden: document.querySelector<HTMLElement>('.more-tools-panel')!.hidden,
      expanded: document.querySelector<HTMLElement>('.more-tools-wrapper > .format-button')!.getAttribute('aria-expanded')
    }));
    assert.deepEqual(menuState, { hidden: false, expanded: 'true' }, selector);
    if (selector === '.ui-language-button[data-ui-language="en"]') {
      const clippedLabels = await page.$$eval('.more-tools-control-label', labels => labels
        .filter(label => label.scrollWidth > label.clientWidth)
        .map(label => label.textContent));
      assert.deepEqual(clippedLabels, []);
    }
    if (selector.includes('data-ui-language')) {
      const modeLayout = await page.$eval('.mode-group', control => ({
        width: control.getBoundingClientRect().width,
        optionWidths: Array.from(control.querySelectorAll<HTMLElement>('.mode-button'))
          .map(button => button.getBoundingClientRect().width),
        contentFits: Array.from(control.querySelectorAll<HTMLElement>('.mode-button'))
          .every(button => {
            const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
            const bounds = button.getBoundingClientRect();
            return content.left >= bounds.left && content.right <= bounds.right;
          })
      }));
      modeWidthsByLanguage.push(modeLayout.width);
      assert.ok(modeLayout.optionWidths.every(width => Math.abs(width - 56) <= 0.5) && modeLayout.contentFits, JSON.stringify(modeLayout));
    }
  }
  assert.deepEqual(modeWidthsByLanguage, [170, 170, 170]);
  for (const action of [
    'sourceLineNumbers', 'longCodeBlockFolding', 'contentMaxWidth', 'liveStrongColoring',
    'tableStickyHeader', 'restoreReadingPosition', 'largeDocumentOptimization'
  ]) {
    const selector = `.more-tools-panel [data-action="${action}"]`;
    if (await page.$eval(selector, button => (button as HTMLButtonElement).disabled)) continue;
    await page.click(selector);
    assert.equal(await page.$eval('.more-tools-panel', panel => (panel as HTMLElement).hidden), false, action);
  }
  for (const selector of [
    '.preview-show-comments [data-preview-comments="false"]'
  ]) {
    const segmentSpacing = await page.$eval(selector, button => {
      const outer = button.getBoundingClientRect();
      const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
      return { horizontal: (outer.width - content.width) / 2, vertical: (outer.height - content.height) / 2 };
    });
    assert.ok(Math.abs(segmentSpacing.horizontal - segmentSpacing.vertical) <= 3, `${selector}: ${JSON.stringify(segmentSpacing)}`);
  }
  const settingsLayout = await page.evaluate(() => {
    const controls = [
      '.editor-appearance-control', '.ui-language-control', '.editor-font-size-mode-control'
    ].map(selector => document.querySelector<HTMLElement>(selector)!);
    return {
      controls: controls.map(control => ({
        left: control.getBoundingClientRect().left,
        right: control.getBoundingClientRect().right,
        configuredWidth: control.style.width,
        optionWidths: Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button'))
          .map(button => button.getBoundingClientRect().width),
        contentFits: Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button'))
          .every(button => {
            const content = button.querySelector<HTMLElement>('.segmented-control-button-content')!.getBoundingClientRect();
            const bounds = button.getBoundingClientRect();
            return content.left >= bounds.left && content.right <= bounds.right;
          })
      })),
      stepperRight: document.querySelector<HTMLElement>('.editor-font-size-stepper')!.getBoundingClientRect().right,
      stepperLeft: document.querySelector<HTMLElement>('.editor-font-size-stepper')!.getBoundingClientRect().left,
      modeWidth: document.querySelector<HTMLElement>('.mode-group')!.style.width
    };
  });
  assert.equal(settingsLayout.modeWidth, '170px');
  assert.ok(settingsLayout.controls.every(control => control.configuredWidth === '100%' && control.contentFits), JSON.stringify(settingsLayout));
  assert.ok(Math.max(...settingsLayout.controls.map(control => control.left))
    - Math.min(...settingsLayout.controls.map(control => control.left)) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.controls[0].right - settingsLayout.controls[1].right) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.controls[1].right - settingsLayout.stepperRight) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(Math.abs(settingsLayout.stepperLeft - settingsLayout.controls[2].right - 4) <= 0.5, JSON.stringify(settingsLayout));
  assert.ok(settingsLayout.controls.every(control => Math.max(...control.optionWidths) - Math.min(...control.optionWidths) <= 0.5), JSON.stringify(settingsLayout));
  const segmentGaps = await page.$eval('.preview-show-comments', control => {
    const outer = control.querySelector<HTMLElement>('.segmented-control')!.getBoundingClientRect();
    const indicators = Array.from(control.querySelectorAll<HTMLElement>('.segmented-control-button-indicator'))
      .map(element => element.getBoundingClientRect());
    return {
      outerLeft: indicators[0].left - outer.left,
      between: indicators[1].left - indicators[0].right,
      outerRight: outer.right - indicators[1].right
    };
  });
  assert.deepEqual(segmentGaps, { outerLeft: 2, between: 0, outerRight: 2 });
  await page.mouse.click(4, 10);
  assert.equal(await page.$eval('.more-tools-panel', panel => (panel as HTMLElement).hidden), true);
  await page.close();
  console.log('Toolbar menus browser test passed.');
} finally {
  await browser.close();
}
