import { EditorState, StateEffect } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { collectRenderableHtmlBlocks } from '../webview/src/helpers/htmlContent';
import { getDetailsBlocks, detailsBlockStateExtensions, detailsBlockLiveExtensions, toggleDetailsBlock } from '../webview/src/helpers/detailsBlocks';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { formatHtmlFragment } from '../webview/src/editor/htmlFormatting';
import { checkHtmlStyleRendering } from './test-html-styles-browser';

{
// HTML discovery also depends on the runtime details owner, even with the
// same immutable document and syntax tree during Source-to-Live activation.
let state = EditorState.create({ doc: '<details open><summary>Stable</summary>Body.</details>\n\nInput.',
  extensions: [editorMarkdownLanguage, detailsBlockStateExtensions()] });
ensureSyntaxTree(state, state.doc.length, 1000);
state = state.update({}).state;
const initial = collectRenderableHtmlBlocks(state);
const doc = state.doc, tree = syntaxTree(state);
state = state.update({ effects: StateEffect.appendConfig.of(detailsBlockLiveExtensions()) }).state;
assert.equal(state.doc, doc);
assert.equal(syntaxTree(state), tree);
assert.equal(getDetailsBlocks(state)[0]?.collapsed, false);
const active = collectRenderableHtmlBlocks(state);
console.log(JSON.stringify({ initial: initial[0]?.detailsCollapsed, active: active[0]?.detailsCollapsed,
  expected: getDetailsBlocks(state)[0]?.collapsed }));
assert.equal(active[0]?.detailsCollapsed, false, 'HTML cache must observe activated details state on the same doc and tree');
const view = { get state() { return state; }, dispatch(spec: any) { state = state.update(spec).state; },
  dom: { querySelectorAll: () => [] }, focus() {} };
assert.ok(toggleDetailsBlock(view as any, getDetailsBlocks(state)[0]!.anchorFrom));
assert.equal(collectRenderableHtmlBlocks(state)[0]?.detailsCollapsed, true, 'HTML cache must observe a collapse without a source edit');
console.log('HTML cache context probe passed');
}

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-content-'));
const artifacts = path.join(repoRoot, '.local', 'html-fragment-acceptance');
fs.mkdirSync(artifacts, { recursive: true });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n5QAAAAASUVORK5CYII=';
const source = [
  'HTML fragment acceptance', '', 'Prelude paragraph.', '',
  'Inline <span style="color:red">**bold** <span>nested</span></span>, <u>underlined</u>, <kbd>Ctrl</kbd>, and <ruby>字<rt>zi</rt></ruby>.', '',
  '<p id="center" align="center" style="color:red;position:fixed;background-image:url(https://example.com/x)" onclick="alert(1)">',
  '  <a href="#target">English</a> · <strong>简体中文</strong>',
  '  <a href="https://example.com/docs">Docs</a>',
  '</p>', '',
  '<div id="html-test-top"></div>',
  '<div id="target"><p>Adjacent visible fragment</p></div>', '',
  '<div hidden>Hidden content</div>', '',
  '<div style="display:none">Styled hidden content</div>', '',
  '<div style="color:transparent">Transparent content</div>', '',
  '<div style="color:#1230">Transparent short hex</div>', '',
  '<div style="color:#12345600">Transparent hex</div>', '',
  '<div style="color:transparent;background-color:currentColor"><span style="color:inherit">Inherited transparent content</span></div>', '',
  '<div style="font-size:0">Zero-size content</div>', '',
  '<div style="height:12px"></div>', '',
  '<div id="color-box" style="height:12px;background-color:red"></div>', '',
  '<h2>HTML heading</h2>', '',
  '<section><p>Semantic section</p></section>', '',
  '<details open>',
  '<summary><strong>Rich summary</strong> <kbd>Enter</kbd></summary>',
  '<p>First details paragraph.</p>',
  '<p>Second details paragraph.</p>',
  '</details>', '',
  '<blockquote><p><strong>HTML quote:</strong> quoted text.</p></blockquote>', '',
  '<table><caption>HTML table caption</caption><thead><tr><th>Type</th><th>Result</th></tr></thead>',
  '<tbody><tr><td rowspan="2">HTML</td><td>Rendered</td></tr><tr><td>Second row</td></tr></tbody></table>', '',
  `<figure><img src="${image}" alt="Nested image" width="40" style="width:60px"><figcaption>Image caption</figcaption></figure>`, '',
  `<div id="hidden-children">Visible sibling <a hidden href="https://example.com/hidden">Hidden link</a><img hidden src="${image}"><a hidden href="https://example.com/image"><img src="${image}"></a></div>`, '',
  `<img id="standalone-image" src="${image}" width="24" height="24">`, '',
  `Inline image <img id="inline-image" src="${image}" width="16" height="16"> in prose.`, '',
  '<pre><code>**literal** &lt;tag&gt;</code></pre>', '',
  '<div><p>First raw paragraph.</p>', '', '<p>Second raw paragraph.</p></div>', '',
  '<script>window.__htmlExecuted=1;const raw="<div>";</script>', '',
  '<p id="after-script">After unsupported script</p>', '',
  '<custom-html>Unsupported source remains visible</custom-html>', '',
  '<!-- visible comment -->', '', 'Tail paragraph.', '', '$$', 'x^2 + 1', '$$'
].join('\n');

async function frames(page: Page, count = 6): Promise<void> {
  await page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, count);
}

async function select(page: Page, needle: string, offset = 0): Promise<void> {
  await page.evaluate(({ needle, offset }) => {
    const view = (window as any).__htmlEditor.view;
    const position = view.state.doc.toString().indexOf(needle);
    if (position < 0) throw new Error(`Missing source: ${needle}`);
    view.dispatch({ selection: { anchor: position + offset }, scrollIntoView: true });
    view.focus();
  }, { needle, offset });
  await frames(page);
}

function checkExport(): void {
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const html = renderMarkdownToHtml({ markdownText: source, markdownFilePath: path.join(tempDir, 'source.md'), target }).html;
    assert.match(html, /<p[^>]*id="center"[^>]*style="color:red"/);
    assert.match(html, /<h2>HTML heading<\/h2>/);
    assert.match(html, /<section><p>Semantic section<\/p><\/section>/);
    assert.match(html, /<ruby>字<rt>zi<\/rt><\/ruby>/);
    assert.match(html, /<caption>HTML table caption<\/caption>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>\*\*literal\*\* &lt;tag&gt;<\/code>/);
    assert.match(html, /<div id="html-test-top"><\/div>/);
    assert.match(html, /<div hidden="hidden">Hidden content<\/div>/);
    assert.match(html, /&lt;custom-html&gt;/);
    assert.doesNotMatch(html, /onclick=|position:fixed|background-image|meo-md-html-invisible-source/);
    assert.doesNotMatch(html, /visible comment/);
  }
  const unsafe = renderMarkdownToHtml({ markdownText: '<p style="constructor:bad;__proto__:bad;color:expression(alert(1));width:10px;background:url(javascript:alert(1))"><a href="javascript:alert(1)">safe text</a></p>', markdownFilePath: path.join(tempDir, 'unsafe.md'), target: 'html' }).html;
  assert.doesNotMatch(unsafe, /javascript:|expression\(|background:/);
  assert.match(unsafe, /width:10px/);
  const mixed = renderMarkdownToHtml({ markdownText: '<div>\n\n**Markdown body**\n\n</div>', markdownFilePath: path.join(tempDir, 'mixed.md'), target: 'html' }).html;
  assert.match(mixed, /<div[^>]*>\s*<p[^>]*><strong>Markdown body<\/strong><\/p>\s*<\/div>/);
}

