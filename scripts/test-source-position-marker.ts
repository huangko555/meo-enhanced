import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.exposeFunction('__renderSourcePositionPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
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
    ...Array.from({ length: 90 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to create a distant Preview position.`
    ))
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
    const railRect = rail.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    const contentLeft = rootRect.left + Number.parseFloat(rootStyle.paddingLeft);
    const color = style.color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const accentProbe = frameDocument.createElement('span');
    accentProbe.style.color = 'var(--meo-link)';
    frameDocument.body.appendChild(accentProbe);
    const accentColor = frameDocument.defaultView!.getComputedStyle(accentProbe).color;
    accentProbe.remove();
    return {
      active: marker.classList.contains('is-active'),
      line: marker.dataset.meoSourcePositionLine,
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
      position: style.position,
      pointerEvents: style.pointerEvents,
      neutralColor: color.length === 3 && Math.max(...color) - Math.min(...color) <= 8,
      softColor: color.length === 3 && Math.min(...color) >= 48 && Math.max(...color) <= 216,
      kind: marker.dataset.meoSourcePositionKind,
      ownerDocument: marker.ownerDocument === frameDocument,
      cursorOnLeft: cursorRect.right <= railRect.left,
      cursorWidth: cursorRect.width,
      cursorOpacity: Number.parseFloat(frameDocument.defaultView!.getComputedStyle(cursor).opacity),
      cursorColor: frameDocument.defaultView!.getComputedStyle(cursor).color,
      accentColor,
      usesTextCursorIcon: cursor.querySelector('svg')?.classList.contains('lucide-text-cursor'),
      railBorderRadius: frameDocument.defaultView!.getComputedStyle(rail).borderRadius,
      markerLeft: marker.getBoundingClientRect().left,
      contentGap: contentLeft - marker.getBoundingClientRect().right
    };
  });
  assert.equal(markerPresentation.active, true);
  assert.equal(markerPresentation.line, '1');
  assert.ok(markerPresentation.width >= 3, JSON.stringify(markerPresentation));
  assert.ok(markerPresentation.height > 1, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.position, 'absolute');
  assert.equal(markerPresentation.pointerEvents, 'none');
  assert.equal(markerPresentation.neutralColor, true, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.softColor, true, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.kind, 'line');
  assert.equal(markerPresentation.ownerDocument, true);
  assert.equal(markerPresentation.cursorOnLeft, true, JSON.stringify(markerPresentation));
  assert.ok(markerPresentation.cursorWidth >= 16, JSON.stringify(markerPresentation));
  assert.ok(markerPresentation.cursorOpacity > 0, JSON.stringify(markerPresentation));
  assert.equal(markerPresentation.cursorColor, markerPresentation.accentColor);
  assert.equal(markerPresentation.usesTextCursorIcon, true);
  assert.equal(markerPresentation.railBorderRadius, '0px');
  assert.ok(markerPresentation.contentGap >= 7, JSON.stringify(markerPresentation));

  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).color.includes('86, 88, 91');
  });
  const lightMarkerColor = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).color;
  });
  assert.match(lightMarkerColor, /rgb\(86, 88, 91\)/);
  await page.$eval('.preview-appearance-select', element => {
    const select = element as HTMLSelectElement;
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const marker = frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')!;
    return frameDocument.defaultView!.getComputedStyle(marker).color.includes('188, 191, 195');
  });

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
        cursorOpacity: Number.parseFloat(frameDocument.defaultView!.getComputedStyle(cursor).opacity)
      };
    }),
    { active: false, cursorOpacity: 0 }
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

  const frameRect = await page.$eval('.preview-frame', element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  const reverseTarget = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = Array.from(frameDocument.querySelectorAll<HTMLElement>('h2[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Section 70')!;
    target.scrollIntoView({ block: 'center' });
    const targetRect = target.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    return {
      line: Number(target.dataset.sourceLine),
      contentLeft: rootRect.left + Number.parseFloat(rootStyle.paddingLeft),
      targetTop: targetRect.top,
      targetHeight: targetRect.height,
      previewTop: frameDocument.scrollingElement!.scrollTop
    };
  });
  await page.mouse.move(4, 4);
  await page.mouse.move(
    frameRect.left + reverseTarget.contentLeft - 14,
    frameRect.top + reverseTarget.targetTop + Math.min(10, reverseTarget.targetHeight / 2)
  );
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return frameDocument.querySelector('.meo-preview-source-navigation.is-visible') !== null;
  });
  const reverseAction = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const navigation = frameDocument.querySelector<HTMLElement>('.meo-preview-source-navigation')!;
    const navigationRect = navigation.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    const accentProbe = frameDocument.createElement('span');
    accentProbe.style.color = 'var(--meo-link)';
    frameDocument.body.appendChild(accentProbe);
    const accentColor = frameDocument.defaultView!.getComputedStyle(accentProbe).color;
    accentProbe.remove();
    return {
      line: Number(navigation.dataset.meoSourceNavigationLine),
      left: navigationRect.left,
      right: navigationRect.right,
      top: navigationRect.top,
      height: navigationRect.height,
      contentLeft: rootRect.left + Number.parseFloat(rootStyle.paddingLeft),
      color: frameDocument.defaultView!.getComputedStyle(navigation).color,
      accentColor,
      usesPenLineIcon: navigation.querySelector('svg')?.classList.contains('lucide-pen-line'),
      markerCursorOpacity: Number.parseFloat(frameDocument.defaultView!.getComputedStyle(
        frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-cursor')!
      ).opacity)
    };
  });
  assert.equal(reverseAction.line, reverseTarget.line, JSON.stringify({ reverseAction, reverseTarget }));
  assert.ok(Math.abs(reverseAction.left - (reverseTarget.contentLeft - 28)) <= 0.5, JSON.stringify(reverseAction));
  assert.ok(Math.abs(reverseAction.right - reverseTarget.contentLeft) <= 0.5, JSON.stringify(reverseAction));
  assert.equal(reverseAction.color, reverseAction.accentColor);
  assert.equal(reverseAction.usesPenLineIcon, true);
  assert.equal(reverseAction.markerCursorOpacity, 0);

  await page.mouse.click(
    frameRect.left + reverseAction.left + 4,
    frameRect.top + reverseAction.top + Math.min(10, reverseAction.height / 2)
  );
  await page.waitForFunction((line) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Number(frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')
      ?.dataset.meoSourcePositionLine) === line;
  }, {}, reverseTarget.line);
  await new Promise(resolve => setTimeout(resolve, 120));
  const reverseResult = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return {
      previewTop: frameDocument.scrollingElement!.scrollTop,
      navigationHidden: frameDocument.querySelector<HTMLElement>('.meo-preview-source-navigation')?.hidden,
      activeSourceText: document.querySelector<HTMLElement>('.cm-activeLine')?.textContent ?? ''
    };
  });
  assert.ok(Math.abs(reverseResult.previewTop - reverseTarget.previewTop) <= 2, JSON.stringify(reverseResult));
  assert.equal(reverseResult.navigationHidden, true);
  assert.match(reverseResult.activeSourceText, /Section 70/);

  const directGutterTarget = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const target = Array.from(frameDocument.querySelectorAll<HTMLElement>('h2[data-source-line]'))
      .find(element => element.textContent?.trim() === 'Section 71')!;
    target.scrollIntoView({ block: 'center' });
    const targetRect = target.getBoundingClientRect();
    const readingRoot = frameDocument.querySelector<HTMLElement>('main.meo-export-doc')!;
    const rootRect = readingRoot.getBoundingClientRect();
    const rootStyle = frameDocument.defaultView!.getComputedStyle(readingRoot);
    return {
      line: Number(target.dataset.sourceLine),
      x: rootRect.left + Number.parseFloat(rootStyle.paddingLeft) - 14,
      y: targetRect.top + Math.min(10, targetRect.height / 2)
    };
  });
  await page.mouse.move(4, 4);
  await page.mouse.move(frameRect.left + directGutterTarget.x, frameRect.top + directGutterTarget.y);
  await page.mouse.click(frameRect.left + directGutterTarget.x, frameRect.top + directGutterTarget.y);
  await page.waitForFunction((line) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Number(frameDocument.querySelector<HTMLElement>('.meo-preview-source-position-marker')
      ?.dataset.meoSourcePositionLine) === line;
  }, {}, directGutterTarget.line);

  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'preview');
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
    .querySelector<HTMLElement>('.meo-preview-source-position-marker')?.hidden), true);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source position marker checks passed');
