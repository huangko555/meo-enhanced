import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-input-cursor-navigation-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 10): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-input-cursor-navigation-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = Array.from({ length: 320 }, (_, index) => {
      if (index === 159) return `line 160 ${'wrapped-segment '.repeat(280)}`;
      if (index === 219) return '| Rich A | Rich B |';
      if (index === 220) return '| --- | --- |';
      if (index === 221) return '| rendered table target | value |';
      if (index === 222) return '| rendered table next | value |';
      return index === 279
        ? `line ${index + 1} unique-navigation-target`
        : `line ${index + 1} ordinary content`;
    }).join('\n');
    const staleTrace = await page.evaluate(async (documentText) => {
      const create = (window as any).__createInputCursorEditor;
      const editor = create({
        parent: document.getElementById('app'),
        text: documentText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__inputCursorEditor = editor;
      const result = editor.findNext('unique-navigation-target', { focusEditor: true });
      const scroller = editor.getScrollElement();
      scroller.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -640,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL
      }));
      scroller.scrollTop = 0;
      const frames: Array<{
        frame: number;
        scrollTop: number;
        focused: boolean;
        selectionText: string;
      }> = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          frame,
          scrollTop: scroller.scrollTop,
          focused: editor.hasFocus(),
          selectionText: document.getSelection()?.toString() ?? ''
        });
      }
      return {
        found: result?.found ?? false,
        scrollTop: scroller.scrollTop,
        text: editor.getText(),
        focused: editor.hasFocus(),
        frames
      };
    }, text);
    if (
      !staleTrace.found || staleTrace.scrollTop !== 0 || staleTrace.text !== text || !staleTrace.focused ||
      staleTrace.frames.some((frame) => frame.scrollTop !== 0 || !frame.focused)
    ) {
      throw new Error(`Stale navigation wrote during the continuous frame trace: ${JSON.stringify(staleTrace)}`);
    }

    const settled = await page.evaluate(() => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        scrollTop: scroller.scrollTop,
        text: editor.getText(),
        focused: editor.hasFocus(),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom)
      };
    });
    if (settled.scrollTop !== 0 || settled.text !== text || !settled.focused) {
      throw new Error(`A stale command reveal overrode the later wheel interaction: ${JSON.stringify(settled)}`);
    }
    const searchSelection = await page.evaluate(() => (
      (window as any).__inputCursorEditor.replaceCurrent(
        'unique-navigation-target',
        'unique-navigation-target'
      )
    ));
    if (!searchSelection.replaced) {
      throw new Error(`Continuous trace lost the search Selection: ${JSON.stringify(searchSelection)}`);
    }

    await page.evaluate(() => (window as any).__inputCursorEditor.scrollToLine(120, 'top'));
    await waitForFrames(page, 4);
    const selectionOnlyLayout = await page.evaluate(async () => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const before = editor.getTopVisiblePosition();
      const beforeScrollTop = scroller.scrollTop;
      const frames: Array<{ frame: number; line: number; scrollTop: number }> = [];
      editor.preserveViewport(() => { scroller.scrollTop += 240; });
      editor.revealSelection(editor.getText().length, editor.getText().length, {
        focusEditor: false,
        align: 'none'
      });
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          frame,
          line: editor.getTopVisiblePosition().line,
          scrollTop: scroller.scrollTop
        });
      }
      return { before, beforeScrollTop, after: editor.getTopVisiblePosition(), frames };
    });
    if (
      Math.abs(selectionOnlyLayout.after.line - selectionOnlyLayout.before.line) > 1 ||
      Math.abs(selectionOnlyLayout.frames.at(-1)!.scrollTop - selectionOnlyLayout.beforeScrollTop) > 1
    ) {
      throw new Error(
        `Selection-only reveal cancelled the active layout owner: ${JSON.stringify(selectionOnlyLayout)}`
      );
    }

    const replacementPosition = text.indexOf('line 40 ordinary content') + 'line 40 '.length;
    await page.evaluate(() => (window as any).__inputCursorEditor.setMode('source'));
    await waitForFrames(page, 4);
    await page.evaluate((position) => (
      (window as any).__inputCursorEditor.revealSelection(
        position,
        position,
        { focusEditor: true, align: 'nearest' }
      )
    ), replacementPosition);
    await waitForFrames(page, 4);
    const sourceScrollBeforeInput = await page.evaluate(() => (
      (window as any).__inputCursorEditor.getScrollElement().scrollTop
    ));
    await page.keyboard.type('A');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await page.keyboard.type('BC');
    await waitForFrames(page, 2);
    const sourceInput = await page.evaluate(({ position, beforeScroll }) => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        replacement: editor.getText().slice(position, position + 2),
        scrollDelta: Math.abs(scroller.scrollTop - beforeScroll),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom),
        focused: editor.hasFocus()
      };
    }, { position: replacementPosition, beforeScroll: sourceScrollBeforeInput });
    if (
      sourceInput.replacement !== 'BC' || sourceInput.scrollDelta > 1 ||
      !sourceInput.cursorVisible || !sourceInput.focused
    ) {
      throw new Error(`Visible Source replacement moved or lost the caret: ${JSON.stringify(sourceInput)}`);
    }

    const wrappedPosition = text.indexOf('line 160 ') + 'line 160 '.length + 'wrapped-segment '.repeat(270).length;
    await page.evaluate((position) => {
      (window as any).__inputCursorEditor.revealSelection(position, position, {
        focusEditor: true,
        align: 'center'
      });
    }, wrappedPosition);
    await waitForFrames(page, 4);
    const tallWrapped = await page.evaluate(async (position) => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const readCaret = () => {
        const selection = document.getSelection();
        return selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      };
      const centeredCaret = readCaret();
      const viewport = scroller.getBoundingClientRect();
      if (!centeredCaret) throw new Error('Tall wrapped caret had no public DOM range');
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollTop + centeredCaret.bottom - viewport.bottom - 20
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const initialScrollTop = scroller.scrollTop;
      const line = (document.getSelection()?.anchorNode instanceof Element
        ? document.getSelection()?.anchorNode
        : document.getSelection()?.anchorNode?.parentElement)?.closest<HTMLElement>('.cm-line');
      const lineTop = line?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      editor.revealSelection(position, position, { focusEditor: true, align: 'nearest' });
      const frames: Array<{ frame: number; scrollTop: number }> = [];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({ frame, scrollTop: scroller.scrollTop });
      }
      const caret = readCaret();
      const settledViewport = scroller.getBoundingClientRect();
      return {
        initialScrollTop,
        finalScrollTop: scroller.scrollTop,
        lineStartedAboveViewport: lineTop < viewport.top,
        caretVisible: Boolean(caret && caret.top >= settledViewport.top && caret.bottom <= settledViewport.bottom),
        frames
      };
    }, wrappedPosition);
    const wrappedDelta = tallWrapped.finalScrollTop - tallWrapped.initialScrollTop;
    if (
      !tallWrapped.lineStartedAboveViewport || !tallWrapped.caretVisible ||
      wrappedDelta < 15 || wrappedDelta > 30 ||
      tallWrapped.frames.some((frame, index, frames) => (
        frame.scrollTop < tallWrapped.initialScrollTop - 1 ||
        (index > 0 && frame.scrollTop < frames[index - 1].scrollTop - 1)
      ))
    ) {
      throw new Error(`Tall wrapped caret did not use minimal monotonic reveal: ${JSON.stringify(tallWrapped)}`);
    }

    const navigationPosition = text.indexOf('line 120 ordinary content');
    await page.evaluate((position) => {
      const editor = (window as any).__inputCursorEditor;
      editor.revealSelection(position, position, { focusEditor: true, align: 'nearest' });
    }, navigationPosition);
    await waitForFrames(page, 2);
    const navigationScrollBefore = await page.evaluate(() => (
      (window as any).__inputCursorEditor.getScrollElement().scrollTop
    ));
    await page.keyboard.press('ArrowDown');
    await waitForFrames(page, 2);
    const navigation = await page.evaluate((beforeScroll) => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        scrollDelta: Math.abs(scroller.scrollTop - beforeScroll),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom),
        focused: editor.hasFocus()
      };
    }, navigationScrollBefore);
    if (navigation.scrollDelta > 40 || !navigation.cursorVisible || !navigation.focused) {
      throw new Error(`Source ArrowDown exceeded nearest caret reveal: ${JSON.stringify(navigation)}`);
    }

    await page.evaluate(() => (window as any).__inputCursorEditor.setMode('live'));
    await waitForFrames(page, 8);
    const renderedTable = await page.evaluate(async () => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      scroller.scrollTop = 0;
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      let callerScrollIntoViewCalls = 0;
      Element.prototype.scrollIntoView = function (...args: Parameters<Element['scrollIntoView']>) {
        callerScrollIntoViewCalls += 1;
        return originalScrollIntoView.apply(this, args as [boolean | ScrollIntoViewOptions | undefined]);
      };
      const frames: Array<{ frame: number; scrollTop: number }> = [];
      try {
        editor.scrollToLine(222, 'upper');
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          frames.push({ frame, scrollTop: scroller.scrollTop });
        }
      } finally {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      }
      const input = document.activeElement instanceof HTMLTextAreaElement
        ? document.activeElement
        : null;
      const cellRect = input?.closest('th, td')?.getBoundingClientRect() ?? null;
      const viewport = scroller.getBoundingClientRect();
      return {
        callerScrollIntoViewCalls,
        focusedValue: input?.value ?? null,
        cellVisible: Boolean(
          cellRect && cellRect.top >= viewport.top && cellRect.bottom <= viewport.bottom &&
          cellRect.left >= viewport.left && cellRect.right <= viewport.right
        ),
        frames
      };
    });
    if (
      renderedTable.callerScrollIntoViewCalls !== 0 ||
      renderedTable.focusedValue !== 'rendered table target' ||
      !renderedTable.cellVisible ||
      renderedTable.frames.some((frame, index, frames) => (
        index > 0 && frame.scrollTop < frames[index - 1].scrollTop - 1
      ))
    ) {
      throw new Error(`Rendered table navigation had a second writer or reversal: ${JSON.stringify(renderedTable)}`);
    }

    const renderedTableLayoutOverlap = await page.evaluate(async () => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const input = document.activeElement instanceof HTMLTextAreaElement
        ? document.activeElement
        : null;
      const row = input?.closest<HTMLElement>('tr') ?? null;
      if (!input || !row) throw new Error('Rendered table overlap had no real focused row');
      const beforeScrollTop = scroller.scrollTop;
      const beforeSelection = [input.selectionStart, input.selectionEnd];
      const scrollWrites: Array<{
        phase: 'layout-mutation' | 'navigation-input' | 'navigation-stale' | 'settling';
        before: number;
        requested: number;
        after: number;
      }> = [];
      let scrollWritePhase: (typeof scrollWrites)[number]['phase'] = 'layout-mutation';
      let descriptorOwner: object | null = scroller;
      let descriptor: PropertyDescriptor | undefined;
      while (descriptorOwner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, 'scrollTop');
        descriptorOwner = Object.getPrototypeOf(descriptorOwner);
      }
      if (!descriptor?.get || !descriptor.set) {
        throw new Error('Rendered table overlap could not instrument the real scroller scrollTop accessor');
      }
      const nativeScrollTop = descriptor;
      const readNativeScrollTop = () => Number(nativeScrollTop.get!.call(scroller));
      // Preserve the native DOM behavior while observing every synchronous JS write before the first RAF sample.
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: readNativeScrollTop,
        set(value: number) {
          const before = readNativeScrollTop();
          nativeScrollTop.set!.call(scroller, value);
          scrollWrites.push({
            phase: scrollWritePhase,
            before,
            requested: value,
            after: readNativeScrollTop()
          });
        }
      });
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      editor.preserveViewport(() => {
        row.style.transform = 'translateY(700px)';
        scroller.scrollTop += 100;
      });
      const mutatedScrollTop = scroller.scrollTop;
      scrollWritePhase = 'navigation-input';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: null
      }));
      scrollWritePhase = 'navigation-stale';
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: 'x'
      }));
      scrollWritePhase = 'settling';
      const frames: Array<{
        frame: number;
        scrollTop: number;
        focused: boolean;
        connected: boolean;
        selectionStart: number;
        selectionEnd: number;
      }> = [];
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          frame,
          scrollTop: scroller.scrollTop,
          focused: document.activeElement === input,
          connected: input.isConnected,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd
        });
      }
      const finalScrollTop = scroller.scrollTop;
      Reflect.deleteProperty(scroller, 'scrollTop');
      return {
        beforeScrollTop,
        mutatedScrollTop,
        finalScrollTop,
        beforeSelection,
        scrollWrites,
        frames
      };
    });
    const overlapLowerBound = Math.min(
      renderedTableLayoutOverlap.beforeScrollTop,
      renderedTableLayoutOverlap.mutatedScrollTop
    ) - 1;
    const overlapUpperBound = Math.max(
      renderedTableLayoutOverlap.beforeScrollTop,
      renderedTableLayoutOverlap.mutatedScrollTop
    ) + 1;
    let previousWriteDistance = Math.abs(
      renderedTableLayoutOverlap.mutatedScrollTop - renderedTableLayoutOverlap.beforeScrollTop
    );
    const illegalScrollWrite = renderedTableLayoutOverlap.scrollWrites.find((write) => {
      if (
        write.after < overlapLowerBound ||
        write.after > overlapUpperBound
      ) return true;
      if (write.phase === 'layout-mutation') return false;
      const distance = Math.abs(write.after - renderedTableLayoutOverlap.beforeScrollTop);
      const movedAwayFromLayoutTarget = distance > previousWriteDistance + 1;
      previousWriteDistance = distance;
      return movedAwayFromLayoutTarget;
    });
    if (
      Math.abs(
        renderedTableLayoutOverlap.finalScrollTop - renderedTableLayoutOverlap.beforeScrollTop
      ) > 1 ||
      illegalScrollWrite ||
      !renderedTableLayoutOverlap.scrollWrites.some((write) => (
        write.phase === 'layout-mutation' &&
        Math.abs(write.before - renderedTableLayoutOverlap.beforeScrollTop) <= 1 &&
        Math.abs(write.after - renderedTableLayoutOverlap.mutatedScrollTop) <= 1
      )) ||
      !renderedTableLayoutOverlap.scrollWrites.some((write) => (
        write.phase === 'settling' &&
        Math.abs(write.after - renderedTableLayoutOverlap.beforeScrollTop) <= 1
      )) ||
      renderedTableLayoutOverlap.frames.some((frame) => (
        frame.scrollTop < overlapLowerBound ||
        frame.scrollTop > overlapUpperBound ||
        !frame.focused ||
        !frame.connected ||
        frame.selectionStart !== renderedTableLayoutOverlap.beforeSelection[0] ||
        frame.selectionEnd !== renderedTableLayoutOverlap.beforeSelection[1]
      ))
    ) {
      throw new Error(
        `A stale rendered-table element reveal cancelled layout compensation or wrote an intermediate scroll: ${JSON.stringify(renderedTableLayoutOverlap)}`
      );
    }

    await page.evaluate(() => (window as any).__inputCursorEditor.destroy());
    console.log('input cursor navigation production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