async function checkSourceExpansionAnchor(page: Page): Promise<void> {
  await page.setViewport({ width: 1100, height: 700 });
  await page.addStyleTag({ content: ':root{--meo-user-editor-font-size:20px;--meo-font-live-size:20px;--meo-user-editor-line-height:1.5;--meo-line-height-live:1.5;--meo-font-source:monospace}' });
  const before = [
    '<section id="html-section-demo">', '<h2>这是 HTML 二级标题</h2>',
    '<p>这是 section 中的段落，包含 <strong>强调</strong> 和 <a href="https://example.com/">示例链接</a>。</p>',
    '<p><small>这一行是补充说明。</small></p>', '</section>', '',
    '<article>', '<h3>HTML 文章片段</h3>', '<blockquote>', '<p>引用中的第一段。</p>',
    '<p>引用中的第二段，包含 <em>斜体</em>。</p>', '</blockquote>', '</article>', '',
    '<dl>', '<dt>Live</dt>', '<dd>直接查看内容，并在原位编辑源码。</dd>',
    '<dt>Preview</dt>', '<dd>查看最终阅读效果。</dd>', '</dl>', '',
    '## Expansion witness', '', 'Instruction before the edited block.', ''
  ].join('\n');
  const after = [
    '<p style="text-align:right;color:rgb(180,83,9);font-style:italic">右对齐，RGB 颜色，斜体。</p>', '',
    '<p style="background-color:#fef3c7;color:#78350f;text-decoration:underline">浅黄色背景、深色文字与下划线。</p>', '',
    '<div style="width:75%;max-width:420px;min-height:36px;background-color:#dbeafe;color:#1e3a8a">有宽度限制的容器：窗口变窄时，检查文字能否保持可读。</div>', '',
    '<div style="white-space:pre-wrap">这一行保留    多个空格。\n这是第二行。\n这是第三行：中文 English 123。</div>'
  ].join('\n');
  for (const kind of ['html', 'math']) {
    const block = kind === 'html'
      ? '<p id="expansion-target" style="text-align:center;color:#2563eb;font-size:20px;font-weight:bold">居中、蓝色、20px、加粗</p>'
      : '$$\nx^2 + 1\n$$';
    const text = `${Array.from({ length: 40 }, (_, n) => `Leading paragraph ${n}.\n`).join('\n')}\n${before}\n${block}\n\n${after}\n\n${Array.from({ length: 40 }, (_, n) => `Trailing paragraph ${n}.\n`).join('\n')}`;
    await page.evaluate(text => {
      const editor = (window as any).__htmlEditor;
      editor.setText(text, true);
      editor.scrollToLine(editor.view.state.doc.lineAt(text.indexOf('Expansion witness')).number, 'center');
    }, text);
    const target = kind === 'html' ? '#expansion-target' : '.meo-md-math-fenced-display .katex';
    await page.waitForSelector(target);
    await page.evaluate(async target => {
      const view = (window as any).__htmlEditor.view;
      view.scrollDOM.scrollTop += document.querySelector(target)!.getBoundingClientRect().top - 470;
      for (let n = 0; n < 12; n++) await new Promise(requestAnimationFrame);
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Instruction before') + 5 } });
      view.focus();
    }, target);
    await frames(page, 8);
    await page.mouse.move(600, 500);
    await page.mouse.wheel({ deltaY: 80 });
    await frames(page, 12);
    await page.evaluate(() => {
      const view = (window as any).__htmlEditor.view;
      const top = () => (Array.from(view.dom.querySelectorAll('.cm-line')).find((line: any) => line.textContent.includes('Expansion witness')) as HTMLElement).getBoundingClientRect().top;
      const probe = { baseline: top(), samples: [] as number[] };
      (window as any).__htmlExpansionProbe = probe;
      const sample = () => { probe.samples.push(top()); if (probe.samples.length < 30) requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
    });
    await page.click(target);
    await frames(page, 30);
    const movement = await page.evaluate(() => {
      const probe = (window as any).__htmlExpansionProbe;
      return Math.max(...probe.samples.map((top: number) => Math.abs(top - probe.baseline)));
    });
    assert.ok(movement <= 1, `${kind}: opening source after trusted wheel input moved preceding content by ${movement}px: ` +
      JSON.stringify(await page.evaluate(() => (window as any).__htmlExpansionProbe)));
  }
}

async function checkHtmlPointerEditing(page: Page): Promise<void> {
  const html = '<ul>\n  <li>First</li>\n  <li>Second</li>\n</ul>';
  for (const kind of ['html', 'math'] as const) {
    await page.evaluate(({ kind, html }) => {
      const editor = (window as any).__htmlEditor;
      const text = 'Before.\n\n' + (kind === 'html' ? html : '$$\nx^2 + 1\n$$') + '\n\nBelow paragraph.\n\nTail.';
      editor.setText(text, true);
      editor.view.dispatch({ selection: { anchor: text.indexOf(kind === 'html' ? 'First' : 'x^2') + 1 } }); editor.view.focus();
    }, { kind, html });
    await frames(page);
    if (kind === 'html') {
      const points = await page.evaluate(() => {
        const lines = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-source-range'));
        const first = lines[0].getBoundingClientRect(), last = lines.at(-1)!.getBoundingClientRect();
        return { x: last.left + 14, y: last.top + last.height / 2, fromX: first.left + 1, fromY: first.top + first.height / 2 };
      });
      await page.mouse.click(points.x, points.y); await frames(page);
      assert.equal(await page.evaluate(() => {
        const view = (window as any).__htmlEditor.view; return view.state.doc.lineAt(view.state.selection.main.head).text;
      }), '</ul>', 'The closing HTML source row accepts a native caret');
      await page.mouse.move(points.fromX, points.fromY); await page.mouse.down(); await page.mouse.move(points.x + 25, points.y, { steps: 8 });
      assert.doesNotMatch(await page.evaluate(() => window.getSelection()?.toString() ?? ''), /Format|格式化/);
      assert.equal(await page.$eval('.meo-md-html-source-actions', e => getComputedStyle(e).userSelect), 'none');
      await page.mouse.up(); await frames(page);
    }
    const below = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).find(n => n.textContent === 'Below paragraph.')!;
      const rect = line.getBoundingClientRect(); return { x: rect.left + 25, y: rect.top + rect.height / 2 };
    });
    const selector = kind === 'html' ? '.meo-md-html-live-result' : '.meo-math-live-result';
    await page.mouse.move(below.x, below.y); await page.mouse.down(); await frames(page);
    assert.ok(await page.$(selector), `${kind}: source and preview stay mounted while the pointer is held`);
    await page.mouse.up(); await frames(page);
    assert.equal(await page.$(selector), null, `${kind}: source collapses after release outside the block`);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.selection.main.empty), true, `${kind}: clicking below creates no unintended selection`);
  }
  for (const kind of ['html', 'math'] as const) {
    await page.evaluate(({ kind, html }) => {
      const editor = (window as any).__htmlEditor;
      const block = kind === 'html' ? html : '$$\nx^2 + 1\n$$';
      const text = `Before.\n\n${block}\n\n| Key | Value |\n| --- | ---: |\n| target | 11 |\n\nAfter.`;
      editor.setText(text, true);
      editor.view.dispatch({ selection: { anchor: text.indexOf(kind === 'html' ? 'First' : 'x^2') + 1 } });
      editor.view.focus();
    }, { kind, html });
    await frames(page);
    const target = await page.evaluate(() => {
      const cell = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find(input => input.value === '11')!;
      const rect = cell.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top };
    });
    const selector = kind === 'html' ? '.meo-md-html-live-result' : '.meo-math-live-result';
    await page.mouse.move(target.x, target.y); await page.mouse.down(); await frames(page);
    assert.ok(await page.$(selector), `${kind}: entering a table preserves source until pointer release`);
    assert.ok(Math.abs(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
      .find(input => input.value === '11')!.getBoundingClientRect().top) - target.top) <= 1,
    `${kind}: a held table click must not move its target`);
    await page.mouse.up(); await frames(page);
    assert.equal(await page.$(selector), null, `${kind}: entering a table collapses source after release`);
    assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.value : null), '11',
      `${kind}: release enters the table's native input`);
    await page.keyboard.press('End'); await page.keyboard.type('_edited'); await frames(page);
    assert.match(await page.evaluate(() => (window as any).__htmlEditor.getText()), /\| target \| 11_edited \|/,
      `${kind}: the same table input remains editable after source collapse`);
  }
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
}

