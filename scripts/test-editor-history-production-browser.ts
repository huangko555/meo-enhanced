import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-production-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertFormulaToolbarHistoryHitability(page: any): Promise<void> {
  const formulaText = [
    ...Array.from({ length: 72 }, (_, index) => `formula history line ${index + 1}`),
    '$$',
    'x = 1',
    '$$',
    'formula history tail'
  ].join('\n');
  await page.evaluate((text) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, formulaText);
  await waitForFrames(page, 12);

  const formulaLine = await page.evaluate(() => {
    const editor = (window as any).__historyProductionEditor;
    const lineNumber = editor.getText().split('\n').findIndex((line: string) => line.trim() === '$$') + 1;
    if (lineNumber > 0) return lineNumber;
    throw new Error('Missing Formula opening line in History hitability fixture');
  });
  const readTarget = () => page.evaluate((lineNumber) => {
    const group = document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Formula block controls at line ${lineNumber}"]`
    );
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .find((candidate) => {
        const label = candidate.getAttribute('aria-label');
        return label === 'Edit formula in split view'
          || label === 'Show formula source only'
          || label === 'Show formula preview';
      }) ?? null;
    const rect = button?.getBoundingClientRect() ?? null;
    return {
      connected: Boolean(group?.isConnected && button?.isConnected),
      mode: button?.getAttribute('aria-label') ?? null,
      point: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    };
  }, formulaLine);
  const readMode = () => page.evaluate((lineNumber) => {
    const group = document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Formula block controls at line ${lineNumber}"]`
    );
    return Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .map((button) => button.getAttribute('aria-label'))
      .find((label) => label === 'Edit formula in split view'
        || label === 'Show formula source only'
        || label === 'Show formula preview') ?? null;
  }, formulaLine);

  await page.evaluate((lineNumber) => (window as any).__historyProductionEditor.scrollToLine(lineNumber, 'center'), formulaLine);
  await waitForFrames(page, 8);
  const firstButton = await readTarget();
  if (!firstButton.connected || !firstButton.point) throw new Error('Formula toolbar disappeared after initial scroll');
  await page.click('.cm-content');
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.keyboard.type(' HISTORY_EDIT');
  await waitForFrames(page, 8);
  const editedText = await page.evaluate(() => (window as any).__historyProductionEditor.getText());
  if (!editedText.endsWith('formula history tail HISTORY_EDIT')) {
    throw new Error(`Formula History fixture did not accept the real outer edit: ${JSON.stringify(editedText.slice(-48))}`);
  }
  const replay = await page.evaluate(async () => {
    const editor = (window as any).__historyProductionEditor;
    const undone = await editor.undo();
    const redone = await editor.redo();
    return { undone, redone };
  });
  assert.deepEqual(replay, { undone: true, redone: true }, 'Formula History chain did not replay through the public editor contract');
  await waitForFrames(page, 12);
  await page.evaluate((lineNumber) => (window as any).__historyProductionEditor.scrollToLine(lineNumber, 'center'), formulaLine);
  await waitForFrames(page, 8);

  await page.mouse.move(5, 5);
  await waitForFrames(page, 2);
  const freshBeforeMove = await readTarget();
  if (!freshBeforeMove.connected || !freshBeforeMove.point) {
    throw new Error('Formula toolbar did not fresh-reacquire after History replay');
  }
  const hiddenState = await page.evaluate((point) => {
    const group = document.querySelector<HTMLElement>('[role="group"][aria-label^="Formula block controls at line "]');
    const hit = document.elementFromPoint(point.x, point.y);
    const stack = document.elementsFromPoint(point.x, point.y).slice(0, 8).map((element) => ({
      tag: element.tagName.toLowerCase(),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      actualGroup: element.closest<HTMLElement>('[role="group"]')?.getAttribute('aria-label') ?? null
    }));
    return {
      targetHit: Boolean(group && hit && group.contains(hit)),
      stack
    };
  }, freshBeforeMove.point);
  if (hiddenState.targetHit) {
    throw new Error(`Hidden Formula toolbar intercepted a pointer before hover: ${JSON.stringify(hiddenState)}`);
  }

  await page.mouse.move(freshBeforeMove.point.x, freshBeforeMove.point.y);
  const hitAfterMove = await page.evaluate(({ lineNumber, point }) => {
    const group = document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Formula block controls at line ${lineNumber}"]`
    );
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .find((candidate) => {
        const label = candidate.getAttribute('aria-label');
        return label === 'Edit formula in split view'
          || label === 'Show formula source only'
          || label === 'Show formula preview';
      }) ?? null;
    const currentButton = button?.closest<HTMLElement>('[role="group"]') === group ? button : null;
    const hit = document.elementFromPoint(point.x, point.y);
    const stack = document.elementsFromPoint(point.x, point.y).slice(0, 10).map((element) => ({
      tag: element.tagName.toLowerCase(),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      actualGroup: element.closest<HTMLElement>('[role="group"]')?.getAttribute('aria-label') ?? null
    }));
    return {
      connected: Boolean(group?.isConnected && button?.isConnected),
      currentButton: button === currentButton,
      targetHit: Boolean(button && hit && (hit === button || button.contains(hit))),
      stack
    };
  }, { lineNumber: formulaLine, point: freshBeforeMove.point });
  if (!hitAfterMove.connected || !hitAfterMove.currentButton || !hitAfterMove.targetHit) {
    throw new Error(`Fresh Formula toolbar did not become the browser hit target after real mouse movement: ${JSON.stringify(hitAfterMove)}`);
  }

  const beforeClick = await readMode();
  await page.mouse.down();
  await page.mouse.up();
  await waitForFrames(page, 8);
  const afterMouseClick = await readMode();
  if (!beforeClick || !afterMouseClick || beforeClick === afterMouseClick) {
    throw new Error(`Real Formula toolbar click did not advance its mode: ${JSON.stringify({ beforeClick, afterMouseClick })}`);
  }

  const keyboardBefore = await readTarget();
  if (!keyboardBefore.connected) throw new Error('Formula toolbar disappeared before keyboard semantic check');
  await page.evaluate((lineNumber) => {
    const group = document.querySelector<HTMLElement>(
      `[role="group"][aria-label="Formula block controls at line ${lineNumber}"]`
    );
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])
      .find((candidate) => {
        const label = candidate.getAttribute('aria-label');
        return label === 'Edit formula in split view'
          || label === 'Show formula source only'
          || label === 'Show formula preview';
      });
    button?.focus();
  }, formulaLine);
  await page.keyboard.press('Enter');
  await waitForFrames(page, 8);
  const keyboardAfter = await readMode();
  if (!keyboardAfter || keyboardAfter === afterMouseClick) {
    throw new Error(`Keyboard activation did not advance the Formula toolbar mode: ${JSON.stringify({ afterMouseClick, keyboardAfter })}`);
  }
}

