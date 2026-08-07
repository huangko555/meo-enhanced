import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

type BlockKind = 'mermaid' | 'math';
type BlockMode = 'preview' | 'split' | 'source';
type NeedleOccurrence = 'first' | 'last';
type EditTarget = { kind: BlockKind; needle: string; marker: string; occurrence?: NeedleOccurrence };

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-rendered-history-stress-'));

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function pressHistory(page: any, key: 'z' | 'y', wait = true) {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  if (wait) await waitForFrames(page);
}

async function runHeldControlHistoryCycle(
  page: any,
  versions: string[],
  editCount: number,
  cycle: number,
  delayMs = 0
) {
  await page.keyboard.down('Control');
  try {
    for (let count = 1; count <= editCount; count += 1) {
      await page.keyboard.press('z');
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const actual = await documentText(page);
      const expected = versions[editCount - count];
      if (actual !== expected) {
        throw new Error(`Held-Control undo cycle ${cycle} stalled at key ${count}: ${JSON.stringify({ expected, actual })}`);
      }
      if (!await editorOwnsFocus(page)) {
        throw new Error(`Held-Control undo cycle ${cycle} lost editor focus at key ${count}`);
      }
    }
    for (let count = 1; count <= editCount; count += 1) {
      await page.keyboard.press('y');
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const actual = await documentText(page);
      const expected = versions[count];
      if (actual !== expected) {
        throw new Error(`Held-Control redo cycle ${cycle} stalled at key ${count}: ${JSON.stringify({ expected, actual })}`);
      }
      if (!await editorOwnsFocus(page)) {
        throw new Error(`Held-Control redo cycle ${cycle} lost editor focus at key ${count}`);
      }
    }
  } finally {
    await page.keyboard.up('Control');
  }
  await waitForFrames(page, 12);
}

async function runHeldKeyRepeatHistoryCycle(page: any, versions: string[], editCount: number) {
  await page.keyboard.down('Control');
  try {
    for (let count = 1; count <= editCount; count += 1) {
      await page.keyboard.down('z');
      const actual = await documentText(page);
      if (actual !== versions[editCount - count]) {
        throw new Error(`Repeated keydown undo stalled at repeat ${count}`);
      }
      if (!await editorOwnsFocus(page)) throw new Error(`Repeated keydown undo lost focus at repeat ${count}`);
    }
    await page.keyboard.up('z');
    for (let count = 1; count <= editCount; count += 1) {
      await page.keyboard.down('y');
      const actual = await documentText(page);
      if (actual !== versions[count]) {
        throw new Error(`Repeated keydown redo stalled at repeat ${count}`);
      }
      if (!await editorOwnsFocus(page)) throw new Error(`Repeated keydown redo lost focus at repeat ${count}`);
    }
    await page.keyboard.up('y');
  } finally {
    await page.keyboard.up('Control');
  }
  await waitForFrames(page, 12);
}

async function documentText(page: any): Promise<string> {
  return page.evaluate(() => (window as any).__renderedHistoryStressEditor.view.state.doc.toString());
}

async function editorOwnsFocus(page: any): Promise<boolean> {
  return page.evaluate(() => {
    const editor = (window as any).__renderedHistoryStressEditor;
    return editor.view.dom.contains(document.activeElement);
  });
}

async function scrollToNeedle(page: any, needle: string, occurrence: NeedleOccurrence = 'first') {
  await page.evaluate(({ lineNeedle, targetOccurrence }) => {
    const editor = (window as any).__renderedHistoryStressEditor;
    let targetLine = 0;
    for (let lineNumber = 1; lineNumber <= editor.view.state.doc.lines; lineNumber += 1) {
      if (editor.view.state.doc.line(lineNumber).text.includes(lineNeedle)) {
        targetLine = lineNumber;
        if (targetOccurrence === 'first') break;
      }
    }
    if (targetLine) {
      editor.scrollToLine(targetLine, 'center');
      return;
    }
    throw new Error(`Missing rendered-block line: ${lineNeedle}`);
  }, { lineNeedle: needle, targetOccurrence: occurrence });
  await waitForFrames(page, 16);
  await page.evaluate(({ lineNeedle, targetOccurrence }) => {
    const editor = (window as any).__renderedHistoryStressEditor;
    const view = editor.view;
    let targetLine = 0;
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      if (!view.state.doc.line(lineNumber).text.includes(lineNeedle)) continue;
      targetLine = lineNumber;
      if (targetOccurrence === 'first') break;
    }
    if (targetLine < view.state.doc.lineAt(view.viewport.from).number || targetLine > view.state.doc.lineAt(view.viewport.to).number) {
      const block = view.lineBlockAt(view.state.doc.line(targetLine).from);
      view.scrollDOM.scrollTop = Math.max(0, block.top - 80);
    }
  }, { lineNeedle: needle, targetOccurrence: occurrence });
  await waitForFrames(page, 8);
}