async function checkHtmlLayoutAndSourceCopy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = window as any;
    g.__htmlCopyShortcutHandler = (event: KeyboardEvent) => g.HtmlContentHarness.handleEditorShortcut(event, {
      editor: g.__htmlEditor, editableMode: 'live', editorSurfaceActive: true, shortcuts: {},
      platform: 'other', requestSave() {}, openFindPanel() {}, requestMode() {}
    });
    document.addEventListener('keydown', g.__htmlCopyShortcutHandler, true);
  });
  // A hidden last child leaves the preceding paragraph's bottom margin exposed.
  // Every pixel must stay inside the widget measured by CodeMirror.
  for (const tail of ['<p hidden>Hidden tail.</p>', '<span style="display:none">Hidden tail.</span>',
    '<div><p>Nested last paragraph.</p><p hidden>Hidden tail.</p></div>']) {
    const prefix = `Before.\n\n<div><p>Visible paragraph.</p>${tail}</div>\n\n`;
    for (const kind of ['html', 'math'] as const) {
      const block = kind === 'html'
        ? '<ul>\n  <li>First.</li>\n  <li>Second.</li>\n</ul>'
        : '$$\nx^2 + 1\n+ y^2\n$$';
      await page.evaluate(({ prefix, block }) => {
        const editor = (window as any).__htmlEditor;
        const text = prefix + block + '\n\nAfter.';
        editor.setText(text, true);
        editor.view.dispatch({ selection: { anchor: prefix.length + 5 } }); editor.view.focus();
        editor.view.scrollDOM.scrollTop = 0;
      }, { prefix, block });
      await frames(page);
      const geometry = await page.evaluate(() => {
        const view = (window as any).__htmlEditor.view;
        return Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).map(line => {
          const pos = view.posAtDOM(line, 0), number = view.state.doc.lineAt(pos).number;
          const block = view.lineBlockAt(pos);
          const textBlock = Array.isArray(block.type) ? block.type.find((part: any) => part.type === 0) : block;
          const top = line.getBoundingClientRect().top;
          const gutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
            .find(node => node.textContent === String(number) && node.style.visibility !== 'hidden');
          return { number, top, measuredTop: view.documentTop + textBlock.top,
            gutterTop: gutter?.getBoundingClientRect().top };
        });
      });
      for (const row of geometry) {
        assert.ok(Math.abs(row.top - row.measuredTop) <= 1, `${kind}: line ${row.number} layout differs from editor measurement by ${row.top - row.measuredTop}px`);
        assert.ok(row.gutterTop !== undefined && Math.abs(row.top - row.gutterTop) <= 1, `${kind}: line ${row.number} gutter must align with source`);
      }
      const points = await page.evaluate(({ prefix, block }) => {
        const view = (window as any).__htmlEditor.view;
        const lines = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'));
        const first = lines.find(node => view.posAtDOM(node, 0) === prefix.length)!;
        const last = lines.find(node => view.posAtDOM(node, 0) === prefix.length + block.lastIndexOf('\n') + 1)!;
        const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(last);
        return { fromX: a.left + 1, fromY: a.top + a.height / 2,
          toX: range.getBoundingClientRect().right + 1, toY: b.top + b.height / 2 };
      }, { prefix, block });
      await page.mouse.click(points.toX, points.toY); await frames(page);
      assert.equal(await page.evaluate(() => {
        const view = (window as any).__htmlEditor.view; return view.state.doc.lineAt(view.state.selection.main.head).text;
      }), kind === 'html' ? '</ul>' : '$$', `${kind}: click the actual final source row`);
      await page.mouse.move(points.fromX, points.fromY); await page.mouse.down();
      await page.mouse.move(points.toX, points.toY, { steps: 12 }); await page.mouse.up(); await frames(page);
      assert.equal(await page.evaluate(() => {
        const view = (window as any).__htmlEditor.view; return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
      }), block, `${kind}: native dragging selects the entire source`);
      await page.evaluate(() => {
        const input = document.createElement('textarea'); input.id = 'html-copy-roundtrip';
        input.style.cssText = 'position:fixed;right:0;bottom:0;width:100px;height:30px'; document.body.append(input);
      });
      try {
        await page.keyboard.down('Control'); await page.keyboard.press('KeyC'); await page.keyboard.up('Control');
        await page.click('#html-copy-roundtrip');
        await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
        assert.equal(await page.$eval('#html-copy-roundtrip', node => (node as HTMLTextAreaElement).value), block,
          `${kind}: Ctrl+C and Ctrl+V preserve the complete raw source`);
      } finally { await page.$eval('#html-copy-roundtrip', node => node.remove()); }
    }
  }
  await page.evaluate(() => {
    const g = window as any; document.removeEventListener('keydown', g.__htmlCopyShortcutHandler, true);
    delete g.__htmlCopyShortcutHandler;
  });
}