async function assertHistoryViewportPolicy(page: any): Promise<void> {
  const targetLineNumber = 96;
  const marker = ' HISTORY_VIEWPORT_EDIT';
  const text = Array.from({ length: 180 }, (_, index) => `history viewport line ${index + 1}`).join('\n');
  await page.evaluate((fixture) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: fixture,
      initialMode: 'source',
      onApplyChanges() {}
    });
  }, text);
  await waitForFrames(page, 10);

  await page.evaluate(({ lineNumber, insert }) => {
    const editor = (window as any).__historyProductionEditor;
    const line = editor.view.state.doc.line(lineNumber);
    editor.view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length }
    });
    editor.scrollToLine(lineNumber, 'center');
  }, { lineNumber: targetLineNumber, insert: marker });
  await waitForFrames(page, 10);

  const capture = () => page.evaluate((lineNumber) => {
    const editor = (window as any).__historyProductionEditor;
    const scroller = editor.view.scrollDOM as HTMLElement;
    const line = editor.view.state.doc.line(lineNumber);
    const coords = editor.view.coordsAtPos(line.from);
    const viewport = scroller.getBoundingClientRect();
    return {
      bottomGap: coords ? viewport.bottom - coords.bottom : null,
      contextMargin: Math.min(editor.view.defaultLineHeight * 2.5, viewport.height * 0.2),
      scrollTop: scroller.scrollTop,
      topGap: coords ? coords.top - viewport.top : null,
      visible: Boolean(coords && coords.bottom > viewport.top && coords.top < viewport.bottom)
    };
  }, targetLineNumber);

  const beforeVisibleUndo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 12);
  const afterVisibleUndo = await capture();
  assert.equal(afterVisibleUndo.visible, true, 'visible Undo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleUndo.scrollTop - beforeVisibleUndo.scrollTop) <= 2,
    `visible Undo moved the viewport: ${JSON.stringify({ beforeVisibleUndo, afterVisibleUndo })}`
  );

  const beforeVisibleRedo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 12);
  const afterVisibleRedo = await capture();
  assert.equal(afterVisibleRedo.visible, true, 'visible Redo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleRedo.scrollTop - beforeVisibleRedo.scrollTop) <= 2,
    `visible Redo moved the viewport: ${JSON.stringify({ beforeVisibleRedo, afterVisibleRedo })}`
  );

  const moveAway = async () => {
    await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      editor.scrollToLine(4, 'center');
    });
    await waitForFrames(page, 10);
    assert.equal((await capture()).visible, false, 'history target fixture did not move offscreen');
  };
  const replayWithFrameTrace = (direction: 'undo' | 'redo') => page.evaluate(async (replayDirection) => {
    const editor = (window as any).__historyProductionEditor;
    const trace = [editor.view.scrollDOM.scrollTop as number];
    const frames = new Promise<void>((resolve) => {
      let remaining = 24;
      const sample = () => {
        trace.push(editor.view.scrollDOM.scrollTop);
        remaining -= 1;
        if (remaining > 0) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    const applied = await editor[replayDirection]();
    await frames;
    return { applied, trace };
  }, direction);
  const assertSingleVisibleReveal = (trace: number[], label: string) => {
    const significant = trace.reduce<number[]>((values, value) => {
      if (values.length === 0 || Math.abs(value - values.at(-1)!) > 2) values.push(value);
      return values;
    }, []);
    assert.ok(
      significant.length <= 2,
      `${label} used more than one visible viewport movement: ${JSON.stringify({ significant, trace })}`
    );
  };
  await moveAway();
  const undoReplay = await replayWithFrameTrace('undo');
  assert.equal(undoReplay.applied, true);
  assertSingleVisibleReveal(undoReplay.trace, 'offscreen Undo');
  await waitForFrames(page, 12);
  const offscreenUndo = await capture();
  assert.equal(offscreenUndo.visible, true, 'offscreen Undo target was not revealed');
  assert.ok(
    offscreenUndo.bottomGap !== null && offscreenUndo.bottomGap >= offscreenUndo.contextMargin - 2,
    `offscreen Undo target lacked visual context: ${JSON.stringify(offscreenUndo)}`
  );

  await moveAway();
  const redoReplay = await replayWithFrameTrace('redo');
  assert.equal(redoReplay.applied, true);
  assertSingleVisibleReveal(redoReplay.trace, 'offscreen Redo');
  await waitForFrames(page, 12);
  const offscreenRedo = await capture();
  assert.equal(offscreenRedo.visible, true, 'offscreen Redo target was not revealed');
  assert.ok(
    offscreenRedo.bottomGap !== null && offscreenRedo.bottomGap >= offscreenRedo.contextMargin - 2,
    `offscreen Redo target lacked visual context: ${JSON.stringify(offscreenRedo)}`
  );
}

async function assertRenderedHistoryViewportPolicy(page: any): Promise<void> {
  const text = [
    ...Array.from({ length: 72 }, (_, index) => `rendered viewport before ${index + 1}`),
    '```mermaid',
    'graph TD',
    'A --> B',
    '```',
    ...Array.from({ length: 72 }, (_, index) => `rendered viewport after ${index + 1}`)
  ].join('\n');
  await page.evaluate((fixture) => {
    const previous = (window as any).__historyProductionEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: fixture,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, text);
  await waitForFrames(page, 12);
  await page.evaluate(() => (window as any).__historyProductionEditor.scrollToLine(73, 'center'));
  await waitForFrames(page, 10);
  await page.click('.meo-mermaid-mode-btn');
  await waitForFrames(page, 10);
  await page.click('.meo-mermaid-source-editor .cm-content');
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.keyboard.type('\nB --> C');
  await waitForFrames(page, 10);

  const capture = () => page.evaluate(() => {
    const editor = (window as any).__historyProductionEditor;
    const scroller = editor.view.scrollDOM as HTMLElement;
    const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
    const rect = block?.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
    };
  });
  const beforeVisibleUndo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 14);
  const afterVisibleUndo = await capture();
  assert.equal(afterVisibleUndo.visible, true, 'visible Mermaid Undo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleUndo.scrollTop - beforeVisibleUndo.scrollTop) <= 2,
    `visible Mermaid Undo moved the viewport: ${JSON.stringify({ beforeVisibleUndo, afterVisibleUndo })}`
  );

  const beforeVisibleRedo = await capture();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 14);
  const afterVisibleRedo = await capture();
  assert.equal(afterVisibleRedo.visible, true, 'visible Mermaid Redo target must stay visible');
  assert.ok(
    Math.abs(afterVisibleRedo.scrollTop - beforeVisibleRedo.scrollTop) <= 2,
    `visible Mermaid Redo moved the viewport: ${JSON.stringify({ beforeVisibleRedo, afterVisibleRedo })}`
  );

  const moveAway = async () => {
    await page.evaluate(() => (window as any).__historyProductionEditor.scrollToLine(3, 'center'));
    await waitForFrames(page, 10);
    assert.equal((await capture()).visible, false, 'Mermaid history target fixture did not move offscreen');
  };
  await moveAway();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), true);
  await waitForFrames(page, 14);
  assert.equal((await capture()).visible, true, 'offscreen Mermaid Undo target was not revealed');

  await moveAway();
  assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.redo()), true);
  await waitForFrames(page, 14);
  assert.equal((await capture()).visible, true, 'offscreen Mermaid Redo target was not revealed');
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      const text = Array.from(
        { length: 90 },
        (_, index) => index === 44 ? 'production history plain | pipe' : `production history line ${index + 1}`
      ).join('\n');
      (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    if (process.argv.includes('--viewport-policy-only')) {
      await assertHistoryViewportPolicy(page);
      await assertRenderedHistoryViewportPolicy(page);
      await page.evaluate(() => (window as any).__historyProductionEditor.destroy());
      console.log('Editor History viewport policy checks passed');
      return;
    }

    const publicReplay = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' PUBLIC_EDIT' }, selection: { anchor: end + 12 } });
      const replay = editor.undo();
      const promiseLike = typeof replay?.then === 'function';
      const applied = await replay;
      return {
        promiseLike,
        applied,
        text: view.state.doc.toString(),
        focused: view.hasFocus,
        head: view.state.selection.main.head
      };
    });
    assert.equal(publicReplay.promiseLike, true, 'public undo must return the Runtime completion Promise');
    assert.equal(publicReplay.applied, true);
    assert.equal(publicReplay.text.includes('PUBLIC_EDIT'), false);
    assert.equal(publicReplay.focused, true);
    assert.equal(publicReplay.head, publicReplay.text.length);

    const plainPipeReplay = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const line = view.state.doc.line(45);
      view.dispatch({ changes: { from: line.to, insert: ' EDIT' }, selection: { anchor: line.to + 5 } });
      const applied = await editor.undo();
      return {
        applied,
        line: view.state.doc.line(45).text,
        focused: view.hasFocus,
        head: view.state.selection.main.head,
        expectedHead: line.to
      };
    });
    await waitForFrames(page, 12);
    assert.deepEqual(plainPipeReplay, {
      applied: true,
      line: 'production history plain | pipe',
      focused: true,
      head: plainPipeReplay.expectedHead,
      expectedHead: plainPipeReplay.expectedHead
    });

    const keymapConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' KEYMAP_EDIT' }, selection: { anchor: end + 12 } });
      view.focus();
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(keymapConsumed, true, 'keymap runner must synchronously consume the browser event');
    await waitForFrames(page);
    assert.equal(
      await page.evaluate(() => (window as any).__historyProductionEditor.getText().includes('KEYMAP_EDIT')),
      false
    );

    while (await page.evaluate(() => (window as any).__historyProductionEditor.undo())) {
      // Exhaust native history through the public asynchronous contract.
    }
    const boundaryConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = editor.view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(boundaryConsumed, true, 'native no-op boundary must still be consumed synchronously');
    await waitForFrames(page);
    assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), false);

    const reloadClearsUndo = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' LOCAL_TEXT_TO_DISCARD' } });
      editor.setText('disk version after reload', true);
      return {
        text: editor.getText(),
        undoApplied: await editor.undo()
      };
    });
    assert.deepEqual(reloadClearsUndo, {
      text: 'disk version after reload',
      undoApplied: false
    }, 'a disk reload must not leave discarded local text reachable by normal undo');

    await assertHistoryViewportPolicy(page);
    await assertRenderedHistoryViewportPolicy(page);

    const renderedHistoryEditorReady = await page.evaluate(async () => {
      const previous = (window as any).__historyProductionEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const editor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__historyProductionEditor = editor;
      return true;
    });
    assert.equal(renderedHistoryEditorReady, true);
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const sourceContentSelector = '.meo-mermaid-source-editor .cm-content';
    await page.click(sourceContentSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    const before = await page.$eval(sourceContentSelector, (content) => (
      Array.from(content.querySelectorAll<HTMLElement>('.cm-line'))
        .map((line) => line.textContent ?? '')
        .join('\n').length
    ));
    await page.keyboard.press('Enter');
    await page.keyboard.type('C --> D');
    const positions = { before, after: before + 8 };
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    const readBlock = () => page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const content = block?.querySelector<HTMLElement>('.meo-mermaid-source-editor .cm-content');
      const selection = window.getSelection();
      const focusNode = selection?.focusNode ?? null;
      const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement ?? null;
      const focusLine = focusElement?.closest<HTMLElement>('.cm-line') ?? null;
      const lines = content ? Array.from(content.querySelectorAll<HTMLElement>('.cm-line')) : [];
      const focusLineIndex = focusLine ? lines.indexOf(focusLine) : -1;
      let head: number | null = null;
      if (selection && focusNode && focusLine && content?.contains(focusNode) && focusLineIndex >= 0) {
        const range = document.createRange();
        range.selectNodeContents(focusLine);
        range.setEnd(focusNode, selection.focusOffset);
        head = lines.slice(0, focusLineIndex)
          .reduce((offset, line) => offset + (line.textContent?.length ?? 0) + 1, 0)
          + range.toString().length;
      }
      return {
        split: Boolean(block?.classList.contains('is-split')),
        source: Boolean(block?.classList.contains('is-source')),
        head,
        focused: Boolean(content && document.activeElement === content)
      };
    });
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    await waitForFrames(page);
    const previewUndo = await readBlock();
    await page.evaluate(() => (window as any).__historyProductionEditor.redo());
    await waitForFrames(page);
    const splitRedo = await readBlock();
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.click(`${sourceContentSelector} .cm-line:last-child`);
    await page.keyboard.press('End');
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceUndo = await readBlock();
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceRedo = await readBlock();

    const renderedHistoryPresentation = {
      positions,
      previewUndo: { split: previewUndo.split, head: previewUndo.head, focused: previewUndo.focused },
      splitRedo: { split: splitRedo.split, head: splitRedo.head, focused: splitRedo.focused },
      sourceUndo: { source: sourceUndo.source, head: sourceUndo.head, focused: sourceUndo.focused },
      sourceRedo: { source: sourceRedo.source, head: sourceRedo.head, focused: sourceRedo.focused }
    };
    assert.deepEqual(renderedHistoryPresentation, {
      positions: { before: 16, after: 24 },
      previewUndo: { split: false, head: null, focused: false },
      splitRedo: { split: false, head: null, focused: false },
      sourceUndo: { source: true, head: 16, focused: true },
      sourceRedo: { source: true, head: 24, focused: true }
    });

    await assertFormulaToolbarHistoryHitability(page);
    await page.evaluate(() => (window as any).__historyProductionEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor History production Chromium trace passed');
}

await main();
