import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';
import { createMarkdownContentParser } from '../src/shared/markdownContentParser';
import { renderHtmlMarkdown } from '../src/shared/htmlMarkdown';

const fixtures: Array<{ text: string; quotes: number[]; heading?: boolean; table?: boolean;
  alignment?: { body: string; continuation: string }; physicalPrefixLine?: number }> = [
  { text: '> quote\n2. next', quotes: [1] },
  { text: '>> quote\n10) next', quotes: [1] },
  { text: '1. **引用**  \n  >使用">"来进行嵌套\n  >>当然使用">>"也能够叠加嵌套\n2. **列表**\n  i. 无序列表  \n    + 列表 **+**\n    - 列表 **-**', quotes: [2, 3] },
  { text: '> quote\nlazy continuation', quotes: [1, 2], alignment: { body: 'quote', continuation: 'lazy continuation' } },
  ...[
    { text: '> > body\n/i', quotes: [1, 2] },
    { text: '> > body\n> /i', quotes: [1, 2] },
    { text: '  >\t>\tbody\n/i', quotes: [1, 2] },
    { text: '> - body\n/i', quotes: [1, 2] },
    { text: '- > body\n/i', quotes: [1, 2] },
    { text: '- > body\n  > /i', quotes: [1, 2] },
    { text: '> - > body\n> /i', quotes: [1, 2] },
    { text: '> - [ ] body\n/i', quotes: [1, 2] },
    { text: '> 10. body\n/i', quotes: [1, 2] },
    { text: '- body\n/i', quotes: [] },
    { text: 'Use[^n]\n\n[^n]: introduction\n\n    > body\n    /i', quotes: [5, 6] },
    { text: '> > - item\n> >\n> >   | A | B |\n> >   | --- | --- |\n> >   | a | b |\n> >\n> >   body\n/i', quotes: [1, 2, 6, 7, 8] }
  ].map(fixture => ({ ...fixture, alignment: { body: 'body', continuation: '/i' } })),
  { text: '> > body\n' + 'wrapped continuation '.repeat(12), quotes: [1, 2],
    alignment: { body: 'body', continuation: 'wrapped continuation '.repeat(12) } },
  { text: '> quote\n> 2. literal continuation', quotes: [1, 2] },
  { text: '- parent\n  > quote\n2. next', quotes: [2] },
  { text: '> - parent\n> 2. next', quotes: [1, 2] },
  { text: '> quote\n\n2. next', quotes: [1] },
  { text: 'Use[^n]\n\n[^n]: > body\n    > /i', quotes: [3, 4], physicalPrefixLine: 4 },
  { text: 'Use[^n]\n\n[^n]: - body\n    /i', quotes: [], physicalPrefixLine: 4 },
  { text: 'a | b\n---\nx | y', quotes: [], heading: true },
  { text: '> a | b\n> ---\n> x | y', quotes: [1, 2, 3], heading: true },
  { text: '1. a | b\n   --- | ---\n   x | y', quotes: [], table: true },
  { text: '> 1. a | b\n>    --- | ---\n>    x | y', quotes: [], table: true }
];
const formatting = [
  '# Markdown heading', '', '<h1 id="html-heading">HTML heading</h1>', '',
  '**MarkdownStrong** *MarkdownEm* ~~MarkdownStrike~~ H~2~O x^2^ ==MarkdownMark==', '',
  '`MarkdownCode` and <code id="html-code">HTML code</code>', '',
  '**`MarkdownStrongCode`** *`MarkdownEmCode`* <strong><code id="html-strong-code">HTML strong code</code></strong> <em><code id="html-em-code">HTML emphasis code</code></em>', '',
  '<p><b id="html-strong">HTML strong</b> <i id="html-em">HTML emphasis</i> <s id="html-strike">HTML strike</s> <sub id="html-sub">sub</sub> <sup id="html-sup">sup</sup> <mark id="html-mark">mark</mark></p>', '',
  '<p><b id="author-style" style="font-size:21px;font-weight:300;color:rgb(123,45,67)">Author style</b></p>', '',
  '<p><span style="color:rgb(123,45,67)"><strong id="author-inherited">Inherited author color</strong></span></p>', '',
  '<p><code id="html-block-code">**literal** $x$</code></p>', '',
  '<p><span style="color:rgb(123,45,67)"><code id="html-code-inherited">Inherited code color</code></span> <code id="html-code-author" style="color:rgb(67,89,123)">Author code color</code></p>', '',
  '<style>code:where(.author-code-color) { color:rgb(45,67,89) }</style>', '',
  '<p><code id="html-code-stylesheet" class="author-code-color">Stylesheet code color</code></p>'
].join('\n');
const nestedAlert = '> [!NOTE]\n> Top level note.\n\n> > [!TIP]\n> > Nested tip body.\n\nAFTER';