async function checkHtmlCrossBlockSelection(page: Page): Promise<void> {
  const html = '<div>\n<p>HTML_RENDERED</p>\n</div>';
  const math = '$$\nx^2 + y^2\n$$';
  const text = `Before.\n\n${html}\n\nBetween.\n\n${math}\n\nAfter.`;
  const setup = async (kind: 'html' | 'math') => {
    await page.evaluate(({ text, kind }) => {
      const editor = (window as any).__htmlEditor;
      editor.setText(text, true);
      editor.view.dispatch({ selection: { anchor: text.indexOf(kind === 'html' ? 'HTML_RENDERED' : 'x^2') + 1 } });
      editor.view.focus(); editor.view.scrollDOM.scrollTop = 0;
    }, { text, kind });
    await frames(page);
  };
  const copiedSource = () => page.evaluate(() => {
    const view = (window as any).__htmlEditor.view, data = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
    view.contentDOM.dispatchEvent(event);
    const range = view.state.selection.main;
    return { source: view.state.sliceDoc(range.from, range.to), copied: data.getData('text/plain'),
      native: window.getSelection()?.toString() ?? '', anchor: range.anchor, head: range.head };
  });
  for (const kind of ['html', 'math'] as const) for (const backwards of [false, true]) {
    await setup(kind);
    const points = await page.evaluate(({ kind, backwards }) => {
      const view = (window as any).__htmlEditor.view, source = view.state.doc.toString();
      const from = source.indexOf(kind === 'html' ? '<div>' : '$$');
      const to = source.length;
      const point = (pos: number) => { const r = view.coordsAtPos(pos)!; return { x: r.left + 0.5, y: (r.top + r.bottom) / 2 }; };
      const ends = [point(from), point(to)]; return backwards ? ends.reverse() : ends;
    }, { kind, backwards });
    await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 20 });
    const nativeDuring = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    await page.mouse.up(); await frames(page);
    const selected = await copiedSource();
    assert.equal(selected.source, text.slice(text.indexOf(kind === 'html' ? '<div>' : '$$')), `${kind}: cross-block drag range`);
    assert.equal(selected.copied, selected.source, `${kind}: cross-block copy uses document source`);
    assert.equal(selected.anchor > selected.head, backwards, `${kind}: cross-block drag direction`);
    assert.doesNotMatch(nativeDuring, /预览|Preview/, `${kind}: result label must not enter a source drag`);
    if (kind === 'html') assert.equal((nativeDuring.match(/HTML_RENDERED/g) ?? []).length, 1, 'HTML result must not duplicate selected source');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyX'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text.slice(0, text.indexOf(kind === 'html' ? '<div>' : '$$')),
      `${kind}: cross-block cut preserves preceding unselected content`);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, `${kind}: one undo restores a partial cross-block cut`);
  }
  for (const backwards of [false, true]) {
    await setup('html');
    const start = backwards ? text.length : 0;
    await page.evaluate(start => {
      const view = (window as any).__htmlEditor.view; view.dispatch({ selection: { anchor: start } }); view.focus();
    }, start);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift');
    await page.keyboard.press(backwards ? 'Home' : 'End');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await frames(page);
    const selected = await copiedSource();
    assert.equal(selected.source, text, 'Keyboard extension crosses HTML and math without losing source');
    assert.equal(selected.copied, text, 'Keyboard cross-block copy is exact');
    assert.equal(selected.anchor > selected.head, backwards, 'Keyboard extension retains direction');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyX'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), '', 'Cross-block cut removes the exact selection');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, 'One undo restores the entire cross-block cut');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), '', 'One redo reapplies the cross-block cut');
  }
  await setup('html');
  await page.evaluate(() => {
    const view = (window as any).__htmlEditor.view; view.dispatch({ selection: { anchor: 0 } }); view.focus();
  }); await frames(page);
  const word = await page.evaluate(() => {
    const node = document.querySelector('.meo-md-html-block:not(.meo-md-html-live-result) p')!;
    const range = document.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect();
    return { x: r.left + 0.5, y: (r.top + r.bottom) / 2, end: r.right - 0.5 };
  });
  await page.mouse.move(word.x, word.y); await page.mouse.down(); await page.mouse.move(word.end, word.y, { steps: 8 }); await page.mouse.up(); await frames(page);
  assert.match(await page.evaluate(() => window.getSelection()?.toString() ?? ''), /HTML_RENDERED/, 'Reading HTML retains native text selection');
  assert.equal(await page.$('.meo-md-html-live-result'), null, 'Reading selection does not enter HTML source');
  await page.screenshot({ path: path.join(artifacts, 'html-reading-selection.png') });
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
}

async function checkHtmlPasteEditing(page: Page): Promise<void> {
  const before = 'Before.\n\n\n\nAfter.';
  const insertAt = before.indexOf('\n\n') + 2;
  const fragment = '<div id="pasted-html"><p>First</p><p>Second</p></div>';
  for (const [name, pasted, plain] of [
    ['block', fragment, false], ['trailing-lines', fragment + '\n\n', false],
    ['plain-paste', fragment + '\n', true],
    ['invisible', '<div id="pasted-html"></div>', false],
    ['siblings', '<p>Earlier sibling</p>\n\n' + fragment, false]
  ] as const) {
    await page.evaluate(({ before, insertAt }) => {
      const editor = (window as any).__htmlEditor;
      editor.setText(before, true); editor.view.dispatch({ selection: { anchor: insertAt } }); editor.view.focus();
    }, { before, insertAt });
    await frames(page);
    const top = await page.$eval('.cm-line', e => e.getBoundingClientRect().top);
    await page.evaluate(({ pasted, plain }) => {
      const editor = (window as any).__htmlEditor;
      if (plain) editor.pastePlainText(pasted);
      else {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', pasted);
        editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }
    }, { pasted, plain });
    await frames(page);
    const expected = before.slice(0, insertAt) + pasted + before.slice(insertAt);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), expected, `${name}: paste retains the original text`);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.selection.main.head), insertAt + pasted.length, `${name}: paste retains the native caret`);
    assert.ok(await page.$('.meo-md-html-source-range-start'), `${name}: pasted HTML stays in source editing`);
    assert.equal(await page.$$eval('.meo-md-html-live-result', nodes => nodes.length), name === 'invisible' ? 0 : 1);
    assert.ok(Math.abs(await page.$eval('.cm-line', e => e.getBoundingClientRect().top) - top) <= 1, `${name}: content above stays fixed`);
    if (name === 'trailing-lines') {
      await page.click('.meo-format-html-btn');
      await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
      await page.waitForFunction(text => (window as any).__htmlEditor.getText() !== text, {}, expected);
      const caret = await page.evaluate(() => {
        const view = (window as any).__htmlEditor.view; return view.state.doc.sliceString(view.state.selection.main.head - 2, view.state.selection.main.head);
      });
      assert.equal(caret, '\n\n', 'Explicit formatting preserves the caret after pasted trailing lines');
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await frames(page);
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), expected);
    }
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), before, `${name}: one undo removes the paste`);
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), expected);
    assert.ok(await page.$('.meo-md-html-source-range-start'), `${name}: redo restores source editing`);
    if (name === 'trailing-lines') {
      await page.keyboard.type('Following prose'); await frames(page);
      assert.equal(await page.$('.meo-md-html-source-range-start'), null, 'Typing after trailing blank lines leaves the pasted block');
    }
    await select(page, 'After.', 2);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null, `${name}: moving away collapses source`);
    if (name === 'invisible') assert.ok(await page.$('.meo-md-html-invisible-source-text'));
  }
  for (const literal of ['<span>Inline</span>', '```html\n' + fragment + '\n```']) {
    await page.evaluate(({ before, insertAt, literal }) => {
      const editor = (window as any).__htmlEditor;
      editor.setText(before, true); editor.view.dispatch({ selection: { anchor: insertAt } });
      editor.pastePlainText(literal);
    }, { before, insertAt, literal });
    await frames(page);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null, 'Inline HTML and fenced code do not gain block previews');
    assert.equal(await page.$('.meo-md-html-live-result'), null);
  }
  await page.evaluate(async ({ before, insertAt, fragment }) => {
    const editor = (window as any).__htmlEditor;
    await editor.setMode('source'); editor.setText(before, true);
    editor.view.dispatch({ selection: { anchor: insertAt } }); editor.pastePlainText(fragment + '\n');
    editor.view.dispatch({ selection: { anchor: insertAt + fragment.indexOf('First') + 2 } });
    await editor.setMode('live');
  }, { before, insertAt, fragment });
  await frames(page);
  assert.ok(await page.$('.meo-md-html-source-range-start'), 'Source paste respects the caret inside HTML on entering Live');
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
}

