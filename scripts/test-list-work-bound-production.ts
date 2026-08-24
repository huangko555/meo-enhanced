import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-list-work-bound-production-'));
const LONG_LINE_COUNT = 5_000;

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
    await page.setContent('<!doctype html><body><main id="plain"></main><main id="ordered"></main></body>');
    await page.addStyleTag({ content: 'html,body{margin:0;height:100%}main{height:50%;overflow:hidden}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const plainText = Array.from({ length: LONG_LINE_COUNT }, (_, index) => `plain ${index + 1}`).join('\n');
    const orderedText = Array.from({ length: LONG_LINE_COUNT }, (_, index) => `${index + 1}. item ${index + 1}`).join('\n');
    await page.evaluate(({ plainText, orderedText }) => {
      const harness = (window as any).ListEditingHarness;
      const makeEditor = (parent: string, text: string) => {
        const changes: string[] = [];
        const editor = harness.createEditor({
          parent: document.getElementById(parent)!,
          text,
          initialMode: 'live',
          onApplyChanges(nextText: string) { changes.push(nextText); }
        });
        return { editor, changes };
      };
      (window as any).__listWorkBound = {
        plain: makeEditor('plain', plainText),
        ordered: makeEditor('ordered', orderedText)
      };
    }, { plainText, orderedText });
    await page.waitForSelector('#ordered .cm-editor');

    const session = await page.createCDPSession();
    const prepareEnd = async (name: 'plain' | 'ordered') => {
      const point = await page.evaluate((editorName) => {
        const target = (window as any).__listWorkBound[editorName].editor;
        target.view.dispatch({ selection: { anchor: target.view.state.doc.length }, scrollIntoView: true });
        target.focus();
        const caret = target.view.coordsAtPos(target.view.state.doc.length);
        if (!caret) throw new Error(`End caret was not mounted for ${editorName}`);
        const frames: Array<Record<string, unknown>> = [];
        let recording = true;
        const record = () => {
          if (!recording) return;
          const position = target.view.state.selection.main.head;
          const caret = target.view.coordsAtPos(position);
          const viewport = target.view.scrollDOM.getBoundingClientRect();
          frames.push({
            text: target.getText(),
            visible: Array.from(target.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
              .map((line) => line.textContent ?? '')
              .join('\n'),
            caretVisible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom),
            scrollTop: target.view.scrollDOM.scrollTop
          });
          requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
        (window as any).__listWorkBound[editorName].stopFrames = () => { recording = false; return frames; };
        return { x: caret.left + 1, y: caret.top + Math.max(1, caret.bottom - caret.top) / 2 };
      }, name);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('End');
    };

    const finish = async (name: 'plain' | 'ordered', beforeChanges: number, suffix: string) => {
      await page.waitForFunction(({ editorName, before, expectedSuffix }) => {
        const current = (window as any).__listWorkBound[editorName];
        return current.editor.getText().endsWith(expectedSuffix);
      }, {}, { editorName: name, before: beforeChanges, expectedSuffix: suffix });
      return page.evaluate(({ editorName, before }) => {
        const current = (window as any).__listWorkBound[editorName];
        return {
          text: current.editor.getText(),
          history: current.editor.getHistoryDepth(),
          frames: current.stopFrames(),
          changes: current.changes.length,
          expectedChanges: before + 1
        };
      }, { editorName: name, before: beforeChanges });
    };

    await prepareEnd('plain');
    const plainBefore = await page.evaluate(() => (window as any).__listWorkBound.plain.changes.length as number);
    await page.keyboard.type('x');
    const plainTyped = await finish('plain', plainBefore, `plain ${LONG_LINE_COUNT}x`);
    if (plainTyped.changes !== plainTyped.expectedChanges) {
      throw new Error(`Long plain key input published ${plainTyped.changes - plainBefore} document changes`);
    }
    if (!plainTyped.frames.some((frame: any) => frame.visible.includes(`plain ${LONG_LINE_COUNT}x`) && frame.caretVisible)) {
      throw new Error(`Long plain key input was not continuously visible: ${JSON.stringify(plainTyped.frames)}`);
    }

    await prepareEnd('plain');
    const plainPasteBefore = await page.evaluate(() => (window as any).__listWorkBound.plain.changes.length as number);
    const pasted = await page.evaluate(() => {
      const target = (window as any).__listWorkBound.plain.editor;
      const data = new DataTransfer();
      data.setData('text/plain', ' pasted');
      return target.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    if (pasted) throw new Error('Long plain paste escaped the production editor');
    const plainPasted = await finish('plain', plainPasteBefore, `plain ${LONG_LINE_COUNT}x pasted`);
    if (plainPasted.changes !== plainPasted.expectedChanges) {
      throw new Error(`Long plain paste published ${plainPasted.changes - plainPasteBefore} document changes`);
    }
    if (!plainPasted.frames.some((frame: any) => frame.visible.includes(`plain ${LONG_LINE_COUNT}x pasted`) && frame.caretVisible)) {
      throw new Error(`Long plain paste was not continuously visible: ${JSON.stringify(plainPasted.frames)}`);
    }

    await prepareEnd('ordered');
    const orderedBefore = await page.evaluate(() => (window as any).__listWorkBound.ordered.changes.length as number);
    await page.keyboard.type('x');
    const orderedTyped = await finish('ordered', orderedBefore, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x`);
    if (orderedTyped.changes !== orderedTyped.expectedChanges) {
      throw new Error(`Long ordered key input published ${orderedTyped.changes - orderedBefore} document changes`);
    }
    if (!orderedTyped.frames.some((frame: any) => frame.visible.includes(`${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x`) && frame.caretVisible)) {
      throw new Error(`Long ordered key input was not continuously visible: ${JSON.stringify(orderedTyped.frames)}`);
    }
    if (orderedTyped.history.undo !== 1) {
      throw new Error(`Ordered typing must remain one native history transaction: ${JSON.stringify(orderedTyped.history)}`);
    }

    await prepareEnd('ordered');
    const imeBefore = await page.evaluate(() => (window as any).__listWorkBound.ordered.changes.length as number);
    await session.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    const preeditChanges = await page.evaluate(() => (window as any).__listWorkBound.ordered.changes.length as number);
    if (preeditChanges !== imeBefore) throw new Error(`IME preedit published ${preeditChanges - imeBefore} document changes`);
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await page.evaluate(() => {
      const target = (window as any).__listWorkBound.ordered.editor;
      target.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
    });
    await session.send('Input.insertText', { text: '还' });
    const orderedIme = await finish('ordered', imeBefore, `${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x还`);
    if (orderedIme.changes < orderedIme.expectedChanges) {
      throw new Error('Long ordered IME commit did not publish the committed document');
    }
    if (!orderedIme.frames.some((frame: any) => frame.visible.includes(`${LONG_LINE_COUNT}. item ${LONG_LINE_COUNT}x还`) && frame.caretVisible)) {
      throw new Error(`Long ordered IME commit was not continuously visible: ${JSON.stringify(orderedIme.frames)}`);
    }
    if (orderedIme.history.undo < 2) {
      throw new Error(`Ordered IME commit did not enter native history: ${JSON.stringify(orderedIme.history)}`);
    }

    console.log('ordered-list production work-bound checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
