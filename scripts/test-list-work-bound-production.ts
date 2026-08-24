import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-list-work-bound-production-'));
const LONG_LINE_COUNT = 5_000;

type Frame = { accepted: boolean; text: string; visible: string; caretVisible: boolean; scrollTop: number };
type Settlement = {
  frames: Frame[];
  diagnostics: { phase: string; rootReturned: boolean; acceptances: number; pendingMicrotasks: number; pendingFrames: number; failure: string | null };
};

function assertSettledTrace(frames: readonly Frame[], expectedSuffix: string): void {
  const accepted = frames.filter((frame) => frame.accepted);
  assert.ok(accepted.length > 0, 'the trace must contain an observable frame after Document acceptance');
  const referenceScroll = accepted[0].scrollTop;
  for (const frame of accepted) {
    assert.ok(frame.text.endsWith(expectedSuffix), `accepted frame retained stale text: ${JSON.stringify(frame)}`);
    assert.ok(frame.visible.includes(expectedSuffix), `accepted frame hid current text: ${JSON.stringify(frame)}`);
    assert.equal(frame.caretVisible, true, `accepted frame hid the caret: ${JSON.stringify(frame)}`);
    assert.ok(Math.abs(frame.scrollTop - referenceScroll) <= 1, `accepted frame drifted or rolled back scroll: ${JSON.stringify({ referenceScroll, frame })}`);
  }
}

function assertNoScrollRollback(frames: readonly Frame[]): void {
  const accepted = frames.filter((frame) => frame.accepted);
  assert.ok(accepted.length > 0, 'the trace must contain accepted frames before checking scroll');
  const referenceScroll = accepted[0].scrollTop;
  for (const frame of accepted) {
    assert.ok(Math.abs(frame.scrollTop - referenceScroll) <= 1, `accepted frame drifted or rolled back scroll: ${JSON.stringify({ referenceScroll, frame })}`);
  }
}

function assertCausalCompletion(settlement: Settlement): void {
  assert.deepEqual(settlement.diagnostics, {
    phase: 'complete', rootReturned: true, acceptances: 1, pendingMicrotasks: 0, pendingFrames: 0, failure: null
  });
}