async function checkHtmlEditingTools(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = window as any;
    g.__htmlShortcuts = {};
    g.__htmlTooltip = g.HtmlContentHarness.bindTooltips(document.body, {
      shortcutForCommand: (command: string) => g.HtmlContentHarness.effectiveShortcuts(g.__htmlShortcuts, 'other')[command]?.[0]
    });
    document.addEventListener('keydown', event => g.HtmlContentHarness.handleEditorShortcut(event, {
      editor: g.__htmlEditor, editableMode: 'live', editorSurfaceActive: true, shortcuts: g.__htmlShortcuts,
      platform: 'other', requestSave() {}, openFindPanel() {}, requestMode() {}
    }), true);
  });
  const fragment = '<div id="format-target" class="custom" onclick="alert(1)" style="color:red;padding:8px;border:1px solid red;opacity:2"><p>Hello <strong>world</strong>.</p><a href="javascript:alert(1)">link</a></div>';
  const text = `Intro.\n\n${fragment}\n\nAfter unchanged.`;
  for (const language of ['zh-CN', 'en']) {
    await page.evaluate(({ text, language }) => {
      (window as any).__htmlEditor.setUiLanguage(language);
      (window as any).__htmlEditor.setText(text, true);
    }, { text, language });
    await select(page, 'format-target', 3);
    assert.equal(await page.$eval('.meo-format-html-btn', e => e.textContent), '', 'Formatting is icon-only');
    assert.ok(await page.$eval('.meo-format-html-btn', e => e.getBoundingClientRect().width <= 24), 'Compact format action');
    await page.hover('.meo-format-html-btn');
    await page.waitForSelector('.meo-tooltip:not([hidden])');
    assert.equal(await page.$eval('.meo-format-html-btn', e => (e as HTMLElement).dataset.tooltipShortcut), 'Alt + Shift + F');
    assert.doesNotMatch(await page.$eval('.meo-format-html-btn', e => (e as HTMLElement).dataset.tooltip!), /[（(]/);
    const tooltip = await page.$eval('.meo-md-html-source-actions .meo-md-html-warning', element => ({
      hidden: (element as HTMLElement).hidden, label: (element as HTMLElement).dataset.tooltip
    }));
    assert.equal(tooltip.hidden, false);
    for (const name of ['class', 'onclick', 'opacity', 'href']) assert.ok(tooltip.label?.includes(name), name);
    assert.doesNotMatch(tooltip.label!, /\b(?:padding|border)\b/, 'accepted formatting must not be reported as filtered');
    assert.deepEqual(await page.$eval('#format-target', node => {
      const style = getComputedStyle(node); return { padding: style.paddingTop, border: style.borderTopWidth };
    }), { padding: '8px', border: '1px' });
    assert.match(tooltip.label!, language === 'zh-CN' ? /源码已保留/ : /source retained/);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, 'Policy feedback does not modify source');
    await page.click('.meo-format-html-btn');
    await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
    const formatted = await page.evaluate(() => (window as any).__htmlEditor.getText());
    assert.notEqual(formatted, text);
    assert.ok(formatted.startsWith('Intro.\n\n') && formatted.endsWith('\n\nAfter unchanged.'), 'Only the current fragment is formatted');
    assert.ok(formatted.includes('onclick="alert(1)"') && formatted.includes('padding:8px'), 'Formatting retains filtered authored attributes');
    assert.ok(await page.$('.meo-md-html-source-range-start'), 'Formatting keeps the fragment open');
    await page.screenshot({ path: path.join(artifacts, `format-html-${language}.png`) });
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, 'One undo restores the complete fragment');
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
    await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), formatted, 'One redo reapplies formatting');
  }
  const preserved = '<div style="white-space:pre-wrap">a  b\n c</div>';
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), `Intro.\n\n${preserved}\n\nAfter.`);
  await select(page, 'a  b', 1);
  const beforePreserved = await page.evaluate(() => (window as any).__htmlEditor.getText());
  await page.click('.meo-format-html-btn');
  await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
  assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), beforePreserved, 'Preserved whitespace is never rewritten');
  assert.match(await page.$eval('.meo-format-html-btn', element => element.getAttribute('aria-label')!), /No layout changes/);
  assert.equal(await page.$eval('.meo-format-html-btn svg path', node => node.getAttribute('d')), 'M20 6 9 17l-5-5', 'Retaining a preformatted block uses the success check');
  const mixedProtected = '<div><pre> a  b\n c</pre><section><p>Hello</p></section></div>';
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), `Intro.\n\n${mixedProtected}\n\nAfter.`);
  await select(page, 'a  b', 1);
  await page.click('.meo-format-html-btn');
  await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
  const mixedResult = await page.evaluate(() => (window as any).__htmlEditor.getText());
  assert.ok(mixedResult.includes('<pre> a  b\n c</pre>') && mixedResult.includes('\n  <section>'));
  await frames(page);
  assert.match(await page.$eval('.meo-format-html-btn', element => element.getAttribute('aria-label')!), /formatted.*retained/);
  assert.equal(await page.$eval('.meo-format-html-btn svg path', node => node.getAttribute('d')), 'M20 6 9 17l-5-5');
  assert.ok(await page.$$eval('.meo-md-html-source-range', nodes => nodes.length >= 4), 'The complete formatted fragment stays open');
  await page.screenshot({ path: path.join(artifacts, 'format-html-protected.png') });
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await frames(page);
  assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), `Intro.\n\n${mixedProtected}\n\nAfter.`);
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), text);
  await select(page, 'format-target', 3);
  const raced = await page.evaluate(() => {
    const view = (window as any).__htmlEditor.view;
    (document.querySelector('.meo-format-html-btn') as HTMLButtonElement).click();
    const position = view.state.doc.toString().indexOf('Hello') + 5;
    view.dispatch({ changes: { from: position, insert: 'X' } });
    return view.state.doc.toString();
  });
  await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
  assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), raced, 'A late formatter result cannot overwrite newer input');
  assert.match(await page.$eval('.meo-format-html-btn', element => element.getAttribute('aria-label')!), /changed/);
  await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), 'Intro.\n\n<div title="ok"><p>Hello</p></div>\n\nAfter.');
  await select(page, 'ok', 1);
  await page.evaluate(() => {
    const view = (window as any).__htmlEditor.view;
    const position = view.state.doc.toString().indexOf('ok"') + 2;
    view.dispatch({ changes: { from: position, to: position + 1 }, selection: { anchor: position } });
  });
  await frames(page);
  const invalid = await page.evaluate(() => (window as any).__htmlEditor.getText());
  await page.click('.meo-format-html-btn');
  await page.waitForFunction(() => !(document.querySelector('.meo-format-html-btn') as HTMLButtonElement)?.disabled);
  assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), invalid);
  assert.match(await page.$eval('.meo-format-html-btn', element => element.getAttribute('aria-label')!), /incomplete|invalid/);
  await page.evaluate(async text => {
    const editor = (window as any).__htmlEditor;
    editor.setText(text, true);
    await editor.setMode('source');
  }, text);
  await select(page, 'format-target', 3);
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  await page.waitForFunction(text => (window as any).__htmlEditor.getText() !== text, {}, text);
  assert.ok((await page.evaluate(() => (window as any).__htmlEditor.getText())).endsWith('After unchanged.'));
  for (const mode of ['live', 'source']) {
    await page.evaluate(async ({ text, mode }) => {
      const g = window as any;
      await g.__htmlEditor.setMode(mode);
      g.__htmlEditor.setText(text, true);
      g.__htmlShortcuts = { formatHtml: ['Ctrl + Alt + L'] };
      g.__htmlTooltip.refreshShortcuts();
    }, { text, mode });
    await select(page, 'format-target', 3);
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, `${mode}: removed default cannot fall through to a local keymap`);
    if (mode === 'live') {
      await page.hover('.meo-format-html-btn');
      await page.waitForSelector('.meo-tooltip:not([hidden])');
      assert.equal(await page.$eval('.meo-format-html-btn', e => (e as HTMLElement).dataset.tooltipShortcut), 'Ctrl + Alt + L');
      await page.screenshot({ path: path.join(artifacts, 'format-html-custom-shortcut.png') });
    }
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('l');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.waitForFunction(text => (window as any).__htmlEditor.getText() !== text, {}, text);
    await page.evaluate(text => {
      const g = window as any;
      g.__htmlEditor.setText(text, true); g.__htmlShortcuts = { formatHtml: [] }; g.__htmlTooltip.refreshShortcuts();
    }, text);
    await select(page, 'format-target', 3);
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.getText()), text, `${mode}: clearing the binding disables its default`);
    if (mode === 'live') {
      await page.hover('.meo-format-html-btn');
      assert.equal(await page.$eval('.meo-format-html-btn', e => (e as HTMLElement).dataset.tooltipShortcut), undefined);
      await page.click('.meo-format-html-btn');
      await page.waitForFunction(text => (window as any).__htmlEditor.getText() !== text, {}, text);
    }
  }
  await page.evaluate(async () => { await (window as any).__htmlEditor.setMode('live'); });
}