// HTML fragments and reading prose consume the same grammar, including literal code.
for (const [source, expected] of [['`   `', '<code>   </code>'], ['``  ``', '<code>  </code>'],
  ['<code>**literal** $x$</code>', '<code>**literal** $x$</code>']]) {
  assert.equal(renderHtmlMarkdown(source, true), expected);
  assert.equal(createMarkdownContentParser().renderInline(source), expected);
}
const literalHtmlCode = renderMarkdownToHtml({ markdownText: 'Before <code>first<br>- literal</code> after',
  markdownFilePath: 'D:/fixture/content.md', target: 'html' }).html;
assert.ok(!literalHtmlCode.includes('<ul'), 'body break scanning must keep HTML code literal');
const build = await Bun.build({ entrypoints: [path.resolve('scripts/test-list-editing-entry.ts')], target: 'browser', format: 'iife' });
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });
  await page.setContent('<style>body{margin:0}main{display:grid;grid-template-columns:1fr 1fr;height:100vh}#live{min-width:0}#live .cm-editor{height:100%}iframe{box-sizing:border-box;width:100%;height:100%;border:0}</style><main><div id="live"></div><iframe id="preview"></iframe></main>');
  // VS Code injects this foreground rule into Webviews; a standalone page omits it.
  await page.addStyleTag({ content: ':root{--vscode-textPreformat-foreground:#e5c07b}code{color:var(--vscode-textPreformat-foreground)}' });
  await page.addStyleTag({ path: path.resolve('webview/src/styles.css') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  for (const large of [false, true]) {
    for (const appearance of ['light', 'dark'] as const) {
      const alertHtml = renderMarkdownToHtml({ markdownText: nestedAlert, markdownFilePath: 'D:/fixture/content.md', target: 'html' }).html;
      const alertCss = buildPreviewStyles({ previewFontFamily: '' }, appearance);
      const alert = await page.evaluate(async ({ source, alertHtml, alertCss, appearance }) => {
        document.documentElement.dataset.editorAppearance = appearance;
        const harness = (window as any).ListEditingHarness;
        harness.applyBuiltInVisualBaseline(appearance);
        const host = document.querySelector('#live')!;
        const editor = harness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
        editor.view.dispatch({ selection: { anchor: source.indexOf('AFTER') } });
        for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
        const doc = document.querySelector<HTMLIFrameElement>('#preview')!.contentDocument!;
        doc.open(); doc.write('<!doctype html><style>' + alertCss + '</style><article class="meo-export-doc">' + alertHtml + '</article>'); doc.close();
        const previewTip = doc.querySelector('blockquote > blockquote.meo-export-alert-tip')!;
        const lines = Array.from(host.querySelectorAll('.cm-line.meo-md-alert-tip'));
        const note = host.querySelector('.cm-line.meo-md-alert-note')!;
        const colors = (line: Element) => {
          const background = getComputedStyle(line, '::before').backgroundImage;
          return [...background.matchAll(/linear-gradient\((.+?), \1\)/g)].map(match => match[1]);
        };
        const probe = document.createElement('span');
        const palette = (property: string) => {
          probe.style.color = `var(--meo-semantic-${property})`;
          return getComputedStyle(probe).color;
        };
        // Alert styles color their descendants, so read the palette outside the row.
        editor.view.dom.appendChild(probe);
        const quote = palette('blockquoteBorder'), tip = palette('alertTipBorder'),
          tipForeground = palette('alertTipForeground'), noteBorder = palette('alertNoteBorder');
        probe.remove();
        const result = { live: lines.map(line => ({ bars: colors(line), fill: getComputedStyle(line).webkitTextFillColor })),
          note: colors(note), expected: { bars: [quote, tip], fill: tipForeground }, noteBorder,
          optimized: harness.usesLargeDocumentDerivedWorkBudget(editor.view.state),
          inset: lines.every(line => getComputedStyle(line).backgroundImage.startsWith('linear-gradient(to right,')),
          preview: { outerIsQuote: !previewTip.parentElement!.classList.contains('meo-export-alert'),
            distinctBorders: doc.defaultView!.getComputedStyle(previewTip).borderLeftColor
              !== doc.defaultView!.getComputedStyle(previewTip.parentElement!).borderLeftColor } };
        (window as any).__alertEditor = editor;
        return result;
      }, { source: nestedAlert + (large ? '\n\n' + 'padding text\n'.repeat(8100) : ''), alertHtml, alertCss, appearance });
      if (process.env.MEO_TEST_SCREENSHOTS && !large) {
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `content-nested-alert-${appearance}.png`),
          clip: { x: 0, y: 0, width: 1200, height: 285 } });
      }
      await page.evaluate(() => { (window as any).__alertEditor.destroy(); delete (window as any).__alertEditor; });
      assert.equal(alert.optimized, large);
      assert.deepEqual(alert.preview, { outerIsQuote: true, distinctBorders: true });
      assert.deepEqual(alert.note, [alert.noteBorder]);
      assert.deepEqual(alert.live, [alert.expected, alert.expected], 'The nested Alert colors only its own rule and text');
      assert.equal(alert.inset, true, 'The nested Alert tint starts at the inner quote');
      for (const fixture of fixtures) {
        const finite = fixture.text + '\n\nAFTER';
        const source = finite + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
        const result = await page.evaluate(async ({ source, finite, appearance, alignment, physicalPrefixLine }) => {
          document.documentElement.dataset.editorAppearance = appearance;
          const harness = (window as any).ListEditingHarness;
          harness.applyBuiltInVisualBaseline(appearance);
          const host = document.querySelector('#live')!; host.replaceChildren();
          const editor = harness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
          editor.view.dispatch({ selection: { anchor: finite.length } });
          for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const quoteLines = () => [...host.querySelectorAll<HTMLElement>('.cm-line.meo-md-quote')]
            .map(line => editor.view.state.doc.lineAt(editor.view.posAtDOM(line)).number);
          const alignmentSamples: Array<{ bodyLeft: number; rowLefts: number[] }> = [];
          const sampleAlignment = () => {
            if (!alignment) return;
            const body = editor.view.coordsAtPos(source.indexOf(alignment.body))!;
            const start = source.indexOf(alignment.continuation);
            const rows = new Map<number, number>();
            for (let offset = 0; offset < alignment.continuation.length; offset++) {
              const rect = editor.view.coordsAtPos(start + offset, 1)!;
              rows.set(rect.top, Math.min(rows.get(rect.top) ?? Infinity, rect.left));
            }
            alignmentSamples.push({ bodyLeft: body.left, rowLefts: [...rows.values()] });
          };
          sampleAlignment();
          if (alignment) {
            editor.view.dispatch({ selection: { anchor: source.indexOf(alignment.continuation) + alignment.continuation.length } });
            for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            sampleAlignment();
          }
          const before = quoteLines();
          const heading = host.querySelector('.meo-md-h2')?.textContent;
          const table = host.querySelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
          const tableCells = table ? [...table.querySelectorAll('th,td')].map(cell =>
            (cell.querySelector('.meo-md-html-table-cell-preview') ?? cell).textContent?.replace(/\s+/g, '')) : null;
          const prefixLine = physicalPrefixLine && [...host.querySelectorAll<HTMLElement>('.cm-line')].find(line =>
            editor.view.state.doc.lineAt(editor.view.posAtDOM(line)).number === physicalPrefixLine);
          const physicalPrefixOffset = prefixLine ? Number.parseFloat(getComputedStyle(prefixLine).paddingLeft)
            + Number.parseFloat(getComputedStyle(prefixLine).textIndent) : null;
          editor.setMode('source'); editor.setMode('live');
          for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          sampleAlignment();
          const result = { before, after: quoteLines(), heading, tableCells, unchanged: editor.getText() === source,
            optimized: harness.usesLargeDocumentDerivedWorkBudget(editor.view.state), alignmentSamples, physicalPrefixOffset };
          editor.destroy(); return result;
        }, { source, finite, appearance, alignment: fixture.alignment, physicalPrefixLine: fixture.physicalPrefixLine });
        const label = `${appearance}/${large ? 'optimized' : 'ordinary'}/${fixture.text}`;
        assert.deepEqual(result.before, fixture.quotes, label);
        assert.deepEqual(result.after, fixture.quotes, label + '/mode roundtrip');
        assert.equal(result.unchanged, true, label);
        assert.equal(result.optimized, large, label);
        if (fixture.physicalPrefixLine) {
          assert.notEqual(result.physicalPrefixOffset, null, label + '/footnote continuation mounted');
          assert.ok(Math.abs(result.physicalPrefixOffset!) <= 1, label + '/definition label cannot add a hanging indent');
        }
        for (const sample of result.alignmentSamples) {
          assert.ok(sample.rowLefts.every(left => Math.abs(left - sample.bodyLeft) <= 1),
            label + '/continuation and wrapped rows align with paragraph body: ' + JSON.stringify(sample));
          if (fixture.alignment?.continuation.startsWith('wrapped')) assert.ok(sample.rowLefts.length > 1, label + '/actually wrapped');
        }
        const html = renderMarkdownToHtml({ markdownText: finite, markdownFilePath: 'D:/fixture/content.md', target: 'html' }).html;
        if (fixture.alignment) {
          const sameParagraph = await page.evaluate(({ html, alignment }) => {
            const root = document.createElement('div'); root.innerHTML = html;
            return [...root.querySelectorAll('p,li')].some(element =>
              // Tight list items omit <p>; nested blocks cannot prove that
              // both strings belong to the same paragraph.
              (element.tagName === 'P' || !element.querySelector('p,ul,ol,blockquote'))
              && element.textContent?.includes(alignment.body) && element.textContent?.includes(alignment.continuation.trim()));
          }, { html, alignment: fixture.alignment });
          assert.equal(sameParagraph, true, label + '/Preview retains the same paragraph');
        }
        if (fixture.table) {
          const cells = await page.evaluate(html => {
            const root = document.createElement('div'); root.innerHTML = html;
            return [...root.querySelectorAll('th,td')].map(cell => cell.textContent?.replace(/\s+/g, ''));
          }, html);
          assert.deepEqual(result.tableCells, cells, label + '/table content');
          assert.ok(result.tableCells?.includes('x') && result.tableCells?.includes('y'), label + '/table rendered');
        }
        if (fixture.heading) {
          assert.ok(result.heading?.includes('a | b'), label);
          assert.ok(html.includes('<h2'), label + '/Preview heading');
          assert.ok(!html.includes('<table'), label + '/Preview must not repair a thematic underline');
        }
      }
      const source = formatting + '\n\nAFTER' + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      const html = renderMarkdownToHtml({ markdownText: formatting, markdownFilePath: 'D:/fixture/content.md', target: 'html' }).html;
      const css = buildPreviewStyles({ previewFontFamily: '' }, appearance);
      const result = await page.evaluate(async ({ source, html, css, caret }) => {
        const host = document.querySelector('#live')!; host.replaceChildren();
        const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
        editor.view.dom.style.setProperty('--meo-font-source-weight', '500');
        editor.view.dispatch({ selection: { anchor: caret } });
        for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const iframe = document.querySelector<HTMLIFrameElement>('#preview')!;
        const doc = iframe.contentDocument!;
        doc.open(); doc.write('<!doctype html><style>' + css + '</style><article class="meo-export-doc">' + html + '</article>'); doc.close();
        const style = (element: Element, property: string) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(property);
        const pairs = [
          ['.meo-md-strong', '#html-strong', 'font-weight'], ['.meo-md-em', '#html-em', 'font-style'],
          ['.meo-md-strike', '#html-strike', 'text-decoration-line'], ['.meo-md-subscript', '#html-sub', 'font-size'],
          ['.meo-md-superscript', '#html-sup', 'font-size'], ['.meo-md-highlight', '#html-mark', 'background-color'],
          ['.meo-md-h1', '#html-heading', 'font-size'], ['.meo-md-h1', '#html-heading', 'font-weight'],
          ['.meo-md-h1', '#html-heading', 'color'], ['.meo-md-inline-code', '#html-code', 'font-size'],
          ['.meo-md-inline-code', '#html-code', 'padding-left'], ['.meo-md-inline-code', '#html-code', 'border-radius'],
          ['.meo-md-inline-code', '#html-code', 'color'], ['.meo-md-inline-code', '#html-code', '-webkit-text-fill-color']
        ].map(([markdown, raw, property]) => ({ markdown, property,
          ordinary: style(host.querySelector(markdown)!, property), html: style(host.querySelector(raw)!, property) }));
        const author = host.querySelector('#author-style')!;
        const previewAuthor = doc.querySelector('#author-style')!;
        const codeStyle = (needle: string) => {
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent === needle && node.parentElement) return {
              weight: style(node.parentElement, 'font-weight'), family: style(node.parentElement, 'font-family'),
              italic: style(node.parentElement, 'font-style')
            };
          }
          throw new Error('Missing inline code: ' + needle);
        };
        const result = { pairs, code: {
          plain: codeStyle('MarkdownCode'), strong: codeStyle('MarkdownStrongCode'), emphasis: codeStyle('MarkdownEmCode'),
          htmlPlain: codeStyle('HTML code'), htmlStrong: codeStyle('HTML strong code'), htmlEmphasis: codeStyle('HTML emphasis code')
        }, author: [style(author, 'font-size'), style(author, 'font-weight'), style(author, 'color')],
          previewAuthor: [style(previewAuthor, 'font-size'), style(previewAuthor, 'font-weight'), style(previewAuthor, 'color')],
          inherited: style(host.querySelector('#author-inherited')!, 'color'),
          previewInherited: style(doc.querySelector('#author-inherited')!, 'color'),
          codeColors: ['#html-block-code', '#html-code-inherited', '#html-code-author', '#html-code-stylesheet'].map(selector => ({
            color: style(host.querySelector(selector)!, 'color'), fill: style(host.querySelector(selector)!, '-webkit-text-fill-color')
          })),
          plainColor: style(editor.view.contentDOM, 'color'), strongColor: style(host.querySelector('.meo-md-strong')!, 'color'),
          previewStrong: style(doc.querySelector('#html-strong')!, 'font-weight'),
          previewSub: style(doc.querySelector('#html-sub')!, 'font-size'), unchanged: editor.getText() === source };
        if (!(window as any).__contentPolicyEditor) (window as any).__contentPolicyEditor = editor;
        else { (window as any).__contentPolicyEditor.destroy(); (window as any).__contentPolicyEditor = editor; }
        return result;
      }, { source, html, css, caret: formatting.length + 7 });
      for (const pair of result.pairs) assert.equal(pair.html, pair.ordinary, `${appearance}/${large}/${pair.markdown}/${pair.property}`);
      assert.equal(result.code.plain.weight, '500', 'plain code retains the source font weight preference');
      assert.equal(result.code.strong.weight, '700', 'strong code retains semantic weight');
      assert.equal(result.code.emphasis.italic, 'italic');
      assert.equal(result.code.strong.family, result.code.plain.family);
      assert.equal(result.code.emphasis.family, result.code.plain.family);
      assert.deepEqual(result.code.htmlPlain, result.code.plain);
      assert.deepEqual(result.code.htmlStrong, result.code.strong);
      assert.deepEqual(result.code.htmlEmphasis, result.code.emphasis);
      assert.deepEqual(result.author, ['21px', '300', 'rgb(123, 45, 67)']);
      assert.deepEqual(result.previewAuthor, result.author);
      assert.equal(result.inherited, 'rgb(123, 45, 67)');
      assert.equal(result.previewInherited, result.inherited);
      const expectedCodeColors = [result.plainColor, 'rgb(123, 45, 67)', 'rgb(67, 89, 123)', 'rgb(45, 67, 89)'];
      assert.deepEqual(result.codeColors, expectedCodeColors.map(color => ({ color, fill: color })),
        `${appearance}/${large}: HTML block code inherits document/author colors instead of the Webview foreground`);
      if (appearance === 'dark') assert.notEqual(result.strongColor, result.plainColor, 'theme defaults retain the existing dark strong emphasis');
      assert.equal(result.previewStrong, '700'); assert.equal(result.unchanged, true);
      if (process.env.MEO_TEST_SCREENSHOTS && !large) {
        fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `content-policy-${appearance}.png`) });
      }
      await page.evaluate(() => { (window as any).__contentPolicyEditor.destroy(); delete (window as any).__contentPolicyEditor; });
      const inputSource = '> quote\n2. next\n\nAFTER' + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      await page.evaluate(source => {
        const host = document.querySelector('#live')!; host.replaceChildren();
        const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
        (window as any).__contentInputEditor = editor;
        editor.view.dispatch({ selection: { anchor: source.indexOf('2. next') } }); editor.view.focus();
      }, inputSource);
      await page.keyboard.type('> ');
      await page.waitForFunction(() => (window as any).__contentInputEditor.getText().startsWith('> quote\n> 2. next'));
      const inputQuotes = () => page.evaluate(() => {
        const editor = (window as any).__contentInputEditor;
        return [...editor.view.contentDOM.querySelectorAll('.cm-line.meo-md-quote')]
          .map(line => editor.view.state.doc.lineAt(editor.view.posAtDOM(line)).number);
      });
      await page.waitForFunction(() => (window as any).__contentInputEditor.view.contentDOM.querySelectorAll('.cm-line.meo-md-quote').length === 2);
      assert.deepEqual(await inputQuotes(), [1, 2]);
      await page.evaluate(async () => { await (window as any).__contentInputEditor.undo(); });
      await page.waitForFunction(expected => (window as any).__contentInputEditor.getText() === expected, {}, inputSource);
      await page.waitForFunction(() => (window as any).__contentInputEditor.view.contentDOM.querySelectorAll('.cm-line.meo-md-quote').length === 1);
      assert.deepEqual(await inputQuotes(), [1]);
      await page.evaluate(() => { (window as any).__contentInputEditor.destroy(); delete (window as any).__contentInputEditor; });

      const quoteSource = '> > 表格后的同项正文。\n/i\n\nAFTER' + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      const caret = quoteSource.indexOf('/i');
      const click = await page.evaluate(async ({ source, caret }) => {
        const harness = (window as any).ListEditingHarness;
        const host = document.querySelector('#live')!; host.replaceChildren();
        const editor = harness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
        (window as any).__quoteInputEditor = editor;
        editor.view.dispatch({ selection: { anchor: source.indexOf('AFTER') } });
        for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const rect = editor.view.coordsAtPos(caret)!;
        return { x: Math.ceil(rect.left + 1), y: Math.floor((rect.top + rect.bottom) / 2),
          optimized: harness.usesLargeDocumentDerivedWorkBudget(editor.view.state) };
      }, { source: quoteSource, caret });
      assert.equal(click.optimized, large);
      await page.mouse.click(click.x, click.y);
      assert.equal(await page.evaluate(() => (window as any).__quoteInputEditor.view.state.selection.main.head), caret,
        'clicking the first lazy-continuation glyph keeps its source boundary');
      await page.evaluate(() => {
        const editor = (window as any).__quoteInputEditor;
        (window as any).__quoteInputFrames = (async () => {
          const samples = [];
          for (let i = 0; i < 24; i++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const text = editor.getText();
            const body = editor.view.coordsAtPos(text.indexOf('表格后的同项正文。'))!;
            const continuation = editor.view.coordsAtPos(editor.view.state.doc.line(2).from)!;
            samples.push({ delta: continuation.left - body.left, text });
          }
          return samples;
        })();
      });
      await page.keyboard.type('x');
      const frames = await page.evaluate(async () => await (window as any).__quoteInputFrames);
      const typedSource = quoteSource.replace('/i', 'x/i');
      assert.ok(frames.some(frame => frame.text === typedSource), 'sample actual native input frames');
      assert.ok(frames.every(frame => Math.abs(frame.delta) <= 1), 'native input retains paragraph alignment on every sampled frame');
      for (const operation of ['undo', 'redo'] as const) {
        const snapshot = await page.evaluate(async operation => {
          const editor = (window as any).__quoteInputEditor;
          await editor[operation]();
          for (let i = 0; i < 6; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const text = editor.getText();
          return { text, caret: editor.view.state.selection.main.head,
            delta: editor.view.coordsAtPos(editor.view.state.doc.line(2).from)!.left
              - editor.view.coordsAtPos(text.indexOf('表格后的同项正文。'))!.left };
        }, operation);
        assert.equal(snapshot.text, operation === 'undo' ? quoteSource : typedSource);
        assert.equal(snapshot.caret, caret + (operation === 'redo' ? 1 : 0));
        assert.ok(Math.abs(snapshot.delta) <= 1, operation + ' preserves lazy-continuation alignment');
      }
      if (process.env.MEO_TEST_SCREENSHOTS && !large) {
        const html = renderMarkdownToHtml({ markdownText: typedSource, markdownFilePath: 'D:/fixture/content.md', target: 'html' }).html;
        const css = buildPreviewStyles({ previewFontFamily: '' }, appearance);
        await page.evaluate(({ html, css }) => {
          const doc = document.querySelector<HTMLIFrameElement>('#preview')!.contentDocument!;
          doc.open(); doc.write('<!doctype html><style>' + css + '</style><article class="meo-export-doc">' + html + '</article>'); doc.close();
        }, { html, css });
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `content-lazy-quote-${appearance}.png`) });
      }
      await page.evaluate(() => {
        (window as any).__quoteInputEditor.destroy(); delete (window as any).__quoteInputEditor; delete (window as any).__quoteInputFrames;
      });
    }
  }
} finally { await closeTestBrowser(browser); }
console.log('PASS shared content policy: quote/list boundaries, lazy/wrapped continuation alignment, native input/undo/redo, Setext/table precedence, Markdown/HTML typography, author styles, light/dark, ordinary/optimized and mode roundtrips');