assert.throws(
  () => assertSettledTrace([
    { accepted: false, text: 'old', visible: 'old', caretVisible: true, scrollTop: 90 },
    { accepted: true, text: 'old', visible: 'old', caretVisible: false, scrollTop: 0 },
    { accepted: true, text: 'current', visible: 'current', caretVisible: true, scrollTop: 90 }
  ], 'current'),
  /stale text|hid current text|hid the caret|drifted or rolled back/
);
assert.throws(
  () => assertSettledTrace([
    { accepted: true, text: 'current', visible: 'current', caretVisible: true, scrollTop: 120 },
    { accepted: true, text: 'current', visible: 'current', caretVisible: true, scrollTop: 116 },
    { accepted: true, text: 'current', visible: 'current', caretVisible: true, scrollTop: 120 }
  ], 'current'),
  /drifted or rolled back/
);

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 620 });
    await page.setContent('<!doctype html><body><main id="plain"></main><main id="ordered"></main><main id="rollback"></main></body>');
    await page.addStyleTag({ content: 'html,body{margin:0;height:100%}main{height:33.333%;overflow:hidden}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const plainText = Array.from({ length: LONG_LINE_COUNT }, (_, index) => `plain ${index + 1}`).join('\n');
    const orderedText = Array.from({ length: LONG_LINE_COUNT }, (_, index) => `${index + 1}. item ${index + 1}`).join('\n');
    const rollbackText = Array.from({ length: 40 }, (_, index) => `rollback ${index + 1}`).join('\n');
    await page.evaluate(({ plainText, orderedText, rollbackText }) => {
      const harness = (window as any).ListEditingHarness;
      const makeEditor = (parent: string, text: string) => {
        const publishes: string[] = [];
        const current: any = { publishes, tracker: null, before: 0, suffix: '', injectLateRollback: false };
        const editor = harness.createEditor({
          parent: document.getElementById(parent)!, text, initialMode: 'live',
          onApplyChanges(nextText: string) {
            publishes.push(nextText);
            if (!current.tracker) return;
            if (publishes.length !== current.before + 1 || !nextText.endsWith(current.suffix)) {
              current.tracker.reject(`unexpected public acceptance: ${JSON.stringify({ publishes: publishes.length - current.before, suffix: nextText.slice(-40) })}`);
              return;
            }
            if (current.injectLateRollback) editor.view.scrollDOM.scrollTop = 120;
            current.tracker.accept();
            if (current.injectLateRollback) {
              requestAnimationFrame(() => {
                editor.view.scrollDOM.scrollTop = 116;
                requestAnimationFrame(() => { editor.view.scrollDOM.scrollTop = 120; });
              });
            }
          }
        });
        current.editor = editor;
        return current;
      };
      (window as any).__listWorkBound = {
        plain: makeEditor('plain', plainText),
        ordered: makeEditor('ordered', orderedText),
        rollback: makeEditor('rollback', rollbackText)
      };
    }, { plainText, orderedText, rollbackText });
    await page.waitForSelector('#ordered .cm-editor');

    const prepareEnd = async (name: 'plain' | 'ordered' | 'rollback') => {
      const point = await page.evaluate((editorName) => {
        const current = (window as any).__listWorkBound[editorName];
        const editor = current.editor;
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length }, scrollIntoView: true });
        editor.focus();
        const caret = editor.view.coordsAtPos(editor.view.state.doc.length);
        if (!caret) throw new Error(`End caret was not mounted for ${editorName}`);
        return { x: caret.left + 1, y: caret.top + Math.max(1, caret.bottom - caret.top) / 2 };
      }, name);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('End');
    };

    const startTrace = async (name: 'plain' | 'ordered' | 'rollback', beforePublishes: number, expectedSuffix: string, injectLateRollback = false) => {
      await page.evaluate(({ editorName, before, suffix, inject }) => {
        const current = (window as any).__listWorkBound[editorName];
        const editor = current.editor;
        const harness = (window as any).ListEditingHarness;
        current.before = before;
        current.suffix = suffix;
        current.injectLateRollback = inject;
        current.tracker = harness.installCausalFrameSettlement(window, (): Frame => {
          const position = editor.view.state.selection.main.head;
          const caret = editor.view.coordsAtPos(position);
          const viewport = editor.view.scrollDOM.getBoundingClientRect();
          return {
            accepted: current.publishes.length > before,
            text: editor.getText(),
            visible: Array.from(editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
              .map((line) => line.textContent ?? '')
              .join('\n'),
            caretVisible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom),
            scrollTop: editor.view.scrollDOM.scrollTop
          };
        });
      }, { editorName: name, before: beforePublishes, suffix: expectedSuffix, inject: injectLateRollback });
    };

    const runPublicRoot = async (name: 'plain' | 'ordered' | 'rollback', action: () => Promise<void>) => {
      await page.evaluate((editorName) => {
        const current = (window as any).__listWorkBound[editorName];
        current.endPublicRoot = current.tracker.beginExternalRoot();
      }, name);
      try {
        await action();
      } finally {
        await page.evaluate((editorName) => (window as any).__listWorkBound[editorName].endPublicRoot(), name);
      }
    };

    const finish = async (name: 'plain' | 'ordered' | 'rollback', beforePublishes: number, expectedSuffix: string) => {
      await page.waitForFunction(({ editorName, before, suffix }) => {
        const current = (window as any).__listWorkBound[editorName];
        const diagnostics = current.tracker.diagnostics();
        if (diagnostics.failure) throw new Error(diagnostics.failure);
        return current.publishes.length === before + 1
          && current.editor.getText().endsWith(suffix)
          && diagnostics.phase === 'complete';
      }, {}, { editorName: name, before: beforePublishes, suffix: expectedSuffix });
      return page.evaluate((editorName) => {
        const current = (window as any).__listWorkBound[editorName];
        const settlement = { frames: current.tracker.trace(), diagnostics: current.tracker.diagnostics() };
        current.tracker.dispose();
        current.tracker = null;
        return {
          text: current.editor.getText(),
          history: current.editor.getHistoryDepth(),
          settlement,
          publishes: current.publishes.length
        };
      }, name);
    };

    await prepareEnd('rollback');
    await startTrace('rollback', 0, 'rollback 40x', true);
    await runPublicRoot('rollback', () => page.keyboard.type('x'));
    const rollback = await finish('rollback', 0, 'rollback 40x');
    assert.equal(rollback.publishes, 1, 'controlled late rollback must retain one public publish');
    assert.throws(
      () => assertNoScrollRollback(rollback.settlement.frames),
      /drifted or rolled back/,
      'late successor RAF rollback must be visible after public acceptance'
    );

    await prepareEnd('plain');
    await startTrace('plain', 0, `plain ${LONG_LINE_COUNT}x`);
    await runPublicRoot('plain', () => page.keyboard.type('x'));
    const plainTyped = await finish('plain', 0, `plain ${LONG_LINE_COUNT}x`);
    assert.equal(plainTyped.publishes, 1, 'keyboard input must publish exactly once');
    assert.deepEqual(plainTyped.history, { undo: 1, redo: 0 }, 'keyboard input must create one native history entry');
    assertCausalCompletion(plainTyped.settlement);
    assertSettledTrace(plainTyped.settlement.frames, `plain ${LONG_LINE_COUNT}x`);
    const plainUndoRedo = await page.evaluate(async () => {
      const editor = (window as any).__listWorkBound.plain.editor;
      const undo = await editor.undo();
      const afterUndo = editor.getText();
      const redo = await editor.redo();
      return { undo, redo, afterUndo, afterRedo: editor.getText(), history: editor.getHistoryDepth() };
    });
    assert.ok(plainUndoRedo.undo && plainUndoRedo.redo, 'keyboard history must support undo and redo');
    assert.equal(plainUndoRedo.afterUndo, plainText);
    assert.equal(plainUndoRedo.afterRedo, `${plainText}x`);
    assert.deepEqual(plainUndoRedo.history, { undo: 1, redo: 0 });

    const plainPasteBefore = await page.evaluate(() => (window as any).__listWorkBound.plain.publishes.length as number);
    await prepareEnd('plain');
    await startTrace('plain', plainPasteBefore, `plain ${LONG_LINE_COUNT}x pasted`);
    let pasted = true;
    await runPublicRoot('plain', async () => {
      pasted = await page.evaluate(() => {
        const editor = (window as any).__listWorkBound.plain.editor;
        const data = new DataTransfer();
        data.setData('text/plain', ' pasted');
        return editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      });
    });
    assert.equal(pasted, false, 'paste must be accepted by the production editor');
    const plainPasted = await finish('plain', plainPasteBefore, `plain ${LONG_LINE_COUNT}x pasted`);
    assert.equal(plainPasted.publishes, plainPasteBefore + 1, 'paste must publish exactly once');
    assert.deepEqual(plainPasted.history, { undo: 2, redo: 0 }, 'paste must create one native history entry');
    assertCausalCompletion(plainPasted.settlement);
    assertSettledTrace(plainPasted.settlement.frames, `plain ${LONG_LINE_COUNT}x pasted`);

    await prepareEnd('ordered');
    await startTrace('ordered', 0, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x`);
    await runPublicRoot('ordered', () => page.keyboard.type('x'));
    const orderedTyped = await finish('ordered', 0, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x`);
    assert.equal(orderedTyped.publishes, 1, 'ordered keyboard input must publish exactly once');
    assert.deepEqual(orderedTyped.history, { undo: 1, redo: 0 }, 'ordered keyboard input and normalization must share one history entry');
    assertCausalCompletion(orderedTyped.settlement);
    assertSettledTrace(orderedTyped.settlement.frames, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x`);
    const orderedUndoRedo = await page.evaluate(async () => {
      const editor = (window as any).__listWorkBound.ordered.editor;
      const undo = await editor.undo();
      const afterUndo = editor.getText();
      const redo = await editor.redo();
      return { undo, redo, afterUndo, afterRedo: editor.getText(), history: editor.getHistoryDepth() };
    });
    assert.ok(orderedUndoRedo.undo && orderedUndoRedo.redo, 'ordered keyboard history must support undo and redo');
    assert.equal(orderedUndoRedo.afterUndo, orderedText);
    assert.equal(orderedUndoRedo.afterRedo, `${orderedText}x`);
    assert.deepEqual(orderedUndoRedo.history, { undo: 1, redo: 0 });

    const imeBefore = await page.evaluate(() => (window as any).__listWorkBound.ordered.publishes.length as number);
    await prepareEnd('ordered');
    const session = await page.createCDPSession();
    await session.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    assert.equal(
      await page.evaluate(() => (window as any).__listWorkBound.ordered.publishes.length as number),
      imeBefore,
      'IME preedit must not publish a partial Document'
    );
    await startTrace('ordered', imeBefore, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x还`);
    await runPublicRoot('ordered', () => session.send('Input.insertText', { text: '还' }));
    const orderedIme = await finish('ordered', imeBefore, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x还`);
    assert.equal(orderedIme.publishes, imeBefore + 1, 'IME commit must publish exactly once');
    assert.deepEqual(orderedIme.history, { undo: 2, redo: 0 }, 'IME commit must create one native history entry');
    assertCausalCompletion(orderedIme.settlement);
    assertSettledTrace(orderedIme.settlement.frames, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x还`);
    const imeUndoRedo = await page.evaluate(async () => {
      const editor = (window as any).__listWorkBound.ordered.editor;
      const undo = await editor.undo();
      const afterUndo = editor.getText();
      const redo = await editor.redo();
      return { undo, redo, afterUndo, afterRedo: editor.getText(), history: editor.getHistoryDepth() };
    });
    assert.ok(imeUndoRedo.undo && imeUndoRedo.redo, 'IME history must support undo and redo');
    assert.equal(imeUndoRedo.afterUndo, `${orderedText}x`);
    assert.equal(imeUndoRedo.afterRedo, `${orderedText}x还`);
    assert.deepEqual(imeUndoRedo.history, { undo: 2, redo: 0 });

    console.log('ordered-list production work-bound checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
