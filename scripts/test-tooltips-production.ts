import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let phase = 'startup';
let failurePage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
try {
  const page = await browser.newPage();
  failurePage = page;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 780 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: `
    window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){
      if(message.type!=='requestPreviewRender') return;
      // The Host fixture supplies reading HTML; iframe binding remains the production path.
      queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:{
        type:'previewRenderResult',requestId:message.requestId,
        result:{ok:true,value:{
          html:'<p><a href="https://example.com" title="Link explanation">Reference</a></p><p><a id="fragment-link" href="#%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E">安装说明</a></p><p><a id="plain-link" href="https://example.com/docs?section=setup#install">Documentation</a></p><h2 id="安装说明">安装说明</h2>',
          hasMermaid:false,styles:{light:'body{font:18px serif}',dark:'body{font:18px serif}'}
        }}
      }})));
    }});
  ` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '# Tooltip fixture\n\n[Encoded anchor](#%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E)\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n\n```mermaid\ngraph TD\nA-->B\n```\n\n$$\nx^2\n$$\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\nAfter table.\n\n[Reference](https://example.com \"Link explanation\").';
  await page.evaluate(text => {
    const g = window as any;
    const preferences = { input: { ...g.EditingSettingsHarness.defaultInputAssistance }, shortcuts: {} };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///tooltips.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
      uiLanguagePreference: 'en', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
      previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
      previewShowComments: false, editorAppearance: 'dark', gitChangesGutter: false,
      gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
      fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
      outlineVisible: false, outlineWidth: 260, vscodeTheme: null,
      editingPreferences: preferences, editingPreferencesRevision: 0
    } }));
  }, text);
  await page.waitForSelector('.cm-editor.meo-mode-live');
  await page.waitForFunction(() => !document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar'));

  const show = async (selector: string) => {
    phase = 'hover ' + selector;
    await page.hover(selector);
    await page.waitForFunction(selector => {
      return [...document.querySelectorAll(selector)].some(element => {
        const id = element.getAttribute('aria-describedby') ?? ((element as HTMLElement).isContentEditable ? element.closest('.cm-editor')?.getAttribute('aria-describedby') : null);
        return !!id && document.getElementById(id)?.classList.contains('is-visible');
      });
    }, {}, selector);
    return page.$$eval(selector, elements => {
      const described = (element: Element) => element.getAttribute('aria-describedby') ?? ((element as HTMLElement).isContentEditable ? element.closest('.cm-editor')?.getAttribute('aria-describedby') : null) ?? '';
      const element = elements.find(element => document.getElementById(described(element))?.classList.contains('is-visible'))!;
      const hint = document.getElementById(described(element))!;
      const rect = hint.getBoundingClientRect();
      return {
        text: hint.querySelector('.meo-tooltip-label')!.textContent,
        shortcut: hint.querySelector('kbd:not([hidden])')?.textContent ?? null,
        side: hint.dataset.side,
        nativeTitle: element.getAttribute('title'),
        visibleCount: document.querySelectorAll('.meo-tooltip.is-visible').length,
        inside: rect.left >= 8 && rect.right <= innerWidth - 8 && rect.top >= 8 && rect.bottom <= innerHeight - 8
      };
    });
  };
  const encodedAnchor = '.meo-md-link-open-btn[data-tooltip="#%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E"]';
  assert.equal((await show(encodedAnchor)).text, 'Go to: #安装说明', 'encoded Chinese anchors display readable text');
  assert.equal(await page.$eval(encodedAnchor, element => (element as HTMLElement).dataset.tooltipLinkHref), '#%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E', 'display formatting preserves the navigation target');
  await page.mouse.move(0, 0);

  const find = '[data-action="find"]';
  const timing = await page.$eval(find, element => {
    const start = performance.now();
    element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const id = element.getAttribute('aria-describedby')!;
    return { start, visible: document.getElementById(id)!.classList.contains('is-visible') };
  });
  assert.equal(timing.visible, false, 'hover does not show the hint immediately');
  await page.waitForFunction(() => !!document.querySelector('.meo-tooltip.is-visible'));
  assert.ok(await page.evaluate(start => performance.now() - start >= 180, timing.start), 'hover uses the shared 200ms delay');
  assert.deepEqual(await show(find), {
    text: 'Find and replace', shortcut: 'Ctrl + F', side: 'bottom', nativeTitle: null, visibleCount: 1, inside: true
  });
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null);
  await page.mouse.move(0, 0);

  const toolbarTable = '[data-action="table"]';
  const toolbarHint = await show(toolbarTable);
  assert.equal(toolbarHint.side, 'right', 'only the toolbar table entry explicitly prefers right');
  assert.equal(toolbarHint.text, 'Insert table');
  assert.equal(toolbarHint.inside, true);
  const toolbarGeometry = await page.$eval(toolbarTable, element => {
    const hint = document.getElementById(element.getAttribute('aria-describedby')!)!.getBoundingClientRect();
    const button = element.getBoundingClientRect(), menu = document.querySelector('.table-dropdown')!.getBoundingClientRect();
    return {
      anchored: Math.abs(hint.left - button.right - 6) < 1,
      overlapsMenu: hint.left < menu.right && hint.right > menu.left && hint.top < menu.bottom && hint.bottom > menu.top
    };
  });
  assert.deepEqual(toolbarGeometry, { anchored: true, overlapsMenu: false });
  await page.mouse.move(0, 0);

  await page.waitForSelector('.meo-md-html-table-shell tbody textarea');
  await page.focus('.meo-md-html-table-shell tbody textarea');
  const trigger = '.meo-md-html-table-context-trigger';
  const triggerHint = await show(trigger);
  assert.equal(triggerHint.side, 'top', 'the document table trigger uses automatic placement');
  assert.equal(await page.$eval(trigger, element => element.getAttribute('data-tooltip-placement')), null);
  await page.click(trigger);
  const menu = '.meo-md-html-table-context-menu:not([hidden])';
  await page.waitForSelector(menu);
  const menuButton = menu + ' [data-command="insert-row-below"]';
  const menuHint = await show(menuButton);
  assert.equal(menuHint.side, 'top', 'ordinary document table actions automatically prefer available space above');
  assert.equal(menuHint.inside, true);
  assert.equal(await page.$eval(menuButton, element => element.getAttribute('data-tooltip-placement')), null);
  assert.equal(menuHint.visibleCount, 1);
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);

  // Exercise boundary handling through the same delegated binder used by production controls.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'edge-tooltip';
    button.dataset.tooltip = 'Boundary action';
    button.dataset.tooltipPlacement = 'right';
    button.style.cssText = 'position:fixed;left:1060px;top:360px;width:24px;height:24px;z-index:700';
    document.body.append(button);
  });
  assert.equal((await show('#edge-tooltip')).side, 'left', 'a requested side flips when it cannot fit');
  await page.$eval('#edge-tooltip', element => {
    element.removeAttribute('data-tooltip-placement');
    (element as HTMLElement).style.left = '0px';
    (element as HTMLElement).style.top = '8px';
  });
  const edgeHint = await show('#edge-tooltip');
  assert.equal(edgeHint.side, 'bottom');
  assert.equal(edgeHint.inside, true, 'automatic hints shift and flip to remain fully visible');
  await page.click('#edge-tooltip');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'click closes the shared hint');
  await page.$eval('#edge-tooltip', element => element.remove());
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'removing a control leaves no visible hint');
  // A stable pointer and the same tooltip instance must survive state changes,
  // including replacement of the icon's descendants.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'stateful-tooltip-probe';
    button.dataset.tooltip = 'Enable fixture sync';
    button.dataset.tooltipLiveUpdate = 'true';
    button.style.cssText = 'position:fixed;left:520px;top:300px;width:32px;height:28px;z-index:700';
    let enabled = false;
    const icon = () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
      button.replaceChildren(svg);
    };
    button.addEventListener('click', () => {
      enabled = !enabled;
      button.dataset.tooltip = enabled ? 'Disable fixture sync' : 'Enable fixture sync';
      icon();
    });
    icon();
    document.body.append(button);
    (window as any).__statefulTooltipChanges = [];
    new MutationObserver(() => {
      const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      (window as any).__statefulTooltipChanges.push({
        text: hint?.querySelector('.meo-tooltip-label')?.textContent,
        visible: hint?.classList.contains('is-visible') ?? false,
        expected: button.dataset.tooltip
      });
    }).observe(button, { attributes: true, attributeFilter: ['data-tooltip'] });
  });
  const stateful = '#stateful-tooltip-probe';
  assert.equal(await page.$eval(stateful, element => {
    element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    return document.getElementById(element.getAttribute('aria-describedby')!)!.classList.contains('is-visible');
  }), false, 'live updates do not remove the initial hover delay');
  await show(stateful);
  const statefulHintId = await page.$eval(stateful, element => element.getAttribute('aria-describedby'));
  const assertCurrentHint = async (selector: string) => {
    const state = await page.$eval(selector, element => {
      const hint = document.getElementById(element.getAttribute('aria-describedby') ?? '');
      return { visible: hint?.classList.contains('is-visible') ?? false, text: hint?.querySelector('.meo-tooltip-label')?.textContent, expected: (element as HTMLElement).dataset.tooltip };
    });
    assert.equal(state.visible, true, `${selector} lost its hint after a state change`);
    assert.equal(state.text, state.expected, `${selector} kept the previous action's hint`);
  };
  for (let index = 0; index < 3; index += 1) {
    await page.mouse.down();
    assert.equal(await page.$eval(stateful, element => document.getElementById(element.getAttribute('aria-describedby')!)!.classList.contains('is-visible')), true, 'pressing a stateful button retains its existing hint');
    await page.mouse.up();
    await assertCurrentHint(stateful);
    assert.equal(await page.$eval(stateful, element => element.getAttribute('aria-describedby')), statefulHintId, 'state changes retain the same tooltip instance');
  }
  assert.equal(await page.evaluate(() => (window as any).__statefulTooltipChanges.length), 3, 'each stationary click commits a new tooltip action');
  assert.equal(await page.evaluate(() => (window as any).__statefulTooltipChanges.every((change: any) => change.visible && change.text === change.expected)), true, 'content is refreshed in the mutation callback without another hover delay');
  await page.keyboard.press('Escape');
  await page.$eval(stateful, element => (element as HTMLElement).dataset.tooltip = 'Updated while dismissed');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'content updates cannot undo Escape dismissal');
  await page.mouse.down(); await page.mouse.up();
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'clicking without a new hover does not undo Escape dismissal');
  await page.mouse.move(0, 0);
  await page.$eval(stateful, element => (element as HTMLElement).dataset.tooltip = 'Updated after leaving');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'content updates after leaving cannot reopen the hint');
  await show(stateful);
  await page.mouse.move(0, 0);
  // Tab from an unfocused body can retain pointer modality. Start at a real
  // toolbar control and verify native keyboard focus before entering the probe.
  phase = 'stateful keyboard hint';
  await page.focus(find);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.matches(':focus-visible')), true,
    'native Tab must establish keyboard focus');
  await page.focus(stateful);
  assert.equal(await page.$eval(stateful, element => element.matches(':focus-visible')), true,
    'the stateful probe must receive keyboard focus');
  await page.waitForFunction(() => !!document.querySelector('.meo-tooltip.is-visible'));
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    await assertCurrentHint(stateful);
  }
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.$eval(stateful, element => (element as HTMLElement).dataset.tooltip = 'Updated after window blur');
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'window blur prevents content updates from reopening a hint');
  await page.$eval(stateful, element => element.remove());
  assert.equal(await page.$('#' + statefulHintId), null, 'disposing a stateful control removes its hint');

  for (const kind of ['mermaid', 'latex-math']) {
    const selector = `.meo-${kind}-mode-btn`;
    await page.mouse.move(0, 0);
    const restingStyle = await page.$eval(selector, element => ({
      background: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).color
    }));
    await page.hover(kind === 'mermaid' ? '.meo-mermaid-block' : '.meo-latex-math-viewport');
    await show(selector);
    const hintId = await page.$eval(selector, element => element.getAttribute('aria-describedby'));
    for (let index = 0; index < 3; index += 1) {
      const previous = await page.$eval(selector, element => (element as HTMLElement).dataset.tooltip);
      await page.mouse.down(); await page.mouse.up();
      await page.waitForFunction(({ selector, previous }) => (document.querySelector(selector) as HTMLElement)?.dataset.tooltip !== previous, {}, { selector, previous });
      await assertCurrentHint(selector);
      assert.equal(await page.$eval(selector, element => element.getAttribute('aria-describedby')), hintId);
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(0, 0);
    const afterPointerLeave = await page.$eval(selector, element => ({
      hovered: element.matches(':hover'), background: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).color
    }));
    assert.equal(afterPointerLeave.hovered, false);
    assert.deepEqual({ background: afterPointerLeave.background, color: afterPointerLeave.color }, restingStyle, 'pointer mode changes must not retain focus highlighting after leaving');
    assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'leaving a pointer-operated mode button dismisses its hint');
    await page.keyboard.press('Tab');
    phase = kind + ' keyboard mode updates';
    await page.focus(selector);
    await page.waitForFunction(selector => {
      const button = document.querySelector(selector)!;
      return document.getElementById(button.getAttribute('aria-describedby')!)?.classList.contains('is-visible');
    }, {}, selector);
    assert.equal(await page.$eval(selector, element => element.matches(':focus-visible') && getComputedStyle(element).backgroundImage !== 'none'), true, 'keyboard navigation retains visible focus feedback');
    const previous = await page.$eval(selector, element => (element as HTMLElement).dataset.tooltip);
    await page.keyboard.press('Enter');
    await page.waitForFunction(({ selector, previous }) => (document.querySelector(selector) as HTMLElement)?.dataset.tooltip !== previous, {}, { selector, previous });
    if (await page.$eval(selector, element => element.matches(':focus-visible'))) await assertCurrentHint(selector);
    else assert.equal(await page.$eval(selector, element => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.classList.contains('is-visible') ?? false), false, 'moving focus into the source editor closes the button hint');

    const splitHint = await page.$eval(selector, element => (element as HTMLElement).dataset.tooltip);
    await page.click(selector);
    await page.waitForFunction(({ selector, previous }) => (document.querySelector(selector) as HTMLElement)?.dataset.tooltip !== previous, {}, { selector, previous: splitHint });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(0, 0);
    phase = kind + ' keyboard mode updates';
    await page.focus(selector);
    const sourceHint = await page.$eval(selector, element => (element as HTMLElement).dataset.tooltip);
    await page.keyboard.press('Enter');
    await page.waitForFunction(({ selector, previous }) => {
      const button = document.querySelector(selector) as HTMLElement;
      return button?.dataset.tooltip !== previous && button.matches(':focus-visible');
    }, {}, { selector, previous: sourceHint });
    assert.equal(await page.$eval(selector, element => getComputedStyle(element).backgroundImage !== 'none'), true, 'keyboard return to preview retains the focused button highlight');
  }
  await page.hover('.meo-mermaid-block');
  await page.click('.meo-mermaid-toolbar [aria-label="Fullscreen"]');
  await page.waitForSelector('.meo-mermaid-fullscreen-controls');
  for (const label of ['Zoom in', 'Zoom out', 'Reset zoom', 'Exit fullscreen']) {
    const selector = `.meo-mermaid-fullscreen-controls [aria-label="${label}"]`;
    assert.equal(await page.$eval(selector, element => (element as HTMLElement).dataset.tooltip), label, 'fullscreen controls use the localized shared tooltip');
    const hint = await show(selector);
    assert.equal(hint.text, label);
    assert.equal(hint.nativeTitle, null);
    assert.equal(hint.visibleCount, 1);
    assert.equal(hint.inside, true, 'fullscreen hints stay within the viewport');
    assert.equal(await page.$eval(selector, element => !!document.getElementById(element.getAttribute('aria-describedby')!)?.closest('.meo-mermaid-fullscreen-scrim')), true, 'the hint belongs to the fullscreen overlay');
  }
  const fullscreenReset = '.meo-mermaid-fullscreen-controls [aria-label="Reset zoom"]';
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  phase = 'fullscreen keyboard hint';
  await page.focus(fullscreenReset);
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector)!;
    return document.getElementById(button.getAttribute('aria-describedby')!)?.classList.contains('is-visible');
  }, {}, fullscreenReset);
  await assertCurrentHint(fullscreenReset);
  await page.click('.meo-mermaid-exit-btn');
  await page.waitForFunction(() => !document.querySelector('.meo-mermaid-fullscreen-scrim'));
  assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'closing fullscreen removes its active hint');

  await page.click('[data-mode="source"]');
  await page.waitForSelector('.cm-editor.meo-mode-source');
  await page.click('.source-preview-button');
  const sync = '.source-preview-scroll-sync-button';
  await page.waitForSelector(sync, { visible: true });
  await show(sync);
  for (let index = 0; index < 3; index += 1) {
    const previous = await page.$eval(sync, element => (element as HTMLElement).dataset.tooltip);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(previous => (document.querySelector('.source-preview-scroll-sync-button') as HTMLElement)?.dataset.tooltip !== previous, {}, previous);
    await assertCurrentHint(sync);
  }
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  phase = 'scroll sync keyboard hint';
  await page.focus(sync);
  await page.waitForFunction(() => {
    const button = document.querySelector('.source-preview-scroll-sync-button')!;
    return document.getElementById(button.getAttribute('aria-describedby')!)?.classList.contains('is-visible');
  });
  for (const key of ['Enter', 'Space']) {
    const previous = await page.$eval(sync, element => (element as HTMLElement).dataset.tooltip);
    await page.keyboard.press(key);
    await page.waitForFunction(previous => (document.querySelector('.source-preview-scroll-sync-button') as HTMLElement)?.dataset.tooltip !== previous, {}, previous);
    await assertCurrentHint(sync);
  }
  await page.click('.source-preview-button');
  await page.click('[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe.preview-frame')?.contentDocument?.querySelector('a'));
  const iframe = await page.$('iframe.preview-frame');
  const frame = (await iframe!.contentFrame())!;
  const before = await frame.$eval('body', element => ({
    font: getComputedStyle(element).fontFamily,
    size: getComputedStyle(element).fontSize,
    theme: element.ownerDocument.documentElement.getAttribute('data-editor-appearance')
  }));
  await frame.hover('a');
  try {
    await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('iframe.preview-frame')?.contentDocument?.querySelector('.meo-tooltip.is-visible'), { timeout: 5000 });
  }
  catch (error) {
    throw new Error('Preview hint did not appear: ' + JSON.stringify(await frame.evaluate(() => ({
      title: document.querySelector('a')?.getAttribute('title'),
      tooltip: document.querySelector<HTMLElement>('a')?.dataset.tooltip,
      styles: document.querySelectorAll('[data-meo-tooltip-style]').length,
      hints: document.querySelectorAll('.meo-tooltip').length,
      theme: document.documentElement.dataset.meoTooltipAppearance,
      viewport: [innerWidth, innerHeight],
      anchor: document.querySelector('a')?.getBoundingClientRect().toJSON(),
      hint: document.querySelector('.meo-tooltip')?.getBoundingClientRect().toJSON(),
      hintClass: document.querySelector('.meo-tooltip')?.className,
      frame: frameElement?.getBoundingClientRect().toJSON(),
      clip: frameElement?.parentElement?.getBoundingClientRect().toJSON()
    }))), { cause: error });
  }
  const nestedHint = await frame.$eval('.meo-tooltip.is-visible', element => ({
    text: element.textContent,
    background: getComputedStyle(element).backgroundColor,
    size: getComputedStyle(element).fontSize,
    bodyFont: getComputedStyle(document.body).fontFamily,
    bodySize: getComputedStyle(document.body).fontSize,
    documentTheme: document.documentElement.getAttribute('data-editor-appearance')
  }));
  assert.deepEqual(nestedHint, {
    text: 'Go to: https://example.com\nLink explanation', background: 'rgb(58, 58, 58)', size: '12px',
    bodyFont: before.font, bodySize: before.size, documentTheme: before.theme
  }, 'Preview hints use the UI theme without changing the document theme or font');
  await show(find);
  assert.equal(await frame.$('.meo-tooltip.is-visible'), null, 'parent and Preview share one active hint');

  const longHref = 'https://example.com/docs?section=' + 'installation-'.repeat(24) + '#setup';
  const encodedHref = '#%E5%AE%89%E8%A3%85%E8%AF%B4%E6%98%8E';
  const encodedFileHref = './%E4%B8%AD%E6%96%87.md?section=%E5%AE%89%E8%A3%85%2F%23%3F%26#%E8%AF%B4%E6%98%8E';
  const readableFileHref = './中文.md?section=安装%2F%23%3F%26#说明';
  const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="100%" height="100%" fill="gray"/></svg>');
  const linkText = '# 安装说明\n\n[Documentation](' + longHref + ')\n\n[安装说明](#安装说明)\n\n<div><a href="' + encodedFileHref + '" title="Author explanation">Guide</a> <a href="https://example.com/%E5%ZZ">Malformed URI</a></div>\n\n| Link |\n| --- |\n| [Table link](' + encodedHref + ') |\n\n[![Linked image](' + image + ')](https://example.com/picture#details)';
  await page.click('[data-mode="live"]');
  await page.evaluate(text => {
    const editor = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: 0 } });
  }, linkText);
  for (const language of ['en', 'zh-CN']) for (const appearance of ['light', 'dark']) {
    phase = language + '/' + appearance + ' link destinations';
    await page.click('.more-tools-wrapper > .format-button');
    await page.click(`[data-ui-language="${language}"]`);
    await page.click(`[data-editor-appearance="${appearance}"]`);
    await page.click('.more-tools-wrapper > .format-button');
    assert.equal(await page.evaluate(() => document.documentElement.lang), language);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.editorAppearance), appearance);
    // Unchanged document widgets retain their DOM across panel-language changes.
    // Remount them to check each language's accessible names at creation.
    await page.click('[data-mode="source"]');
    await page.click('[data-mode="live"]');
    const prefix = language === 'en' ? 'Go to: ' : '跳转到：';
    const destinations = [
      { selector: `.meo-md-link-open-btn[data-tooltip="${longHref}"]`, text: longHref },
      { selector: '.meo-md-link-open-btn[data-tooltip="#安装说明"]', text: '#安装说明' },
      { selector: `.meo-md-html-link[data-meo-link-href="${encodedFileHref}"]`, text: readableFileHref + '\nAuthor explanation', modifier: true },
      { selector: '.meo-md-html-link[data-meo-link-href="https://example.com/%E5%ZZ"]', text: 'https://example.com/%E5%ZZ', modifier: true },
      { selector: `.meo-md-html-table-cell-preview .meo-md-link[data-meo-link-href="${encodedHref}"]`, text: '#安装说明', modifier: true },
      { selector: '.meo-md-image-linked', text: 'https://example.com/picture#details' },
      { selector: '.meo-md-image-linked .meo-md-image-controls button', text: 'https://example.com/picture#details' }
    ];
    for (const destination of destinations) {
      if (destination.modifier) await page.keyboard.down('Control');
      const hint = await show(destination.selector);
      assert.equal(hint.text, prefix + destination.text, phase + ': ' + destination.selector);
      assert.equal(hint.shortcut, null);
      assert.equal(hint.inside, true, 'the full destination fits inside the viewport');
      const width = await page.$eval('.meo-tooltip.is-visible', element => element.getBoundingClientRect().width);
      assert.ok(width <= 320, 'link targets retain their maximum width');
      if (destination.text === longHref) assert.equal(width, 320, 'long destinations wrap at the width limit');
      if (destination.text === '#安装说明') assert.ok(width < 160, 'short anchors do not leave an empty fixed-width panel');
      await page.mouse.move(0, 0);
      if (destination.modifier) await page.keyboard.up('Control');
    }
    const textLinks = [
      `.cm-line .meo-md-link[data-meo-link-href="${longHref}"]`,
      `.meo-md-html-link[data-meo-link-href="${encodedFileHref}"]`,
      `.meo-md-html-table-cell-preview .meo-md-link[data-meo-link-href="${encodedHref}"]`
    ];
    for (const selector of textLinks) {
      phase = language + '/' + appearance + ' text hover ' + selector;
      await page.hover(selector);
      await new Promise(resolve => setTimeout(resolve, 260));
      assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'plain Live text hover is for editing');
      for (const modifier of ['Control', 'Meta'] as const) {
        await page.keyboard.down(modifier);
        await page.waitForSelector('.meo-tooltip.is-visible');
        assert.ok((await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent))?.startsWith(prefix), 'stationary modifier hover shows the destination');
        for (const extra of ['Alt', 'Shift'] as const) {
          await page.keyboard.down(extra);
          assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'extra modifiers cancel the link gesture');
          await page.keyboard.up(extra);
          await page.waitForSelector('.meo-tooltip.is-visible');
        }
        await page.keyboard.up(modifier);
        assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'modifier release immediately dismisses the target');
      }
      await page.mouse.move(0, 0);
      await page.keyboard.down('Control');
      await show(selector);
      await page.keyboard.press('Escape');
      assert.equal(await page.$('.meo-tooltip.is-visible'), null);
      await page.keyboard.up('Control');
      await page.mouse.move(0, 0);
    }
    assert.equal(await page.$eval('.meo-md-link-open-btn[data-tooltip="#安装说明"]', element => element.getAttribute('aria-label')), language === 'en' ? 'Jump within document' : '在文档内跳转');
    phase = language + '/' + appearance + ' editable table target';
    const tableInput = '.meo-md-html-table-shell tbody textarea';
    await page.click(`.meo-md-html-table-cell-preview .meo-md-link[data-meo-link-href="${encodedHref}"]`);
    await page.waitForSelector(tableInput, { visible: true });
    const inputPoint = async (offset: number) => page.$eval(tableInput, (element, offset) => {
      const input = element as HTMLTextAreaElement, computed = getComputedStyle(input), rect = input.getBoundingClientRect();
      const mirror = document.createElement('div');
      for (const property of ['box-sizing', 'padding', 'border', 'font', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'tab-size']) mirror.style.setProperty(property, computed.getPropertyValue(property));
      Object.assign(mirror.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', visibility: 'hidden' });
      const marker = document.createElement('span'); marker.textContent = input.value[offset]!;
      mirror.append(document.createTextNode(input.value.slice(0, offset)), marker, document.createTextNode(input.value.slice(offset + 1)));
      document.body.append(mirror);
      const bounds = marker.getBoundingClientRect(); mirror.remove();
      return { x: bounds.left + bounds.width / 2 - input.scrollLeft, y: bounds.top + bounds.height / 2 - input.scrollTop };
    }, offset);
    const labelPoint = await inputPoint(2);
    await page.mouse.move(labelPoint.x, labelPoint.y);
    await new Promise(resolve => setTimeout(resolve, 260));
    assert.equal(await page.$('.meo-tooltip.is-visible'), null);
    await page.keyboard.down('Control');
    await page.waitForSelector('.meo-tooltip.is-visible');
    assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent), prefix + '#安装说明');
    assert.equal(await page.$eval(tableInput, element => getComputedStyle(element).cursor), 'pointer');
    const markerPoint = await inputPoint(0);
    await page.mouse.move(markerPoint.x, markerPoint.y);
    assert.equal(await page.$('.meo-tooltip.is-visible'), null, 'Markdown delimiters are not link targets');
    assert.equal(await page.$eval(tableInput, element => getComputedStyle(element).cursor), 'text');
    await page.keyboard.up('Control');
    await page.mouse.move(0, 0);
    if (language === 'en' && appearance === 'light') {
      const original = await page.$eval(tableInput, element => (element as HTMLTextAreaElement).value);
      await page.$eval(tableInput, element => {
        (element as HTMLTextAreaElement).value = '[Table link](#changed) plain';
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      });
      const draftPoint = await inputPoint(2);
      await page.mouse.move(draftPoint.x, draftPoint.y);
      await page.keyboard.down('Control');
      await page.waitForSelector('.meo-tooltip.is-visible');
      assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent), 'Go to: #changed', 'the active cell uses its current draft destination');
      await page.keyboard.up('Control');
      await page.$eval(tableInput, (element, original) => {
        (element as HTMLTextAreaElement).value = original;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      }, original);
    }
    const clickPoint = await inputPoint(2);
    await page.mouse.move(clickPoint.x, clickPoint.y);
    await page.keyboard.down('Control');
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor')).state.selection.main.head), 0, 'Ctrl click in an active native table cell navigates to the heading');
    await page.mouse.move(0, 0);
    await page.click('[data-mode="preview"]');
    await frame.waitForSelector('#fragment-link');
    for (const [selector, expected] of [['#fragment-link', '#安装说明'], ['#plain-link', 'https://example.com/docs?section=setup#install'], ['a', 'https://example.com\nLink explanation']]) {
      await frame.hover(selector);
      await frame.waitForSelector('.meo-tooltip.is-visible');
      assert.equal(await frame.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent), prefix + expected);
      const width = await frame.$eval('.meo-tooltip.is-visible', element => element.getBoundingClientRect().width);
      assert.ok(width <= 320);
      if (selector === '#fragment-link') assert.ok(width < 160, 'Preview short anchors are compact too');
      await page.keyboard.down('Control');
      assert.equal(await frame.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent), prefix + expected, 'Preview does not require or suppress modifier hover');
      await page.keyboard.up('Control');
      assert.equal(await frame.$eval('.meo-tooltip.is-visible', element => getComputedStyle(element).backgroundColor), appearance === 'dark' ? 'rgb(58, 58, 58)' : 'rgb(13, 13, 13)');
      await page.mouse.move(0, 0);
    }
    await page.click('[data-mode="live"]');
  }
  phase = 'narrow Preview link width';
  await page.click('[data-mode="preview"]');
  await page.setViewport({ width: 280, height: 780 });
  await frame.hover('#fragment-link');
  await frame.waitForSelector('.meo-tooltip.is-visible');
  const narrow = await frame.$eval('.meo-tooltip.is-visible', element => {
    const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth };
  });
  assert.ok(narrow.width < 320 && narrow.left >= 8 && narrow.right <= narrow.viewport - 8, 'target width stays inside the available reading pane');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Production tooltips: delay, stateful pointer/keyboard updates, mode focus feedback, dismissal, toolbar/menu scope, fullscreen controls, boundary placement and Preview theme isolation passed.');
} catch (error) {
  // Keep the failing interaction and actual geometry in CI timeout reports.
  const state = await failurePage?.evaluate(() => ({
    focusedVisible: document.activeElement?.matches(':focus-visible'),
    focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className,
    hovered: Array.from(document.querySelectorAll(':hover')).map(element => element.className),
    hints: Array.from(document.querySelectorAll('.meo-tooltip.is-visible')).map(element => element.textContent),
    links: Array.from(document.querySelectorAll('[data-meo-link-href]')).map(element => ({ html: element.outerHTML.slice(0, 500), hovered: element.matches(':hover'), described: element.getAttribute('aria-describedby') })),
    descriptions: Array.from(document.querySelectorAll('[aria-describedby]')).map(element => ({ tag: element.tagName, class: element.className, id: element.getAttribute('aria-describedby') })),
    modeButtons: Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-mode-btn,.meo-latex-math-mode-btn')).map(element => ({
      label: element.dataset.tooltip, bounds: element.getBoundingClientRect().toJSON(),
      hovered: element.matches(':hover'), focused: element.matches(':focus-visible')
    }))
  })).catch(() => undefined);
  throw new Error(`Tooltip production check failed during ${phase}: ${JSON.stringify(state)}`, { cause: error });
} finally {
  await browser.close();
}
