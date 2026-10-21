import type { Page } from 'puppeteer-core';

export type MermaidTestLayout = 'preview' | 'stacked' | 'side-by-side';

export async function findMermaidOpening(page: Page, editorGlobal: string, needle: string, occurrence: 'first' | 'last' = 'first') {
  return page.evaluate(({ editorGlobal, needle, occurrence }) => {
    const doc = (window as any)[editorGlobal].view.state.doc;
    let target = 0;
    for (let line = 1; line <= doc.lines; line++) {
      if (!doc.line(line).text.includes(needle)) continue;
      target = line;
      if (occurrence === 'first') break;
    }
    for (let line = target; line >= 1; line--) {
      if (/(`{3,}|~{3,})mermaid\s*$/i.test(doc.line(line).text)) return line;
    }
    throw new Error(`Missing Mermaid opening for ${needle}`);
  }, { editorGlobal, needle, occurrence });
}

export async function mermaidSourceBounds(page: Page, editorGlobal: string, openingLine: number) {
  return page.evaluate(({ editorGlobal, openingLine }) => {
    const doc = (window as any)[editorGlobal].view.state.doc;
    const opening = doc.line(openingLine), fence = opening.text.match(/(`{3,}|~{3,})mermaid\s*$/i)?.[1];
    if (!fence) throw new Error(`Missing Mermaid opening at line ${openingLine}`);
    for (let number = openingLine + 1; number <= doc.lines; number++) {
      const text = doc.line(number).text.replace(/^\s*(?:>\s*)*/, '').trim();
      if (text !== fence) continue;
      const first = doc.line(openingLine + 1), last = doc.line(number - 1);
      const contentFrom = first.from + (first.text.match(/^\s*(?:>\s*)*/)?.[0].length ?? 0);
      return { from: first.from, contentFrom, to: number === openingLine + 1 ? first.from : last.to, opening: opening.from, closing: doc.line(number).to };
    }
    throw new Error(`Missing Mermaid closing after line ${openingLine}`);
  }, { editorGlobal, openingLine });
}

export async function enterMermaidSource(page: Page, editorGlobal: string, openingLine: number, edge: 'start' | 'end' = 'start') {
  const bounds = await mermaidSourceBounds(page, editorGlobal, openingLine);
  const position = edge === 'start' ? bounds.contentFrom : bounds.to;
  await page.evaluate(({ editorGlobal, position }) => {
    (window as any)[editorGlobal].revealSelection(position, position, { focusEditor: true, align: 'center' });
  }, { editorGlobal, position });
  await page.waitForFunction(({ editorGlobal, position }) => {
    const v = (window as any)[editorGlobal].view;
    return v.hasFocus && v.state.selection.main.head === position &&
      v.dom.querySelector('.meo-mermaid-toolbar[data-meo-mermaid-mode="edit"]') && v.coordsAtPos(position);
  }, {}, { editorGlobal, position });
  return bounds;
}

/** Drive the real edit/finish and layout actions; source positions belong to the document. */
export async function setMermaidLayout(page: Page, editorGlobal: string, openingLine: number, layout: MermaidTestLayout) {
  const bounds = await mermaidSourceBounds(page, editorGlobal, openingLine);
  await page.evaluate(({ editorGlobal, openingLine }) => {
    (window as any)[editorGlobal].scrollToLine(openingLine, 'center');
  }, { editorGlobal, openingLine });
  const args = { editorGlobal, anchor: bounds.opening };
  await page.waitForFunction(({ editorGlobal, anchor }) =>
    (window as any)[editorGlobal].view.dom.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]`), {}, args);
  const editing = () => page.evaluate(({ editorGlobal, anchor }) =>
    (window as any)[editorGlobal].view.dom.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]`)?.dataset.meoMermaidMode === 'edit', args);
  const click = async (selector: string) => {
    await page.waitForFunction(({ editorGlobal, selector }) => {
      const view = (window as any)[editorGlobal].view, viewport = view.scrollDOM.getBoundingClientRect();
      return Array.from(view.dom.querySelectorAll<HTMLElement>(selector)).some(node => {
        const r = node.getBoundingClientRect();
        return getComputedStyle(node).visibility !== 'hidden' && r.width > 0 && r.top >= viewport.top && r.bottom <= viewport.bottom;
      });
    }, {}, { editorGlobal, selector });
    const point = await page.evaluate(({ editorGlobal, selector }) => {
      const view = (window as any)[editorGlobal].view, viewport = view.scrollDOM.getBoundingClientRect();
      const node = Array.from(view.dom.querySelectorAll<HTMLElement>(selector)).find(node => {
        const r = node.getBoundingClientRect();
        return getComputedStyle(node).visibility !== 'hidden' && r.top >= viewport.top && r.bottom <= viewport.bottom;
      })!;
      const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { editorGlobal, selector });
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(({ editorGlobal, selector }) => {
      const view = (window as any)[editorGlobal].view;
      return Array.from(view.dom.querySelectorAll<HTMLElement>(selector)).some(node => {
        const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.width > 0 && r.height > 0 && node.contains(hit);
      });
    }, {}, { editorGlobal, selector });
    const handle = await page.evaluateHandle(({ editorGlobal, selector }) =>
      Array.from((window as any)[editorGlobal].view.dom.querySelectorAll(selector) as NodeListOf<HTMLElement>).find(node => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }), { editorGlobal, selector });
    try { await handle.asElement()!.click(); } finally { await handle.dispose(); }
  };
  if (await editing() !== (layout !== 'preview')) {
    await click(`.meo-mermaid-toolbar[data-meo-block-from="${bounds.opening}"] .meo-mermaid-mode-btn`);
    await page.waitForFunction(({ editorGlobal, anchor, expected }) =>
      ((window as any)[editorGlobal].view.dom.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]`)?.dataset.meoMermaidMode === 'edit') === expected,
    {}, { ...args, expected: layout !== 'preview' });
  }
  if (layout === 'preview') return bounds;
  const side = () => page.evaluate(({ editorGlobal, anchor }) => !!(window as any)[editorGlobal].view.dom.querySelector(`.meo-mermaid-inline-preview[data-meo-mermaid-anchor="${anchor}"]`), args);
  if (await side() !== (layout === 'side-by-side')) {
    if (!await side()) await page.evaluate(({ editorGlobal, to }) => {
      const editor = (window as any)[editorGlobal]; editor.scrollToLine(editor.view.state.doc.lineAt(to).number, 'center');
    }, { editorGlobal, to: bounds.to });
    await click(`[data-meo-mermaid-anchor="${bounds.opening}"] .meo-mermaid-layout-btn:not(:disabled)`);
    await page.waitForFunction(({ editorGlobal, anchor, expected }) =>
      !!(window as any)[editorGlobal].view.dom.querySelector(`.meo-mermaid-inline-preview[data-meo-mermaid-anchor="${anchor}"]`) === expected,
    {}, { ...args, expected: layout === 'side-by-side' });
  }
  return bounds;
}

export async function readMermaidHistoryTarget(page: Page, editorGlobal: string, openingLine: number) {
  const bounds = await mermaidSourceBounds(page, editorGlobal, openingLine);
  return page.evaluate(({ editorGlobal, bounds }) => {
    const view = (window as any)[editorGlobal].view, selection = view.state.selection.main;
    const coords = view.coordsAtPos(selection.head), viewport = view.scrollDOM.getBoundingClientRect();
    return { source: view.state.doc.sliceString(bounds.from, bounds.to), focused: view.hasFocus && document.activeElement === view.contentDOM,
      caretAtEnd: selection.empty && selection.head === bounds.to, head: selection.head - bounds.from, length: bounds.to - bounds.from,
      visible: !!coords && coords.bottom > viewport.top && coords.top < viewport.bottom, scrollTop: view.scrollDOM.scrollTop,
      resultPresent: !!view.dom.querySelector(`[data-meo-mermaid-anchor="${bounds.opening}"] .meo-mermaid-block`),
      side: !!view.dom.querySelector(`.meo-mermaid-inline-preview[data-meo-mermaid-anchor="${bounds.opening}"]`) };
  }, { editorGlobal, bounds });
}
