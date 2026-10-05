import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
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
          html:'<p><a href="https://example.com" title="Link explanation">Reference</a></p>',
          hasMermaid:false,styles:{light:'body{font:18px serif}',dark:'body{font:18px serif}'}
        }}
      }})));
    }});
  ` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '# Tooltip fixture\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n\n```mermaid\ngraph TD\nA-->B\n```\n\n$$\nx^2\n$$\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\nAfter table.\n\n[Reference](https://example.com \"Link explanation\").';
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
    await page.hover(selector);
    await page.waitForFunction(selector => {
      const id = document.querySelector(selector)?.getAttribute('aria-describedby');
      return !!id && document.getElementById(id)?.classList.contains('is-visible');
    }, {}, selector);
    return page.$eval(selector, element => {
      const hint = document.getElementById(element.getAttribute('aria-describedby')!)!;
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
  await page.keyboard.press('Tab');
  await page.focus(stateful);
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
    text: 'Link explanation', background: 'rgb(58, 58, 58)', size: '12px',
    bodyFont: before.font, bodySize: before.size, documentTheme: before.theme
  }, 'Preview hints use the UI theme without changing the document theme or font');
  await show(find);
  assert.equal(await frame.$('.meo-tooltip.is-visible'), null, 'parent and Preview share one active hint');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Production tooltips: delay, stateful pointer/keyboard updates, mode focus feedback, dismissal, toolbar/menu scope, fullscreen controls, boundary placement and Preview theme isolation passed.');
} finally {
  await browser.close();
}