async function main(): Promise<void> {
  if (!['--format-only', '--expansion-only', '--pointer-only', '--selection-only'].some(flag => process.argv.includes(flag))) await checkHtmlStyleRendering();
  if (process.argv.includes('--styles-only')) return;
  checkExport();
  const plain = '<div id="one" title="long title" style="color:red"><p>Hello <strong>world</strong>.</p></div>';
  const formatted = await formatHtmlFragment(plain, [0, plain.indexOf('world')]);
  assert.equal(formatted.kind, 'formatted');
  assert.match(formatted.source, /\n  <p>/);
  assert.equal(formatted.source.slice(formatted.offsets[1], formatted.offsets[1] + 5), 'world');
  assert.equal((await formatHtmlFragment(formatted.source, formatted.offsets)).kind, 'unchanged');
  for (const text of ['<pre>  a\n b</pre>', '<code> a  b\n c </code>',
    '<div style="white-space:pre-wrap">a  b\n c</div>', '<div style="display:inline">a</div><div style="display:inline">b</div>']) {
    assert.equal((await formatHtmlFragment(text, [0])).source, text, 'Whitespace-sensitive source stays intact');
  }
  await assert.rejects(() => formatHtmlFragment('<div title="broken>', [0]));
  const build = await Bun.build({ entrypoints: [path.join(repoRoot, 'scripts/test-html-content-entry.ts')], outdir: tempDir,
    target: 'browser', format: 'iife', naming: 'bundle.js' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-light"><div id="app"></div></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(text => {
      (window as any).__htmlLinks = [];
      (window as any).__htmlEditor = (window as any).HtmlContentHarness.createEditor({ parent: document.getElementById('app'),
        text, initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {},
        onOpenLink(href: string) { (window as any).__htmlLinks.push(href); } });
    }, source);
    await frames(page, 12);
    assert.deepEqual(errors, [], 'Editor initialization');
    if (process.argv.includes('--expansion-only')) {
      await checkSourceExpansionAnchor(page);
      assert.deepEqual(errors, []); console.log('HTML/math source expansion preserves preceding content through every frame.'); return;
    }
    if (process.argv.includes('--format-only')) {
      await checkHtmlEditingTools(page);
      assert.deepEqual(errors, []); console.log('HTML icon-only formatting, feedback, undo and customized shortcuts passed.'); return;
    }
    await checkHtmlCrossBlockSelection(page);
    if (process.argv.includes('--selection-only')) {
      assert.deepEqual(errors, []); console.log('HTML/math cross-block dragging, keyboard extension, copy/cut history and HTML reading selection passed.'); return;
    }
    await checkHtmlLayoutAndSourceCopy(page);
    await checkHtmlPointerEditing(page);
    if (process.argv.includes('--pointer-only')) {
      assert.deepEqual(errors, []); console.log('HTML/math cross-block selection, layout/gutter, source copy, unselectable actions and pointer-release checks passed.'); return;
    }
    await checkHtmlPasteEditing(page);
    // This snapshot inspects the complete reading DOM, including nodes below
    // the normal interaction viewport. Reset the inherited caret and fit it.
    await select(page, 'Prelude paragraph.');
    await page.setViewport({ width: 1000, height: 2400, deviceScaleFactor: 1 });
    await frames(page);
    const initial = await page.evaluate(() => {
      const root = document.querySelector('.cm-editor')!;
      const empty = root.querySelector<HTMLElement>('.meo-md-html-invisible-source-text');
      const center = root.querySelector<HTMLElement>('#center');
      const image = root.querySelector<HTMLImageElement>('.meo-md-html-content img');
      return { raw: (window as any).__htmlEditor.view.state.doc.toString(),
        buttons: root.querySelectorAll('.meo-md-html-source-toggle, .meo-md-html-preview-toggle').length,
        center: center?.textContent, red: center?.style.color, position: center?.style.position,
        onclick: center?.getAttribute('onclick'), empty: empty?.textContent, emptyHeight: empty?.getBoundingClientRect().height,
        emptyBackground: empty ? getComputedStyle(empty).backgroundColor : null,
        heading: root.querySelector('.meo-md-html-content h2')?.textContent,
        section: root.querySelector('.meo-md-html-content section')?.textContent,
        caption: root.querySelector('.meo-md-html-content caption')?.textContent,
        quote: root.querySelector('.meo-md-html-content blockquote')?.textContent,
        inlineBold: root.querySelector('.meo-md-html-inline strong')?.textContent,
        ruby: root.querySelector('.meo-md-html-inline ruby')?.textContent,
        code: root.querySelector('.meo-md-html-content pre code')?.textContent,
        adjacent: root.querySelector('#target')?.textContent,
        afterScript: root.querySelector('#after-script')?.textContent,
        executed: (window as any).__htmlExecuted ?? 0,
        blankLines: Array.from(root.querySelectorAll('.meo-md-html-content')).some(node => node.textContent?.includes('First raw paragraph.') && node.textContent.includes('Second raw paragraph.')),
        imageWidth: image?.getBoundingClientRect().width,
        standaloneImageWidth: root.querySelector('#standalone-image')?.getBoundingClientRect().width,
        inlineImageWidth: root.querySelector('#inline-image')?.getBoundingClientRect().width,
        hiddenImageHeights: Array.from(root.querySelectorAll('.meo-md-html-content #hidden-children .meo-md-html-image'))
          .map(node => node.getBoundingClientRect().height),
        hiddenLinkButtons: root.querySelectorAll('#hidden-children .meo-md-html-link-button').length,
        hiddenRows: root.querySelectorAll('.meo-md-html-invisible-source').length,
        unsupported: root.textContent?.includes('<custom-html>'),
        warning: Boolean(root.querySelector('.meo-md-html-warning')),
        comment: root.textContent?.includes('<!-- visible comment -->') };
    });
    assert.equal(initial.raw, source);
    assert.equal(initial.buttons, 0);
    assert.ok(initial.center?.includes('English'));
    assert.equal(initial.red, 'red');
    assert.equal(initial.position, '');
    assert.equal(initial.onclick, null);
    assert.equal(initial.empty, '<div id="html-test-top"></div>');
    assert.ok(initial.emptyHeight! > 5);
    assert.equal(initial.emptyBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(initial.heading, 'HTML heading');
    assert.equal(initial.section, 'Semantic section');
    assert.equal(initial.caption, 'HTML table caption');
    assert.ok(initial.quote?.includes('quoted text'));
    assert.equal(initial.inlineBold, 'bold');
    assert.equal(initial.ruby, '字zi');
    assert.equal(initial.code, '**literal** <tag>');
    assert.equal(initial.adjacent, 'Adjacent visible fragment');
    assert.equal(initial.afterScript, 'After unsupported script');
    assert.equal(initial.executed, 0);
    assert.equal(initial.blankLines, true);
    assert.ok(Math.abs(initial.imageWidth! - 60) < 1, `HTML image width: ${initial.imageWidth}`);
    assert.ok(Math.abs(initial.standaloneImageWidth! - 24) < 1, 'Standalone HTML image renders at its authored size');
    assert.ok(Math.abs(initial.inlineImageWidth! - 16) < 1, 'Inline HTML image renders in prose');
    assert.deepEqual(initial.hiddenImageHeights, [0, 0], 'Image enhancements retain hidden attributes on images and their links');
    assert.equal(initial.hiddenLinkButtons, 0, 'Hidden links do not gain visible helper controls');
    assert.equal(initial.hiddenRows, 9);
    assert.equal(initial.unsupported, true);
    assert.equal(initial.warning, true);
    assert.equal(initial.comment, true);
    await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 1 });
    await frames(page);
    await page.screenshot({ path: path.join(artifacts, 'light-reading.png') });

    const beforeTop = await page.$eval('#center', node => node.getBoundingClientRect().top);
    await page.click('#center', { offset: { x: 10, y: 10 } });
    await frames(page);
    const editing = await page.evaluate(() => {
      const source = document.querySelector<HTMLElement>('.meo-md-html-source-range-start');
      const last = document.querySelector<HTMLElement>('.meo-md-html-source-range-end');
      const result = document.querySelector<HTMLElement>('.meo-md-html-live-result');
      return { source: source?.textContent, count: document.querySelectorAll('.meo-md-html-source-range').length,
        top: source?.getBoundingClientRect().top, sourceBottom: last?.getBoundingClientRect().bottom,
        sourceBackground: source && getComputedStyle(source).backgroundColor,
        resultBackground: result && getComputedStyle(result).backgroundColor,
        resultLabel: result?.querySelector('.meo-md-html-result-status')?.textContent,
        joinedEnd: last?.classList.contains('meo-md-html-source-has-preview'),
        sourceLeft: source?.getBoundingClientRect().left, sourceWidth: source?.getBoundingClientRect().width,
        resultLeft: result?.getBoundingClientRect().left, resultWidth: result?.getBoundingClientRect().width,
        resultBottom: result?.getBoundingClientRect().bottom,
        previewTop: result?.getBoundingClientRect().top, preview: result?.textContent };
    });
    assert.ok(editing.source?.includes('<p id="center"'));
    assert.equal(editing.count, 4);
    assert.ok(editing.preview?.includes('English'));
    assert.ok(editing.previewTop! >= editing.sourceBottom! - 1);
    assert.ok(editing.previewTop! <= editing.sourceBottom! + 1, 'Source and result form a continuous editing surface');
    assert.equal(editing.resultBackground, editing.sourceBackground, 'Source and result share the block surface');
    assert.equal(editing.resultLabel, '预览');
    assert.equal(editing.joinedEnd, true, 'The source bottom joins the result instead of closing a separate box');
    assert.ok(Math.abs(editing.sourceLeft! - editing.resultLeft!) < 1 && Math.abs(editing.sourceWidth! - editing.resultWidth!) < 1,
      'Source and result share the same outer edges');
    assert.ok(Math.abs(editing.top! - beforeTop) < 3, 'Opening source keeps its reading anchor');
    await page.screenshot({ path: path.join(artifacts, 'light-editing.png') });
    await page.screenshot({ path: path.join(artifacts, 'html-editing-surface.png'), clip: {
      x: editing.sourceLeft! - 2, y: editing.top! - 2,
      width: editing.sourceWidth! + 4, height: editing.resultBottom! - editing.top! + 4
    } });
    await select(page, 'English', 'English'.length);
    await page.keyboard.type('X');
    await frames(page);
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('EnglishX')));
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    await page.keyboard.press('Escape');
    await frames(page);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    assert.ok(Math.abs(await page.$eval('#center', node => node.getBoundingClientRect().top) - beforeTop) < 3);

    // Dragging selects rendered words without entering HTML source.
    const word = await page.$eval('#center .meo-md-html-link', node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const box = range.getBoundingClientRect(); return { x: box.left, y: box.top + box.height / 2, width: box.width };
    });
    await page.mouse.move(word.x + 1, word.y); await page.mouse.down();
    await page.mouse.move(word.x + word.width - 1, word.y, { steps: 8 }); await page.mouse.up();
    await frames(page);
    assert.ok(await page.evaluate(() => Boolean(document.getSelection()?.toString().trim())));
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    await page.evaluate(() => document.getSelection()?.removeAllRanges());
    await page.keyboard.down('Control'); await page.click('#center .meo-md-html-link[data-meo-link-href="https://example.com/docs"]'); await page.keyboard.up('Control');
    await frames(page);
    assert.deepEqual(await page.evaluate(() => (window as any).__htmlLinks), ['https://example.com/docs']);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);

    await page.click('.meo-md-html-content details > summary');
    await frames(page);
    assert.equal(await page.$eval('.meo-md-html-content details', node => (node as HTMLDetailsElement).open), false);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null);
    await page.click('.meo-md-html-content details > summary');
    await frames(page);
    assert.equal(await page.$eval('.meo-md-html-content details', node => (node as HTMLDetailsElement).open), true);

    // Keyboard navigation reaches an otherwise invisible anchor as ordinary source.
    await select(page, '<div id="html-test-top"', 9);
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('.meo-md-html-invisible-source-text'))
      .some(node => node.textContent?.includes('html-test-top'))), false);
    assert.ok(await page.$eval('.meo-md-html-source-range-start', node => node.textContent?.includes('html-test-top')));
    assert.equal(await page.$('.meo-md-html-live-result'), null, 'No empty preview frame');
    await page.keyboard.type('X');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await select(page, 'Tail paragraph.');
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    assert.ok(await page.$('.meo-md-html-invisible-source-text'));

    // Incomplete HTML stays editable and current safe content can still render.
    await select(page, 'English', 2);
    await page.evaluate(() => {
      const view = (window as any).__htmlEditor.view;
      const end = view.state.doc.toString().indexOf('</p>');
      view.dispatch({ changes: { from: end, to: end + 4, insert: '</p' } });
    });
    await frames(page);
    assert.ok(await page.$('.meo-md-html-source-range-start'));
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('English')));
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await select(page, 'Tail paragraph.');
    assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    for (const mode of ['source', 'live'] as const) {
      await page.evaluate(mode => (window as any).__htmlEditor.setMode(mode), mode); await frames(page);
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    }

    const htmlFrom = source.indexOf('<p id="center"'), htmlTo = source.indexOf('</p>') + 4;
    for (const [key, position] of [['ArrowDown', htmlFrom - 1], ['ArrowRight', htmlFrom - 1],
      ['ArrowUp', htmlTo + 1], ['ArrowLeft', htmlTo]] as const) {
      await select(page, 'Prelude paragraph.');
      await page.evaluate(position => {
        const view = (window as any).__htmlEditor.view;
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
      }, position);
      await frames(page);
      await page.keyboard.press(key); await frames(page);
      assert.ok(await page.$('.meo-md-html-source-range-start'), `${key} enters HTML source`);
      assert.equal(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()), source);
    }

    await select(page, '<p id="center"', 2);
    await page.keyboard.type(' ti');
    await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.meo-html-suggestions:not([hidden])')?.textContent?.includes('title'), { timeout: 3000 });
    await frames(page);
    await page.keyboard.press('Enter'); await frames(page);
    const completed = await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString());
    assert.ok(completed.includes('<p title id="center"'), `HTML attribute completion edits the main document: ${completed.slice(htmlFrom, htmlFrom + 60)}`);
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, '  <a href="#target">');
    await page.keyboard.type('<span>'); await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('<span></span>')),
      'HTML tags close automatically in the main source');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, '<div id="target">', '<div id="target">'.length);
    await page.keyboard.type('<div>'); await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString()
      .includes('<div id="target"><div></div><p>')),
      'Nested tags do not consume an existing same-name parent closing tag');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 7);
    const input = await page.createCDPSession();
    try {
      await input.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
      await input.send('Input.insertText', { text: '中文' });
    } finally { await input.detach(); }
    await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('English中文')));
    assert.ok(await page.$eval('.meo-md-html-live-result', node => node.textContent?.includes('English中文')));
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 7);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Pasted');
      clipboardData.setData('text/html', '<strong>Pasted</strong>');
      (window as any).__htmlEditor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await frames(page);
    assert.ok(await page.evaluate(() => (window as any).__htmlEditor.view.state.doc.toString().includes('EnglishPasted')),
      'HTML source paste retains literal text instead of converting it to Markdown');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);
    await select(page, 'English', 2);
    await page.evaluate(({ from, to }) => {
      const view = (window as any).__htmlEditor.view;
      view.dispatch({ changes: { from, to, insert: 'Replacement paragraph.' }, selection: { anchor: from + 8 } });
    }, { from: htmlFrom, to: htmlTo });
    await frames(page);
    assert.equal(await page.$('.meo-md-html-source-range-start'), null, 'Replacing the complete HTML fragment releases its source range');
    await page.evaluate(text => (window as any).__htmlEditor.setText(text, true), source);

    for (const appearance of ['light', 'dark'] as const) for (const language of ['zh-CN', 'en'] as const) {
      await page.evaluate(({ appearance, language }) => {
        const style = document.documentElement.style;
        style.setProperty('--meo-foreground', appearance === 'dark' ? '#d4d4d4' : '#1f2328');
        style.setProperty('--vscode-editor-foreground', appearance === 'dark' ? '#d4d4d4' : '#1f2328');
        style.setProperty('--vscode-editor-background', appearance === 'dark' ? '#121314' : '#ffffff');
        (window as any).HtmlContentHarness.applyUiTheme(appearance, true);
        (window as any).__htmlEditor.setUiLanguage(language);
      }, { appearance, language });
      await select(page, 'Prelude paragraph.');
      await page.setViewport({ width: language === 'en' ? 520 : 1000, height: 1000 });
      await frames(page);
      await page.screenshot({ path: path.join(artifacts, `${appearance}-${language}-reading.png`) });
      await select(page, 'English', 2);
      assert.equal(await page.$eval('.meo-md-html-result-status', node => node.textContent),
        language === 'zh-CN' ? '预览' : 'Preview');
      await page.screenshot({ path: path.join(artifacts, `${appearance}-${language}-editing.png`) });
      const sourceColor = await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('.cm-editor')!;
        editor.style.setProperty('--meo-foreground', '#a11f1f');
        editor.style.setProperty('--meo-token-foreground-color', '#127a55');
        const line = Array.from(editor.querySelectorAll('.meo-md-html-source-range')).find(node => node.textContent?.includes('English'))!;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let text: Node | null;
        while ((text = walker.nextNode()) && !text.textContent?.includes('English')) {}
        if (!text?.parentElement) throw new Error('HTML source text node was not painted');
        const color = getComputedStyle(text.parentElement).color;
        editor.style.removeProperty('--meo-foreground');
        editor.style.removeProperty('--meo-token-foreground-color');
        return color;
      });
      assert.equal(sourceColor, 'rgb(18, 122, 85)', 'HTML text nodes use the syntax foreground even when document ink differs');
      const editingSurface = async (kind: 'html' | 'math') => page.evaluate(kind => {
        const source = document.querySelector(kind === 'html' ? '.meo-md-html-source-range-start' : '.meo-math-source-start')!;
        const result = document.querySelector(kind === 'html' ? '.meo-md-html-live-result' : '.meo-math-live-result')!;
        const pick = (node: Element, properties: string[]) => {
          const style = getComputedStyle(node);
          return Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
        };
        return { source: pick(source, ['background-color', 'border', 'border-radius', 'box-shadow', 'font-size', 'line-height']),
          result: pick(result, ['background-color', 'border', 'border-radius', 'box-shadow', 'padding']) };
      }, kind);
      const htmlSurface = await editingSurface('html');
      await select(page, 'x^2 + 1', 1);
      assert.deepEqual(await editingSurface('math'), htmlSurface, `${appearance}/${language}: HTML and display math share the editing surface`);
    }
    await checkHtmlEditingTools(page);
    await checkSourceExpansionAnchor(page);
    assert.deepEqual(errors, [], 'No runtime errors');
    console.log(`HTML fragment rendering, source editing and invisible-source tests passed. Screenshots: ${artifacts}`);
  } finally { await browser.close(); }
}

await main();