async function clickModeButton(
  page: any,
  kind: BlockKind,
  needle: string,
  occurrence: NeedleOccurrence = 'first'
) {
  await page.evaluate(({ blockKind, lineNeedle, targetOccurrence }) => {
    const editor = (window as any).__renderedHistoryStressEditor;
    const view = editor.view;
    let targetLine = 0;
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      if (view.state.doc.line(lineNumber).text.includes(lineNeedle)) {
        targetLine = lineNumber;
        if (targetOccurrence === 'first') break;
      }
    }
    for (let lineNumber = targetLine; lineNumber >= 1; lineNumber -= 1) {
      const line = view.state.doc.line(lineNumber);
      const opening = blockKind === 'mermaid'
        ? line.text.trimStart().startsWith('```mermaid')
        : line.text.trim() === '$$';
      if (!opening) continue;
      const selector = blockKind === 'mermaid' ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find((candidate) => (
        candidate.closest<HTMLElement>('[data-meo-block-from]')?.dataset.meoBlockFrom === String(line.from)
      ));
      if (!button) throw new Error(`Missing ${blockKind} mode button for ${lineNeedle}`);
      button.click();
      return;
    }
    throw new Error(`Missing ${blockKind} opening line for ${lineNeedle}`);
  }, { blockKind: kind, lineNeedle: needle, targetOccurrence: occurrence });
  await waitForFrames(page);
}

async function setMode(
  page: any,
  kind: BlockKind,
  needle: string,
  targetMode: BlockMode,
  occurrence: NeedleOccurrence = 'first'
) {
  await scrollToNeedle(page, needle, occurrence);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mode = await page.evaluate(({ blockKind, lineNeedle, targetOccurrence }) => {
      const editor = (window as any).__renderedHistoryStressEditor;
      const view = editor.view;
      let targetLine = 0;
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        if (view.state.doc.line(lineNumber).text.includes(lineNeedle)) {
          targetLine = lineNumber;
          if (targetOccurrence === 'first') break;
        }
      }
      for (let lineNumber = targetLine; lineNumber >= 1; lineNumber -= 1) {
        const line = view.state.doc.line(lineNumber);
        const opening = blockKind === 'mermaid'
          ? line.text.trimStart().startsWith('```mermaid')
          : line.text.trim() === '$$';
        if (!opening) continue;
        const selector = blockKind === 'mermaid'
          ? `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${line.from}"]`
          : `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${line.from}"]`;
        const block = document.querySelector<HTMLElement>(selector);
        if (!block) return 'preview';
        return block.classList.contains('is-source') ? 'source' : 'split';
      }
      throw new Error(`Missing ${blockKind} block for ${lineNeedle}`);
    }, { blockKind: kind, lineNeedle: needle, targetOccurrence: occurrence });
    if (mode === targetMode) return;
    await clickModeButton(page, kind, needle, occurrence);
  }
  throw new Error(`Could not set ${kind} block ${needle} to ${targetMode}`);
}

async function editBlock(page: any, target: EditTarget, mode: Exclude<BlockMode, 'preview'>) {
  const occurrence = target.occurrence ?? 'first';
  await setMode(page, target.kind, target.needle, mode, occurrence);
  await page.evaluate(({ blockKind, lineNeedle, targetOccurrence }) => {
    const editor = (window as any).__renderedHistoryStressEditor;
    const view = editor.view;
    let targetLine = 0;
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      if (view.state.doc.line(lineNumber).text.includes(lineNeedle)) {
        targetLine = lineNumber;
        if (targetOccurrence === 'first') break;
      }
    }
    for (let lineNumber = targetLine; lineNumber >= 1; lineNumber -= 1) {
      const line = view.state.doc.line(lineNumber);
      const opening = blockKind === 'mermaid'
        ? line.text.trimStart().startsWith('```mermaid')
        : line.text.trim() === '$$';
      if (!opening) continue;
      const selector = blockKind === 'mermaid'
        ? `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${line.from}"]`
        : `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${line.from}"]`;
      const property = blockKind === 'mermaid'
        ? '__meoMermaidEditingController'
        : '__meoLatexMathEditingController';
      const block = document.querySelector<HTMLElement>(selector) as any;
      const controller = block?.[property];
      if (!controller) throw new Error(`Missing ${blockKind} controller for ${lineNeedle}`);
      controller.focusOffset(controller.innerView.state.doc.length);
      return;
    }
    throw new Error(`Missing ${blockKind} opening line for ${lineNeedle}`);
  }, { blockKind: target.kind, lineNeedle: target.needle, targetOccurrence: occurrence });
  await page.keyboard.type(target.marker);
  await waitForFrames(page);
}

