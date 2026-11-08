import { enterMermaidSource, setMermaidLayout } from './history-mermaid-chromium';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-history-rendered-mode-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertLayoutSurvivesHistory(
  page: any,
  fixture: {
    readonly kind: 'mermaid' | 'formula';
    readonly text: string;
    readonly button: string;
    readonly block: string;
    readonly marker: string;
    readonly layout: 'stacked' | 'side-by-side';
  }
): Promise<void> {
  await page.evaluate((text) => {
    const previous = (window as any).__historyModeEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyModeEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, fixture.text);
  await waitForFrames(page);

  await setMermaidLayout(page, '__historyModeEditor', 2, fixture.layout);
  await enterMermaidSource(page, '__historyModeEditor', 2, 'end');
  await page.keyboard.type(fixture.marker);
  await waitForFrames(page);
  const edited = await page.evaluate(() => (window as any).__historyModeEditor.getText());
  await setMermaidLayout(page, '__historyModeEditor', 2, 'preview');

  for (const direction of ['undo', 'redo'] as const) {
    const applied = await page.evaluate(async (historyDirection) => (
      (window as any).__historyModeEditor[historyDirection]()
    ), direction);
    if (!applied) throw new Error(`${fixture.kind} ${direction} did not apply`);
    await waitForFrames(page);
    const state = await page.evaluate(({ buttonSelector, blockSelector }) => ({
      modeLabel: document.querySelector<HTMLButtonElement>(buttonSelector)?.closest<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode ?? null,
      editingBlockMounted: Boolean(document.querySelector(blockSelector)),
      activeRole: document.activeElement?.getAttribute('role') ?? null,
      side: !!document.querySelector('.meo-mermaid-inline-preview'),
      text: (window as any).__historyModeEditor.getText(),
      focused: (window as any).__historyModeEditor.view.hasFocus
    }), { buttonSelector: fixture.button, blockSelector: fixture.block });
    if (state.modeLabel !== 'edit' || !state.editingBlockMounted || !state.focused || state.side !== (fixture.layout === 'side-by-side') || state.text !== (direction === 'undo' ? fixture.text : edited)) {
      throw new Error(`${fixture.kind} ${direction} did not restore native source with the selected layout: ${JSON.stringify(state)}`);
    }
  }
}

async function assertMermaidSourceSelectionHistory(page: any, large: boolean, backward: boolean): Promise<void> {
  const text = [
    'before', '```mermaid', 'flowchart LR', '  NodeA --> NodeB', '```', 'after body',
    ...(large ? Array.from({ length: 8100 }, () => 'padding text') : [])
  ].join('\n');
  await page.evaluate((text) => {
    const previous = (window as any).__historyModeEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyModeEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
  }, text);
  await page.waitForFunction(large => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(
    (window as any).__historyModeEditor.view.state) === large, {}, large);
  await waitForFrames(page, 12);
  const bounds = await enterMermaidSource(page, '__historyModeEditor', 2, 'start');
  const before = await page.evaluate(({ from, backward }) => {
    const view = (window as any).__historyModeEditor.view;
    const label = view.state.doc.toString().indexOf('NodeA', from);
    if (label < 0) throw Error('Missing Mermaid source label');
    view.dispatch({ selection: backward ? { anchor: label + 5, head: label } : { anchor: label, head: label + 5 } });
    view.focus();
    return view.state.selection.toJSON();
  }, { from: bounds.from, backward });
  await page.keyboard.type('Start');
  await waitForFrames(page);
  const edited = await page.evaluate(() => {
    const view = (window as any).__historyModeEditor.view;
    return { text: (window as any).__historyModeEditor.getText(), selection: view.state.selection.toJSON() };
  });
  const click = await page.evaluate(() => {
    const view = (window as any).__historyModeEditor.view;
    const position = view.state.doc.toString().indexOf('after body');
    const coords = view.coordsAtPos(position);
    if (!coords) throw Error('Missing body click coordinates');
    return { x: coords.left + 4, y: (coords.top + coords.bottom) / 2 };
  });
  await page.mouse.move(click.x, click.y); await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') === 'preview');

  const read = () => page.evaluate(() => {
    const editor = (window as any).__historyModeEditor, view = editor.view, native = document.getSelection();
    const posAt = (node: Node | null, offset: number) => node && view.contentDOM.contains(node) ? view.posAtDOM(node, offset) : null;
    return { text: editor.getText(), selection: view.state.selection.toJSON(), mode: view.dom.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') ?? null,
      focused: view.hasFocus && document.activeElement === view.contentDOM,
      dom: { anchor: posAt(native?.anchorNode ?? null, native?.anchorOffset ?? 0), head: posAt(native?.focusNode ?? null, native?.focusOffset ?? 0) } };
  });
  const assertSnapshot = async (direction: 'undo' | 'redo', expected: typeof before, expectedText: string) => {
    const applied = await page.evaluate(direction => (window as any).__historyModeEditor[direction](), direction);
    if (!applied) throw Error(`${large ? 'large' : 'ordinary'}/${backward ? 'backward' : 'forward'} Mermaid ${direction} did not apply`);
    await page.waitForFunction(() => (window as any).__historyModeEditor.view.dom
      .querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') === 'edit');
    await waitForFrames(page, 12);
    const actual = await read(), range = expected.ranges[expected.main];
    if (actual.text !== expectedText || JSON.stringify(actual.selection) !== JSON.stringify(expected) || actual.mode !== 'edit' || !actual.focused
      || actual.dom.anchor !== range.anchor || actual.dom.head !== range.head) {
      throw Error(`${large ? 'large' : 'ordinary'}/${backward ? 'backward' : 'forward'} Mermaid ${direction} did not restore its native target: ${JSON.stringify({
        textMatches: actual.text === expectedText, selection: actual.selection, expected, mode: actual.mode, focused: actual.focused, dom: actual.dom
      })}`);
    }
  };
  await assertSnapshot('undo', before, text);
  await assertSnapshot('redo', edited.selection, edited.text);
  await assertSnapshot('undo', before, text);
  await page.keyboard.type('C'); await waitForFrames(page);
  const range = before.ranges[before.main];
  const expectedInput = text.slice(0, Math.min(range.anchor, range.head)) + 'C' + text.slice(Math.max(range.anchor, range.head));
  const afterInput = await read();
  if (afterInput.text !== expectedInput || afterInput.selection.ranges[afterInput.selection.main].anchor !== Math.min(range.anchor, range.head) + 1
    || afterInput.selection.ranges[afterInput.selection.main].head !== Math.min(range.anchor, range.head) + 1) {
    throw Error(`${large ? 'large' : 'ordinary'}/${backward ? 'backward' : 'forward'} Mermaid first input did not replace the restored full selection: ${JSON.stringify({ afterInput, expectedInput })}`);
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          return { svg: `<svg width="320" height="120"><text>${source.length}</text></svg>` };
        }
      };
    });

    for (const layout of ['stacked', 'side-by-side'] as const) await assertLayoutSurvivesHistory(page, {
      kind: 'mermaid',
      text: ['before', '```mermaid', 'flowchart LR', 'A --> B', '```', 'after'].join('\n'),
      button: '.meo-mermaid-mode-btn',
      block: '.meo-mermaid-editing-preview',
      marker: ' HISTORY',
      layout
    });
    for (const large of [false, true]) for (const backward of [false, true]) {
      await assertMermaidSourceSelectionHistory(page, large, backward);
    }
    // Math presentation follows the document caret, tested in test-display-math-editing.

    console.log('native Mermaid history restores source and preserves both layouts');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
