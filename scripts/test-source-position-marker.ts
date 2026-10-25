import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-settings-window-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
let previewRenderGate: Promise<void> | null = null;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.exposeFunction('__renderSourcePositionPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    await previewRenderGate;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-position-marker.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__renderSourcePositionPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const text = [
    '# Marker fixture',
    '',
    'The first paragraph stays visible in Source.',
    'A multiline paragraph starts here.\nIts second source line shares one rendered paragraph.',
    '> An indented quotation must not move the Preview locator horizontally.',
    '- An indented list item must use the same Preview locator gutter.',
    '- Reverse locator middle item.',
    '- Reverse locator lower item.',
    '```text\n' + Array.from({ length: 60 }, (_, index) => `Locator code line ${index}`).join('\n') + '\n```',
    ...Array.from({ length: 90 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to create a distant Preview position.`
    )),
    '## Nested locator fixture',
    '- [ ] > A task followed by a quote marker.\n- > - [ ] Nested task for bottom-edge navigation.',
    'Following paragraph keeps the nested task independently scrollable.',
    '<!-- Hidden source-only navigation target -->'
  ].join('\n\n');
  await page.evaluate(text => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///source-position-marker.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
      uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
      previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } }));
  }, text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLElement>('.source-preview-button');
    return button?.offsetParent !== null && getComputedStyle(button).visibility === 'visible';
  });
  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    const previewHost = document.querySelector<HTMLElement>('.preview-host');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && frame?.contentDocument?.body.textContent?.includes('Section 90')
      && previewHost?.inert === false
      && getComputedStyle(previewHost).visibility !== 'hidden'
      && !frame.contentDocument?.querySelector<HTMLElement>('.meo-preview-source-position-marker')?.hidden;
  });
  await new Promise(resolve => setTimeout(resolve, 120));

  const markerPresentation = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const style = frameDocument.defaultView!.getComputedStyle(marker);
    const cursor = marker.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!;
    const rail = marker.querySelector<HTMLElement>('.meo-preview-source-position-rail')!;
    const cursorRect = cursor.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const activeLineBackground = getComputedStyle(document.querySelector<HTMLElement>('.cm-activeLine')!).backgroundColor;
    return {
      active: marker.classList.contains('is-active'),
      line: marker.dataset.meoSourcePositionLine,
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
      position: style.position,
      pointerEvents: style.pointerEvents,
      backgroundColor: style.backgroundColor,
      activeLineBackground,
      zIndex: style.zIndex,
      kind: marker.dataset.meoSourcePositionKind,
      ownerDocument: marker.ownerDocument === frameDocument,
      parentIsReadingRoot: marker.parentElement === readingRoot,
      cursorWidth: cursorRect.width,
      cursorDisplay: frameDocument.defaultView!.getComputedStyle(cursor).display,
      railDisplay: frameDocument.defaultView!.getComputedStyle(rail).display,
      usesTextCursorIcon: cursor.querySelector('svg')?.classList.contains('lucide-text-cursor'),
      railBorderRadius: frameDocument.defaultView!.getComputedStyle(rail).borderRadius,
      markerLeft: marker.getBoundingClientRect().left,
      markerRight: marker.getBoundingClientRect().right,
      positioningWidth: marker.offsetParent!.getBoundingClientRect().width
    };
  });
  assert.equal(markerPresentation.active, true);
  assert.equal(markerPresentation.line, '1');
  assert.ok(markerPresentation.width >= 3, JSON.stringify(markerPresentation));
  assert.ok(markerPresentation.height > 1, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.position, 'absolute');
  assert.equal(markerPresentation.pointerEvents, 'none');
  assert.notEqual(markerPresentation.backgroundColor, 'rgba(0, 0, 0, 0)', 'Preview locator stays visible with a transparent native Source line highlight');
  assert.equal(markerPresentation.zIndex, '-1');
  assert.equal(markerPresentation.kind, 'line');
  assert.equal(markerPresentation.ownerDocument, true);
  assert.equal(markerPresentation.parentIsReadingRoot, true);
  assert.equal(markerPresentation.cursorWidth, 0);
  assert.equal(markerPresentation.cursorDisplay, 'none');
  assert.equal(markerPresentation.railDisplay, 'none');
  assert.equal(markerPresentation.usesTextCursorIcon, true);
  assert.equal(markerPresentation.railBorderRadius, '0px');
  assert.ok(Math.abs(markerPresentation.markerLeft) <= 0.5, JSON.stringify(markerPresentation));
  assert.ok(Math.abs(markerPresentation.markerRight - markerPresentation.positioningWidth) <= 0.5, JSON.stringify(markerPresentation));

  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction((darkBackground) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor !== darkBackground;
  }, {}, markerPresentation.backgroundColor);
  const lightMarkerBackground = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor;
  });
  assert.notEqual(lightMarkerBackground, 'rgba(0, 0, 0, 0)');
  assert.notEqual(lightMarkerBackground, markerPresentation.backgroundColor, 'Preview locator follows the independently selected Preview theme');
  assert.equal(await page.$eval('.cm-activeLine', element => getComputedStyle(element).backgroundColor), markerPresentation.activeLineBackground,
    'Changing Preview theme must not change the native Source line highlight');
  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction((darkBackground) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).backgroundColor === darkBackground;
  }, {}, markerPresentation.backgroundColor);

  const nativeScrollAttachment = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const target = frameDocument.querySelector<HTMLElement>('[data-source-line="1"]')!;
    const before = marker.getBoundingClientRect().top - target.getBoundingClientRect().top;
    frameDocument.scrollingElement!.scrollTop += 80;
    const after = marker.getBoundingClientRect().top - target.getBoundingClientRect().top;
    return { before, after };
  });
  assert.ok(
    Math.abs(nativeScrollAttachment.after - nativeScrollAttachment.before) <= 0.1,
    `Marker must move in the Preview document's native scroll layer: ${JSON.stringify(nativeScrollAttachment)}`
  );

  const multilineSourceTarget = await page.$$eval('.cm-line', elements => {
    const line = elements.find(element => element.textContent?.includes('Its second source line'))!;
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 24, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(multilineSourceTarget.x, multilineSourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const blockProjection = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const line = Number(marker.dataset.meoSourcePositionLine);
    const mapped = Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map(element => ({
        element,
        start: Number(element.dataset.sourceLine),
        end: Number(element.dataset.sourceEndLine ?? element.dataset.sourceLine)
      }))
      .filter(entry => entry.start <= line && entry.end >= line)
      .sort((left, right) => left.start - right.start || right.end - left.end)[0]!;
    const markerRect = marker.getBoundingClientRect();
    const mappedRect = mapped.element.getBoundingClientRect();
    return {
      kind: marker.dataset.meoSourcePositionKind,
      topDelta: markerRect.top - mappedRect.top,
      bottomDelta: markerRect.bottom - mappedRect.bottom
    };
  });
  assert.equal(blockProjection.kind, 'block', JSON.stringify(blockProjection));
  assert.ok(Math.abs(blockProjection.topDelta) <= 0.5, JSON.stringify(blockProjection));
  assert.ok(Math.abs(blockProjection.bottomDelta) <= 0.5, JSON.stringify(blockProjection));

  for (const sourceText of ['An indented quotation', 'An indented list item']) {
    const indentedTarget = await page.$$eval('.cm-line', (elements, expectedText) => {
      const line = elements.find(element => element.textContent?.includes(expectedText))!;
      const rect = line.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + rect.height / 2 };
    }, sourceText);
    await page.mouse.click(indentedTarget.x, indentedTarget.y);
    await new Promise(resolve => setTimeout(resolve, 40));
    const markerLeft = await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!
        .getBoundingClientRect().left;
    });
    assert.ok(
      Math.abs(markerLeft - markerPresentation.markerLeft) <= 0.5,
      `Preview locator must use a fixed horizontal gutter: ${JSON.stringify({ sourceText, markerLeft, expected: markerPresentation.markerLeft })}`
    );
  }

  const sourceTarget = await page.$eval('.cm-line', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
  });
  const movePreviewToBottom = () => page.evaluate(() => {
    const scrollElement = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
    scrollElement.scrollTop = scrollElement.scrollHeight - scrollElement.clientHeight;
    return scrollElement.scrollTop;
  });

  const bottomBeforeKeyboard = await movePreviewToBottom();
  await new Promise(resolve => setTimeout(resolve, 40));
  const lineBeforeKeyboard = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-preview-source-position-marker')!.dataset.meoSourcePositionLine
  ));
  await page.keyboard.press('ArrowDown');
  await new Promise(resolve => setTimeout(resolve, 40));
  const afterKeyboard = await page.evaluate(() => ({
    previewTop: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop,
    markerLine: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-preview-source-position-marker')!.dataset.meoSourcePositionLine
  }));
  assert.notEqual(afterKeyboard.markerLine, lineBeforeKeyboard);
  assert.ok(Math.abs(afterKeyboard.previewTop - bottomBeforeKeyboard) <= 1, JSON.stringify(afterKeyboard));

  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const afterExplicitClick = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    const markerRect = marker.getBoundingClientRect();
    return {
      previewTop: frameDocument.scrollingElement!.scrollTop,
      visible: markerRect.bottom > 0 && markerRect.top < frameDocument.documentElement.clientHeight,
      active: marker.classList.contains('is-active')
    };
  });
  assert.equal(afterExplicitClick.visible, true, JSON.stringify(afterExplicitClick));
  assert.equal(afterExplicitClick.active, true, JSON.stringify(afterExplicitClick));
  assert.ok(afterExplicitClick.previewTop < 100, JSON.stringify(afterExplicitClick));

  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(
    await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
    )),
    afterExplicitClick.previewTop,
    'A repeated click in the visible block must not move Preview'
  );

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.45;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const editingTarget = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const bounds = scroller.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .map(line => ({ line, rect: line.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top >= bounds.top && rect.bottom <= bounds.bottom);
    const candidate = lines[Math.max(0, Math.floor(lines.length * 0.75))]!;
    return { x: candidate.rect.left + 24, y: candidate.rect.top + candidate.rect.height / 2 };
  });
  await movePreviewToBottom();
  await page.mouse.click(editingTarget.x, editingTarget.y);
  await new Promise(resolve => setTimeout(resolve, 80));
  const heldPreviewTop = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  await page.keyboard.type('x');
  await new Promise(resolve => setTimeout(resolve, 240));
  const previewTopAfterTyping = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  assert.ok(
    Math.abs(previewTopAfterTyping - heldPreviewTop) <= 2,
    `Typing after an explicit locate must retain the Preview attention position: ${JSON.stringify({ heldPreviewTop, previewTopAfterTyping })}`
  );

  const sourceScrollerPoint = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(sourceScrollerPoint.x, sourceScrollerPoint.y);
  await page.mouse.wheel({ deltaY: 240 });
  await new Promise(resolve => setTimeout(resolve, 120));
  const previewTopAfterSourceScroll = await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  ));
  assert.ok(
    Math.abs(previewTopAfterSourceScroll - previewTopAfterTyping) > 2,
    'A deliberate Source scroll must release the attention hold and resume linked scrolling'
  );

  const previewBounds = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 80 };
  });
  await page.mouse.click(previewBounds.x, previewBounds.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(
    await page.evaluate(() => {
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const marker = frameDocument.querySelector('.meo-preview-source-position-marker');
      const cursor = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!;
      return {
        active: marker?.classList.contains('is-active'),
        cursorDisplay: frameDocument.defaultView!.getComputedStyle(cursor).display,
        backgroundColor: frameDocument.defaultView!.getComputedStyle(marker!).backgroundColor,
        activeLineBackground: getComputedStyle(document.querySelector<HTMLElement>('.cm-activeLine')!).backgroundColor
      };
    }),
    {
      active: false,
      cursorDisplay: 'none',
      backgroundColor: markerPresentation.backgroundColor,
      activeLineBackground: markerPresentation.activeLineBackground
    }
  );

  await page.click('.source-preview-scroll-sync-button');
  assert.equal(
    await page.$eval('.source-preview-scroll-sync-button', button => button.getAttribute('aria-pressed')),
    'false'
  );
  const independentTop = await movePreviewToBottom();
  await new Promise(resolve => setTimeout(resolve, 40));
  await page.mouse.click(sourceTarget.x, sourceTarget.y);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(Math.abs(await page.evaluate(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
  )) - independentTop) <= 1, 'Independent panes must not auto-locate');

  const alignment = '.meo-preview-viewport-alignment';
  const toPreview = '[data-meo-align-viewport="preview"]';
  const toSource = '[data-meo-align-viewport="source"]';
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    return {
      sourceTop: view.scrollDOM.scrollTop, sourceLeft: view.scrollDOM.scrollLeft,
      previewTop: frame.contentDocument!.scrollingElement!.scrollTop,
      selection: view.state.selection.toJSON(), text: view.state.doc.toString(),
      focus: document.activeElement === view.contentDOM ? 'source' : document.activeElement === frame ? 'preview' : 'other'
    };
  });
  const geometry = () => page.$eval(alignment, element => {
    const rect = element.getBoundingClientRect();
    const frame = document.querySelector('.preview-frame')!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      dividerX: frame.left - 1, frameY: frame.top + frame.height / 2, width: rect.width, height: rect.height };
  });
  const buttons = await page.$$eval(alignment + ' button', buttons => buttons.map(button => ({
    width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
    iconWidth: button.querySelector('svg')!.getBoundingClientRect().width,
    hint: (button as HTMLElement).dataset.tooltip, label: button.getAttribute('aria-label'),
    disabled: (button as HTMLButtonElement).disabled
  })));
  assert.deepEqual(buttons.map(button => [button.width, button.height, button.iconWidth, button.disabled]), [[23, 23, 22, false], [23, 23, 22, false]]);
  assert.deepEqual(buttons.map(button => button.hint), ['Align preview to source view', 'Align source to preview view']);
  assert.ok(buttons.every(button => button.hint === button.label));
  const fixed = await geometry();
  assert.ok(Math.abs(fixed.x - fixed.dividerX) <= 0.5 && Math.abs(fixed.y - fixed.frameY) <= 0.5, JSON.stringify(fixed));
  assert.equal(fixed.width, 26);
  assert.equal(fixed.height, 48);
  const circularTargets = await page.$$eval(alignment + ' button', buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('button') === button;
    return { width: rect.width, height: rect.height, center: hit(rect.left + rect.width / 2, rect.top + rect.height / 2),
      corner: hit(rect.left + 1, rect.top + 1), leftEdge: hit(rect.left + 1, rect.top + rect.height / 2) };
  }));
  assert.ok(circularTargets.every(target => target.width === target.height && target.center && target.leftEdge && !target.corner), 'alignment hit targets must be circles rather than rectangular halves');
  assert.equal(await page.$('.meo-preview-source-navigation'), null, 'the moving locator is removed');

  // The Source caret deliberately stays far away from its visible reading position.
  const expectedPreviewTop = await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = [...doc.querySelectorAll<HTMLElement>('h2[data-source-line]')].find(element => element.textContent === 'Section 45')!;
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from, head: view.state.doc.line(5).to } });
    view.focus();
    view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(Number(target.dataset.sourceLine)).from).top;
    return target.getBoundingClientRect().top + doc.scrollingElement!.scrollTop;
  });
  await settle();
  // The first distant scroll measures wrapped Source lines; place the fixture
  // at the now-measured heading before checking an exact semantic destination.
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = [...doc.querySelectorAll<HTMLElement>('h2[data-source-line]')].find(element => element.textContent === 'Section 45')!;
    view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(Number(target.dataset.sourceLine)).from).top;
  });
  await settle();
  const sourceBefore = await snapshot();
  await page.click(toPreview);
  await settle();
  const sourceAfter = await snapshot();
  assert.deepEqual({ ...sourceAfter, previewTop: sourceBefore.previewTop }, sourceBefore, 'right arrow changes only Preview, retaining Source focus/selection/viewport/text');
  assert.ok(Math.abs(sourceAfter.previewTop - expectedPreviewTop) <= 3, JSON.stringify({ actual: sourceAfter.previewTop, expectedPreviewTop }));
  assert.equal(await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed')), 'false');
  await page.click(toPreview);
  await settle();
  assert.deepEqual(await snapshot(), sourceAfter, 'repeated alignment is stable');
  await page.mouse.move(10, 10);
  assert.deepEqual(await geometry(), fixed, 'caret, hover and scroll do not move or hide the controls');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.meo-preview-source-navigation-highlight')), null);

  const expectedSourceTop = await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const scroll = doc.scrollingElement!;
    const target = [...doc.querySelectorAll<HTMLElement>('h2[data-source-line]')].find(element => element.textContent === 'Section 15')!;
    scroll.scrollTop += target.getBoundingClientRect().top;
    doc.body.focus({ preventScroll: true });
    return view.lineBlockAt(view.state.doc.line(Number(target.dataset.sourceLine)).from).top;
  });
  await settle();
  const previewBefore = await snapshot();
  await page.click(toSource);
  await settle();
  const previewAfter = await snapshot();
  assert.deepEqual({ ...previewAfter, sourceTop: previewBefore.sourceTop }, previewBefore, 'left arrow changes only Source vertical scroll, retaining Preview focus and Source selection');
  assert.ok(Math.abs(previewAfter.sourceTop - expectedSourceTop) <= 3, JSON.stringify({ previewAfter, expectedSourceTop }));
  assert.ok(Math.abs(previewAfter.sourceTop - previewBefore.sourceTop) > 500, 'left arrow must move the distant Source viewport');

  // Subsequent scrolls stay independent; the one-shot action cannot enable linkage.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop += 100;
  });
  await settle();
  assert.equal((await snapshot()).previewTop, previewAfter.previewTop);
  const independentSource = (await snapshot()).sourceTop;
  await page.evaluate(() => { document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop += 140; });
  await settle();
  assert.equal((await snapshot()).sourceTop, independentSource);
  await page.focus(toSource);
  const keyboardBefore = await snapshot();
  await page.keyboard.press('Enter');
  await settle();
  const keyboardAfter = await snapshot();
  assert.equal(keyboardAfter.text, keyboardBefore.text);
  assert.deepEqual(keyboardAfter.selection, keyboardBefore.selection);
  assert.equal(keyboardAfter.previewTop, keyboardBefore.previewTop);
  assert.equal(await page.$eval(toSource, button => button === document.activeElement), true, 'keyboard activation retains its button focus');

  // Each direction also handles the document boundaries without moving its origin.
  for (const boundary of [0, 1]) {
    const sourceBounds = await page.$eval('.cm-scroller', element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(sourceBounds.x, sourceBounds.y);
    // A new native gesture retires the preceding alignment's finite layout
    // correction before preparing an exact boundary fixture.
    await page.mouse.wheel({ deltaY: boundary ? 100_000 : -100_000 });
    await page.evaluate(boundary => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      scroller.scrollTop = boundary * (scroller.scrollHeight - scroller.clientHeight);
    }, boundary);
    await settle();
    await page.click(toPreview);
    await settle();
    const remainingPreview = await page.evaluate(boundary => {
      const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
      return Math.abs(scroll.scrollTop - boundary * (scroll.scrollHeight - scroll.clientHeight));
    }, boundary);
    assert.ok(remainingPreview <= 2, 'Source boundary aligns Preview boundary: ' + remainingPreview);
    await page.evaluate(boundary => {
      const scroll = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
      scroll.scrollTop = (1 - boundary) * (scroll.scrollHeight - scroll.clientHeight);
    }, boundary);
    await settle();
    await page.click(toSource);
    await settle();
    const remainingSource = await page.$eval('.cm-scroller', (element, boundary) => {
      return Math.abs(element.scrollTop - (1 - boundary) * (element.scrollHeight - element.clientHeight));
    }, boundary);
    assert.ok(remainingSource <= 2, 'Preview boundary aligns Source boundary: ' + remainingSource);
  }
  await page.hover(toPreview);
  await page.waitForFunction(() => document.querySelector('.meo-tooltip.is-visible')?.textContent?.includes('Align preview to source view'));
  const hintPosition = await page.$eval('.meo-tooltip.is-visible', element => element.getBoundingClientRect().toJSON());
  const buttonRect = await page.$eval(toPreview, element => element.getBoundingClientRect().toJSON());
  await page.mouse.move(buttonRect.left + 6, buttonRect.top + 6);
  await settle();
  const movedHint = await page.$eval('.meo-tooltip.is-visible', element => element.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(movedHint.x - hintPosition.x) <= 0.5 && Math.abs(movedHint.y - hintPosition.y) <= 0.5, 'tooltips stay anchored to the button');

  let releasePreviewRender!: () => void;
  previewRenderGate = new Promise(resolve => { releasePreviewRender = resolve; });
  await page.evaluate(() => {
    const view = (window as any).EditingSettingsHarness.EditorView.findFromDOM(document.querySelector('.editor-host > .cm-editor'));
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\nFresh render check' } });
  });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('.meo-preview-viewport-align-button')].every(button => button.disabled));
  const staleViews = await snapshot();
  await page.$eval(toPreview, element => (element as HTMLButtonElement).click());
  await settle();
  assert.deepEqual(await snapshot(), staleViews, 'an outdated Preview cannot move either view');
  releasePreviewRender();
  previewRenderGate = null;
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.meo-preview-viewport-align-button')!.disabled
    && document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body.textContent?.includes('Fresh render check'));

  // Resuming automatic sync follows the last manual action's origin (Preview).
  await page.click(toSource);
  await settle();
  const resumeOrigin = await snapshot();
  await page.evaluate(() => { document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop -= 100; });
  await settle();
  await page.click('.source-preview-scroll-sync-button');
  await settle();
  assert.equal(await page.$eval(alignment, element => (element as HTMLElement).hidden), true, 'automatic sync hides both manual actions');
  const resumed = await snapshot();
  assert.ok(Math.abs(resumed.sourceTop - resumeOrigin.sourceTop) <= 2 && resumed.previewTop === resumeOrigin.previewTop, 'resuming sync retains the last manual origin');
  await page.click('.source-preview-scroll-sync-button');
  assert.equal(await page.$eval(alignment, element => (element as HTMLElement).hidden), false);
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  assert.equal(await page.$eval(alignment, element => (element as HTMLElement).hidden), true, 'full Preview has no divider actions');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source position marker checks passed');