async function assertFocusedTarget(page: any, target: EditTarget, direction: 'undo' | 'redo', step: number) {
  const state = await page.evaluate((blockKind) => {
    const selector = blockKind === 'mermaid' ? '.meo-mermaid-editing-block' : '.meo-latex-math-editing-block';
    const property = blockKind === 'mermaid'
      ? '__meoMermaidEditingController'
      : '__meoLatexMathEditingController';
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const focused = blocks.find((block) => (block as any)[property]?.innerView?.hasFocus) ?? null;
    return {
      focused: Boolean(focused),
      source: focused ? (focused as any)[property].innerView.state.doc.toString() : null,
      head: focused ? (focused as any)[property].innerView.state.selection.main.head : null,
      length: focused ? (focused as any)[property].innerView.state.doc.length : null,
      activeClass: (document.activeElement as HTMLElement | null)?.className?.toString() ?? null
    };
  }, target.kind);
  if (!state.focused || !state.source?.includes(target.needle) || state.head !== state.length) {
    throw new Error(`${direction} step ${step} did not focus ${target.kind} ${target.needle}: ${JSON.stringify(state)}`);
  }
}

async function main() {
  const realFixturePath = process.env.MEO_HISTORY_REAL_FIXTURE?.trim() || null;
  const realFixtureText = realFixturePath ? fs.readFileSync(realFixturePath, 'utf8') : null;
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 480, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((fixtureText) => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          await new Promise((resolve) => setTimeout(resolve, text.length % 17));
          return { svg: `<svg width="420" height="180"><text>${text.length}</text></svg>` };
        }
      };
      const gap = (label: string) => Array.from({ length: 8 }, (_, index) => `${label}-${index + 1}`);
      const longMermaid = Array.from({ length: 24 }, (_, index) => (
        `  L${String(index + 1).padStart(2, '0')} --> L${String(index + 2).padStart(2, '0')}`
      ));
      const text = fixtureText ?? [
        'TOP',
        '```mermaid', 'flowchart LR', 'M1_A --> M1_B', '```',
        ...gap('gap-a'),
        '$$', 'F1 = 1', '$$',
        ...gap('gap-b'),
        '- nested blocks', '',
        '  ```mermaid', '  sequenceDiagram', '    M2_A->>M2_B: hello', '  ```',
        ...gap('gap-c'),
        '  $$', '  F2 = 2', '  $$',
        ...gap('gap-d'),
        '```mermaid', 'flowchart TD', '  M3_ROOT --> L01', ...longMermaid, '```',
        ...gap('gap-e'),
        '$$', 'F3 = \\sum_{i=1}^{n} i', '$$',
        ...gap('gap-f'),
        '```mermaid', 'stateDiagram-v2', '  M4_A --> M4_B', '```',
        ...gap('gap-g'),
        '$$', 'F4 = \\int_0^1 x dx', '$$',
        'BOTTOM'
      ].join('\n');
      (window as any).__renderedHistoryStressEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, realFixtureText);
    await waitForFrames(page);

    const edits: Array<EditTarget & { mode: Exclude<BlockMode, 'preview'>; returnToPreview?: boolean }> = realFixtureText
      ? [
          { kind: 'mermaid', needle: 'Start --> Check --> Done', marker: ' M1_EDIT_A', mode: 'split', returnToPreview: true },
          {
            kind: 'math',
            needle: '\\int \\!\\!\\! \\int \\!\\!\\! \\int_V',
            marker: '555',
            occurrence: 'last',
            mode: 'split',
            returnToPreview: true
          },
          { kind: 'mermaid', needle: 'Step01[Open document]', marker: ' M2_EDIT_A', mode: 'split' },
          { kind: 'math', needle: '\\sum_{i=1}^{n}', marker: ' + F2_EDIT_A', mode: 'source' },
          { kind: 'mermaid', needle: 'User->>Editor: MERMAID_SPLIT_SEARCH_TARGET', marker: ' M3_EDIT_A', mode: 'source' },
          { kind: 'math', needle: 'E = mc^2', marker: ' + F3_EDIT_A', mode: 'split' },
          { kind: 'mermaid', needle: 'A[Open Markdown File]', marker: ' M4_EDIT_A', mode: 'split' },
          {
            kind: 'math',
            needle: '\\int_{-\\infty}^{\\infty} e^{-x^2}',
            marker: ' + F4_EDIT_A',
            occurrence: 'last',
            mode: 'source'
          },
          { kind: 'mermaid', needle: 'Start --> Check --> Done', marker: ' M1_EDIT_B', mode: 'source' },
          {
            kind: 'math',
            needle: '\\int \\!\\!\\! \\int \\!\\!\\! \\int_V',
            marker: ' F1_EDIT_B',
            occurrence: 'last',
            mode: 'split'
          },
          { kind: 'mermaid', needle: 'User->>Editor: MERMAID_SPLIT_SEARCH_TARGET', marker: ' M3_EDIT_B', mode: 'split' },
          { kind: 'math', needle: '\\sum_{i=1}^{n}', marker: ' + F2_EDIT_B', mode: 'split' }
        ]
      : [
          { kind: 'mermaid', needle: 'M1_A --> M1_B', marker: ' M1_EDIT_A', mode: 'split', returnToPreview: true },
          { kind: 'math', needle: 'F1 = 1', marker: ' + F1_EDIT_A', mode: 'split', returnToPreview: true },
          { kind: 'mermaid', needle: 'M2_A->>M2_B', marker: ' M2_EDIT_A', mode: 'split' },
          { kind: 'math', needle: 'F2 = 2', marker: ' + F2_EDIT_A', mode: 'source' },
          { kind: 'mermaid', needle: 'M3_ROOT --> L01', marker: ' M3_EDIT_A', mode: 'source' },
          { kind: 'math', needle: 'F3 =', marker: ' + F3_EDIT_A', mode: 'split' },
          { kind: 'mermaid', needle: 'M4_A --> M4_B', marker: ' M4_EDIT_A', mode: 'split' },
          { kind: 'math', needle: 'F4 =', marker: ' + F4_EDIT_A', mode: 'source' },
          { kind: 'mermaid', needle: 'M1_A --> M1_B', marker: ' M1_EDIT_B', mode: 'source' },
          { kind: 'math', needle: 'F1 = 1', marker: ' + F1_EDIT_B', mode: 'split' },
          { kind: 'mermaid', needle: 'M3_ROOT --> L01', marker: ' M3_EDIT_B', mode: 'split' },
          { kind: 'math', needle: 'F2 = 2', marker: ' + F2_EDIT_B', mode: 'split' }
        ];
    const versions = [await documentText(page)];
    for (const edit of edits) {
      await editBlock(page, edit, edit.mode);
      if (edit.returnToPreview) {
        await setMode(page, edit.kind, edit.needle, 'preview', edit.occurrence ?? 'first');
      }
      await new Promise((resolve) => setTimeout(resolve, 650));
      const text = await documentText(page);
      if (text === versions[versions.length - 1] || !text.includes(edit.marker)) {
        const state = await page.evaluate(() => ({
          activeClass: (document.activeElement as HTMLElement | null)?.className?.toString() ?? null,
          mermaidSources: Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-editing-block')).map((block: any) => ({
            anchor: block.dataset.meoMermaidAnchor,
            source: block.__meoMermaidEditingController?.innerView?.state.doc.toString() ?? null,
            focused: Boolean(block.__meoMermaidEditingController?.innerView?.hasFocus)
          }))
        }));
        throw new Error(`Edit did not reach outer history: ${JSON.stringify({ edit, state, text })}`);
      }
      versions.push(text);
    }

    for (let index = edits.length - 1; index >= 0; index -= 1) {
      await pressHistory(page, 'z');
      const actual = await documentText(page);
      if (actual !== versions[index]) {
        throw new Error(`undo step ${edits.length - index} stalled: ${JSON.stringify({ target: edits[index], expected: versions[index], actual })}`);
      }
      await assertFocusedTarget(page, edits[index], 'undo', edits.length - index);
    }

    for (let index = 0; index < edits.length; index += 1) {
      await pressHistory(page, 'y');
      const actual = await documentText(page);
      if (actual !== versions[index + 1]) {
        throw new Error(`redo step ${index + 1} stalled: ${JSON.stringify({ target: edits[index], expected: versions[index + 1], actual })}`);
      }
      await assertFocusedTarget(page, edits[index], 'redo', index + 1);
    }

    for (let count = 0; count < 6; count += 1) await pressHistory(page, 'z', false);
    await waitForFrames(page, 12);
    if (await documentText(page) !== versions[edits.length - 6]) {
      throw new Error('Rapid Mermaid/formula undo burst stalled or skipped history entries');
    }
    await assertFocusedTarget(page, edits[edits.length - 6], 'undo burst', 6);

    for (let count = 0; count < 6; count += 1) await pressHistory(page, 'y', false);
    await waitForFrames(page, 12);
    if (await documentText(page) !== versions[edits.length]) {
      throw new Error('Rapid Mermaid/formula redo burst stalled or skipped history entries');
    }
    await assertFocusedTarget(page, edits[edits.length - 1], 'redo burst', 6);

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await runHeldControlHistoryCycle(page, versions, edits.length, cycle, cycle === 1 ? 0 : 20);
      await assertFocusedTarget(page, edits[edits.length - 1], 'held-Control redo', cycle);
    }

    await runHeldKeyRepeatHistoryCycle(page, versions, edits.length);
    await assertFocusedTarget(page, edits[edits.length - 1], 'held-key redo', 1);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= edits.length + 8; count += 1) {
        await page.keyboard.down('z');
        const actual = await documentText(page);
        const expected = versions[Math.max(0, edits.length - count)];
        if (actual !== expected) {
          throw new Error(`Held Ctrl+Z crossed the history boundary at repeat ${count}`);
        }
      }
      await page.keyboard.up('z');
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForFrames(page, 12);
    const boundaryShortcutPrevented = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      });
      return document.activeElement ? !document.activeElement.dispatchEvent(event) : false;
    });
    if (!boundaryShortcutPrevented) {
      throw new Error('Ctrl+Z was not consumed at the Mermaid history boundary');
    }
    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= edits.length; count += 1) await page.keyboard.press('y');
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForFrames(page, 12);
    if (await documentText(page) !== versions[edits.length]) {
      throw new Error('Redo did not recover after the held Ctrl+Z history boundary test');
    }

    const immediateTypingUndoCount = 6;
    const immediateTypingTarget = edits[edits.length - immediateTypingUndoCount];
    await page.keyboard.down('Control');
    try {
      for (let count = 0; count < immediateTypingUndoCount; count += 1) {
        await page.keyboard.press('z');
      }
    } finally {
      await page.keyboard.up('Control');
    }
    const immediateTypingBefore = await page.evaluate(() => {
      const editor = (window as any).__renderedHistoryStressEditor;
      return { scrollTop: editor.view.scrollDOM.scrollTop };
    });
    await page.keyboard.type(' IMMEDIATE_AFTER_HISTORY');
    await waitForFrames(page, 20);
    const immediateTypingAfter = await page.evaluate((targetNeedle) => {
      const editor = (window as any).__renderedHistoryStressEditor;
      const block = Array.from(document.querySelectorAll<HTMLElement>('.meo-mermaid-editing-block')).find((candidate: any) => (
        candidate.__meoMermaidEditingController?.innerView?.state.doc.toString().includes(targetNeedle)
      )) as any;
      const innerView = block?.__meoMermaidEditingController?.innerView;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        source: innerView?.state.doc.toString() ?? null,
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null,
        length: innerView?.state.doc.length ?? null
      };
    }, immediateTypingTarget.needle);
    if (
      !immediateTypingAfter.source?.includes('IMMEDIATE_AFTER_HISTORY') ||
      !immediateTypingAfter.focused ||
      immediateTypingAfter.head !== immediateTypingAfter.length ||
      Math.abs(immediateTypingAfter.scrollTop - immediateTypingBefore.scrollTop) > 2
    ) {
      throw new Error(`Immediate typing after held-Control history lost focus or scrolled: ${JSON.stringify({ immediateTypingBefore, immediateTypingAfter })}`);
    }

    console.log(`rendered block history stress checks passed (${edits.length} undo + ${edits.length} redo + rapid and held-Control bursts)`);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
