import type { Page } from 'puppeteer-core';

export async function findDisplayMathOpening(page: Page, editorGlobal: string, needle: string, occurrence: 'first' | 'last' = 'first') {
  return page.evaluate(({ editorGlobal, needle, occurrence }) => {
    const doc = (window as any)[editorGlobal].view.state.doc;
    let target = 0;
    for (let line = 1; line <= doc.lines; line++) {
      if (!doc.line(line).text.includes(needle)) continue;
      target = line;
      if (occurrence === 'first') break;
    }
    for (let line = target; line >= 1; line--) {
      const text = doc.line(line).text.replace(/^\s*(?:>\s*)*/, '').trim();
      if (text === '$$' || /^(`{3,}|~{3,})(math|latex|tex|katex)\s*$/i.test(text)) return line;
    }
    throw new Error(`Missing formula opening for ${needle}`);
  }, { editorGlobal, needle, occurrence });
}

/** Native formulas use document positions, so history drivers never acquire an inner editor. */
export async function displayMathSourceBounds(page: Page, editorGlobal: string, openingLine: number) {
  return page.evaluate(({ editorGlobal, openingLine }) => {
    const doc = (window as any)[editorGlobal].view.state.doc;
    const opening = doc.line(openingLine);
    const stripContainer = (text: string) => text.replace(/^\s*(?:>\s*)*/, '').trim();
    const openingText = stripContainer(opening.text);
    const fence = openingText === '$$' ? '$$' : openingText.match(/^(`{3,}|~{3,})(?:math|latex|tex|katex)\s*$/i)?.[1];
    if (!fence) throw new Error(`Missing formula opening at line ${openingLine}`);
    for (let number = openingLine + 1; number <= doc.lines; number++) {
      if (stripContainer(doc.line(number).text) !== fence) continue;
      const first = doc.line(openingLine + 1), last = doc.line(number - 1);
      return { from: first.from, to: number === openingLine + 1 ? first.from : last.to, opening: opening.from, closing: doc.line(number).to };
    }
    throw new Error(`Missing formula closing after line ${openingLine}`);
  }, { editorGlobal, openingLine });
}

export async function enterDisplayMathSource(page: Page, editorGlobal: string, openingLine: number, edge: 'start' | 'end' = 'start') {
  const bounds = await displayMathSourceBounds(page, editorGlobal, openingLine);
  await page.evaluate(({ editorGlobal, position }) => {
    (window as any)[editorGlobal].revealSelection(position, position, { focusEditor: true, align: 'center' });
  }, { editorGlobal, position: edge === 'start' ? bounds.from : bounds.to });
  // Source expansion can change the document height; settle navigation against
  // the expanded source before measuring the target caret.
  await page.evaluate(async ({ editorGlobal, position }) => {
    const editor = (window as any)[editorGlobal];
    await editor.whenVisiblePresentationReady(1_200);
    editor.scrollToLine(editor.view.state.doc.lineAt(position).number, 'center');
    editor.revealSelection(position, position, { focusEditor: true, align: 'none' });
  }, { editorGlobal, position: edge === 'start' ? bounds.from : bounds.to });
  await page.waitForFunction(({ editorGlobal, position }) => {
    const view = (window as any)[editorGlobal].view;
    const coords = view.coordsAtPos(position), viewport = view.scrollDOM.getBoundingClientRect();
    return view.hasFocus && document.activeElement === view.contentDOM &&
      view.state.selection.main.empty && view.state.selection.main.head === position &&
      document.querySelector('.meo-math-source-line') && coords &&
      coords.bottom > viewport.top && coords.top < viewport.bottom;
  }, {}, { editorGlobal, position: edge === 'start' ? bounds.from : bounds.to });
  return bounds;
}

export async function readDisplayMathHistoryTarget(page: Page, editorGlobal: string, openingLine: number, options: { waitForVisibility?: boolean } = {}) {
  const bounds = await displayMathSourceBounds(page, editorGlobal, openingLine);
  const sample = ({ editorGlobal, bounds, waitForVisibility }: { editorGlobal: string; bounds: { from: number; to: number }; waitForVisibility?: boolean }) => {
    const view = (window as any)[editorGlobal].view;
    const selection = view.state.selection.main;
    const coords = view.coordsAtPos(selection.head), viewport = view.scrollDOM.getBoundingClientRect();
    const result = {
      source: view.state.doc.sliceString(bounds.from, bounds.to),
      focused: view.hasFocus && document.activeElement === view.contentDOM,
      caretAtEnd: selection.empty && selection.head === bounds.to,
      head: selection.head, expectedHead: bounds.to,
      visible: !!coords && coords.bottom > viewport.top && coords.top < viewport.bottom,
      resultPresent: !!document.querySelector('.meo-math-live-result')
    };
    return waitForVisibility && (!result.focused || !result.visible) ? false : result;
  };
  const args = { editorGlobal, bounds, waitForVisibility: options.waitForVisibility };
  if (options.waitForVisibility) {
    const handle = await page.waitForFunction(sample, {}, args);
    try { return await handle.jsonValue() as Exclude<ReturnType<typeof sample>, false>; }
    finally { await handle.dispose(); }
  }
  const result = await page.evaluate(sample, args);
  if (result === false) throw new Error('Unexpected pending formula target');
  return result;
}
