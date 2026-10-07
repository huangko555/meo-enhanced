import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-composite-blocks-'));
const fence = String.fromCharCode(96).repeat(3);
const fixtures = {
  quote: ['# Quoted diagram', '', '> Explanation', '>', '> ' + fence + 'mermaid', '> flowchart LR', '>   A --> B', '> ' + fence, '>', '> Continuation'].join('\n'),
  table: ['# Nested table', '', '> Outer explanation', '>', '> > Inner explanation', '> >', '> > - Code item', '> >', '> >   ' + fence + 'json', '> >   { "nested": true, "details": "' + 'long code '.repeat(18) + '" }', '> >   ' + fence, '> >', '> >   Code continuation', '> >', '> > - Item', '> >', '> >   | Name | Amount |', '> >   | :--- | ---: |', '> >   | nested cell[^cell] | 12 |', '> >', '> >   Continuation', '', '[^cell]: Cell definition'].join('\n'),
  footnote: ['# Footnotes', '', 'Reference[^note].', '', '[^note]: Definition', '', '    > Nested quotation', '    >', '    > | Name | Value |', '    > | --- | --- |', '    > | footnote cell | 8 |', '    >', '    > ' + fence + 'mermaid', '    > flowchart LR', '    >   F --> N', '    > ' + fence, '', '    Final continuation.'].join('\n'),
  cells: ['| Content |', '| --- |', '| > outer<br>> > - [ ] nested task<br>> > - [x] complete<br>- 1. [ ] composite task |'].join('\n')
};

async function verifyFootnoteParagraphLayouts(browser: Awaited<ReturnType<typeof launchTestBrowser>>, bundlePath: string) {
  const page = await browser.newPage();
  let count = 0;
  try {
    await page.setViewport({ width: 900, height: 3000 });
    await page.setContent('<!doctype html><style>html,body{margin:0}#note{height:2900px}.cm-editor{height:100%}</style><div id="note"></div>');
    await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
    await page.addScriptTag({ path: bundlePath });
    for (const font of [{ family: 'Arial', size: 16 }, { family: 'Consolas, monospace', size: 24 }]) {
      for (const width of [620, 420]) {
        for (const number of [1, 10, 100]) {
          const previous = Array.from({ length: number - 1 }, (_, i) => 'Ref[^old' + i + ']').join(' ') + '\n\n'
            + Array.from({ length: number - 1 }, (_, i) => '[^old' + i + ']: Earlier note').join('\n');
          const text = '# Notes\n\n' + previous + '\n\nRef[^target].\n\n[^target]: Definition body ' + 'long prose '.repeat(18)
            + '\n\n    Continuation body ' + 'long prose '.repeat(18);
          await page.evaluate(({ font, width, text }) => {
            document.documentElement.style.setProperty('--meo-font-live', font.family);
            document.documentElement.style.setProperty('--meo-font-live-size', font.size + 'px');
            const host = document.getElementById('note')!; host.style.width = width + 'px';
            (window as any).__note?.destroy(); host.replaceChildren();
            const editor = (window as any).__note = (window as any).ListEditingHarness.createEditor({ parent: host, text, initialMode: 'live', onApplyChanges() {} });
            editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(text.indexOf('Definition body')).top - 120);
          }, { font, width, text });
          await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => requestAnimationFrame(() => r())); });
          await page.evaluate(() => { const view = (window as any).__note.view; view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(view.state.doc.toString().indexOf('Definition body')).top - 120); });
          await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => requestAnimationFrame(() => r())); });
          const result = await page.evaluate(() => {
            const editor = (window as any).__note, view = editor.view, text = editor.getText();
            const rows = (needle: string) => {
              const pos = text.indexOf(needle), from = view.domAtPos(pos), to = view.domAtPos(view.state.doc.lineAt(pos).to);
              const range = document.createRange(); range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
              const starts = new Map<number, number>();
              for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) { const y = Math.round(r.top); starts.set(y, Math.min(starts.get(y) ?? Infinity, r.left)); }
              return [...starts.values()];
            };
            return { definition: rows('Definition body'), continuation: rows('Continuation body'), text };
          });
          const label = [number, font.family, width].join('/');
          assert.ok(result.definition.length > 1 && result.continuation.length > 1, label + ': fixture must wrap');
          assert.ok([...result.definition, ...result.continuation].every(x => Math.abs(x - result.definition[0]!) <= 1), label + ': note paragraphs lose their shared slot ' + JSON.stringify(result));
          assert.equal(result.text, text);
          count++;
        }
      }
    }
  } finally { await page.close(); }
  console.log('PASS', count, 'footnote paragraph layouts: shared number slot, first-line wrapping and continuations');
}

async function verifyPreviewTaskContainerLayouts(browser: Awaited<ReturnType<typeof launchTestBrowser>>) {
  const page = await browser.newPage();
  const examples = [
    { name: 'root task', parent: '', prefix: '', marker: '- [ ] ', indent: '  ' },
    { name: 'ordered task', parent: '', prefix: '', marker: '1. [ ] ', indent: '   ' },
    { name: 'quote task', parent: '', prefix: '> ', marker: '- [ ] ', indent: '  ' },
    { name: 'task/quote/task', parent: '- [x] Outer task\n\n', prefix: '  > ', marker: '- [ ] ', indent: '  ' },
    { name: 'footnote10/quote/task', parent: '', prefix: '    > ', marker: '- [ ] ', indent: '  ', footnote: true }
  ];
  let count = 0;
  try {
    await page.setViewport({ width: 900, height: 3000 });
    for (const font of [{ family: 'Arial', size: 16 }, { family: 'Consolas, monospace', size: 24 }]) {
      for (const width of [620, 420]) {
        for (const appearance of ['light', 'dark'] as const) {
          for (const example of examples) {
            const prefix = example.prefix, contentPrefix = prefix + example.indent;
            const blank = prefix.includes('>') ? prefix.slice(0, prefix.lastIndexOf('>') + 1) : '';
            const previous = Array.from({ length: 9 }, (_, i) => 'Ref[^old' + i + ']').join(' ') + '\n\n'
              + Array.from({ length: 9 }, (_, i) => '[^old' + i + ']: Earlier note').join('\n');
            const text = (example.footnote ? previous + '\n\nRef[^task].\n\n[^task]: Definition\n\n' : '') + example.parent
              + [prefix + example.marker + 'Probe body ' + 'long prose '.repeat(18), blank,
                contentPrefix + 'Continuation body ' + 'long prose '.repeat(8), blank,
                contentPrefix + fence + 'js', contentPrefix + 'const preview_task = 1;', contentPrefix + fence, blank,
                contentPrefix + '| Name | Value |', contentPrefix + '| --- | --- |', contentPrefix + '| cell | 1 |', blank,
                contentPrefix + fence + 'mermaid', contentPrefix + 'flowchart LR', contentPrefix + 'A --> B', contentPrefix + fence, blank,
                contentPrefix + '$$', contentPrefix + 'E=mc^2', contentPrefix + '$$'
              ].join('\n');
            const rendered = renderMarkdownToHtml({ markdownText: text, markdownFilePath: 'task-layout.md', target: 'html', uiLanguage: 'en' });
            const styles = buildPreviewStyles({ previewFontFamily: font.family, editorFontSize: font.size }, appearance);
            await page.setContent('<!doctype html><style>' + styles + '</style><main class="meo-export-doc">' + rendered.html + '</main>');
            await page.addStyleTag({ content: 'html,body{margin:0}body{padding:16px}.meo-export-doc{width:' + width + 'px;font-family:' + font.family + ';font-size:' + font.size + 'px}' });
            const result = await page.evaluate(() => {
              const item = [...document.querySelectorAll<HTMLElement>('.meo-export-task-item')].find(e => {
                const first = e.querySelector(':scope > p .meo-export-task-text, :scope > .meo-export-task-text');
                return first?.textContent?.includes('Probe body');
              })!;
              const body = item.querySelector<HTMLElement>('.meo-export-task-text')!;
              const checkbox = item.querySelector<HTMLElement>('.meo-export-task-checkbox')!;
              const continuation = [...item.querySelectorAll<HTMLElement>(':scope > p')].find(e => e.textContent?.includes('Continuation body'))!;
              const rows = (element: HTMLElement) => {
                const range = document.createRange(); range.selectNodeContents(element);
                const starts = new Map<number, number>();
                for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) { const y = Math.round(r.top); starts.set(y, Math.min(starts.get(y) ?? Infinity, r.left)); }
                return [...starts.values()];
              };
              const left = body.getBoundingClientRect().left;
              const panels = ['.meo-export-code-block-wrap', '.meo-table-scroll', '.meo-export-mermaid', '.meo-export-math-display'].map(selector => item.querySelector<HTMLElement>(selector)!.getBoundingClientRect().left);
              let quoteRight = -Infinity;
              for (let parent = item.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'BLOCKQUOTE') quoteRight = Math.max(quoteRight, parent.getBoundingClientRect().left + parseFloat(getComputedStyle(parent).borderLeftWidth));
              const box = checkbox.getBoundingClientRect();
              return { left, bodyRows: rows(body), continuationRows: rows(continuation), panels, checkboxLeft: box.left, checkboxRight: box.right, quoteRight, boxTop: box.top, bodyTop: body.getBoundingClientRect().top, height: box.height };
            });
            const label = [example.name, font.family, width, appearance].join('/');
            assert.ok(result.checkboxLeft >= result.quoteRight + 4 && result.left >= result.checkboxRight + 4, label + ': markers overlap');
            assert.ok(result.bodyRows.length > 1 && result.continuationRows.length > 1, label + ': fixture must wrap');
            assert.ok([...result.bodyRows, ...result.continuationRows, ...result.panels].every(x => Math.abs(x - result.left) <= 1), label + ': task descendants lose their content column ' + JSON.stringify(result));
            assert.ok(result.boxTop >= result.bodyTop - 1 && result.height === 17, label + ': checkbox leaves its first row');
            count++;
          }
        }
      }
    }
  } finally { await page.close(); }
  console.log('PASS', count, 'Preview task layouts: quotes, ordered lists, nested tasks, footnotes, code, tables, diagrams, math, themes and wrapping');
}

async function verifyListContainerLayouts(browser: Awaited<ReturnType<typeof launchTestBrowser>>, bundlePath: string) {
  const page = await browser.newPage();
  const failures: string[] = [];
  const examples = [
    { name: 'root/bullet', parent: '', prefix: '', marker: '- ', indent: '  ' },
    { name: 'root/task', parent: '', prefix: '', marker: '- [ ] ', indent: '  ' },
    { name: 'quote/ordered task', parent: '', prefix: '> ', marker: '1. [ ] ', indent: '   ' },
    { name: 'task/quote/bullet', parent: '- [ ] Outer item\n\n', prefix: '  > ', marker: '- ', indent: '  ' },
    { name: 'task/quote/task', parent: '- [ ] Outer item\n\n', prefix: '  > ', marker: '- [ ] ', indent: '  ' },
    { name: 'quote/task/quote/bullet', parent: '> - [ ] Outer item\n>\n', prefix: '>   > ', marker: '- ', indent: '  ' },
    { name: 'quote/bullet', parent: '', prefix: '> ', marker: '- ', indent: '  ' },
    { name: 'double quote/bullet', parent: '', prefix: '> > ', marker: '- ', indent: '  ' },
    { name: 'quote/ordered', parent: '', prefix: '> ', marker: '1. ', indent: '   ' },
    { name: 'quote/task', parent: '', prefix: '> ', marker: '- [ ] ', indent: '  ' },
    { name: 'list/quote/bullet', parent: '- Outer item\n\n', prefix: '  > ', marker: '- ', indent: '  ' },
    { name: 'quote/list/quote/bullet', parent: '> - Outer item\n>\n', prefix: '>   > ', marker: '- ', indent: '  ' },
    { name: 'tab quote/bullet', parent: '', prefix: '> ', marker: '- ', indent: '  ', tab: true }
  ];
  let count = 0;
  try {
    await page.setViewport({ width: 900, height: 3000 });
    await page.setContent('<!doctype html><style>html,body{margin:0}#lists{height:2900px}.cm-editor{height:100%}</style><div id="lists"></div>');
    await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-font-source:monospace;--meo-semantic-blockquoteBorder:#888;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}' });
    await page.addScriptTag({ path: bundlePath });
    for (const font of [{ family: 'Arial', size: 16 }, { family: 'Consolas, monospace', size: 24 }]) {
      for (const width of [620, 420]) {
        await page.evaluate(({ font, width }) => {
          document.documentElement.style.setProperty('--meo-font-live', font.family);
          document.documentElement.style.setProperty('--meo-font-live-size', font.size + 'px');
          document.getElementById('lists')!.style.width = width + 'px';
        }, { font, width });
        for (const number of [0, 1, 10, 100]) {
          const previous = Array.from({ length: Math.max(0, number - 1) }, (_, i) => 'Ref[^old' + i + ']').join(' ') + '\n\n'
            + Array.from({ length: Math.max(0, number - 1) }, (_, i) => '[^old' + i + ']: Previous note').join('\n');
          for (const example of examples) {
            if (example.tab && !number) continue;
            const base = number ? example.tab ? '\t' : '    ' : '';
            const prefix = base + example.prefix;
            const blank = prefix.slice(0, prefix.lastIndexOf('>') + 1);
            const contentPrefix = prefix + example.indent;
            const lead = '# Layout\n\n' + (number ? previous + '\n\nRef[^target].\n\n[^target]: Definition\n\n' : '');
            const parent = example.parent.split('\n').map(row => row ? base + row : '').join('\n');
            const text = lead + parent + [prefix + 'Inner explanation', blank,
              prefix + example.marker + 'Probe item ' + 'long prose '.repeat(18), blank,
              contentPrefix + 'Continuation body ' + 'long prose '.repeat(8), blank,
              contentPrefix + fence + 'js', contentPrefix + 'const nested = 1;', contentPrefix + fence, blank,
              contentPrefix + '| Name | Value |', contentPrefix + '| --- | --- |', contentPrefix + '| cell | 1 |'
            ].join('\n');
            await page.evaluate(text => {
              (window as any).__listMatrix?.destroy();
              document.getElementById('lists')!.replaceChildren();
              (window as any).__listMatrix = (window as any).ListEditingHarness.createEditor({ parent: document.getElementById('lists')!, text, initialMode: 'live', onApplyChanges() {} });
            }, text);
            for (const active of [false, true]) {
              await page.evaluate(active => {
                const view = (window as any).__listMatrix.view;
                const pos = view.state.doc.toString().indexOf('Probe item');
                view.dispatch({ selection: { anchor: active ? pos : 0 } });
                view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(pos).top - 120);
              }, active);
              await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => requestAnimationFrame(() => r())); });
              // The initial height estimate can clamp the reveal before the
              // continuation and following blocks enter the rendered viewport.
              await page.evaluate(() => {
                const view = (window as any).__listMatrix.view;
                const pos = view.state.doc.toString().indexOf('Probe item');
                view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(pos).top - 120);
              });
              await page.waitForFunction(() => {
                const view = (window as any).__listMatrix.view;
                return view.viewport.to >= view.state.doc.toString().indexOf('| cell |');
              });
              const result = await page.evaluate(() => {
                const view = (window as any).__listMatrix.view;
                const text = view.state.doc.toString();
                const dom = view.domAtPos(text.indexOf('Probe item') + 1);
                const line = (dom.node.nodeType === Node.ELEMENT_NODE ? dom.node : dom.node.parentElement).closest('.cm-line') as HTMLElement;
                const rect = line.getBoundingClientRect();
                const rail = getComputedStyle(line, '::before');
                const railRight = rail.content === 'none' ? -Infinity : rect.left + parseFloat(rail.left) + Math.max(...rail.backgroundPositionX.split(',').map(Number.parseFloat)) + 3;
                const marker = line.querySelector<HTMLElement>('.meo-md-list-marker, .meo-task-checkbox')!;
                const range = document.createRange();
                const start = view.domAtPos(text.indexOf('Probe item'));
                const end = view.domAtPos(view.state.doc.lineAt(text.indexOf('Probe item')).to);
                range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
                const rows = new Map<number, number>();
                for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) { const y = Math.round(r.top); rows.set(y, Math.min(rows.get(y) ?? Infinity, r.left)); }
                const bodyLeft = [...rows.values()][0]!;
                const continuation = view.domAtPos(text.indexOf('Continuation body'));
                const continuationEnd = view.domAtPos(view.state.doc.lineAt(text.indexOf('Continuation body')).to);
                const continuationRange = document.createRange(); continuationRange.setStart(continuation.node, continuation.offset); continuationRange.setEnd(continuationEnd.node, continuationEnd.offset);
                const code = [...document.querySelectorAll<HTMLElement>('#lists .meo-md-code-container-line')].find(e => e.textContent?.includes('const nested'))!;
                const table = document.querySelector<HTMLElement>('#lists .meo-md-html-table-shell')!;
                const slot = line.querySelector<HTMLElement>('.meo-md-footnote-backref-spacer');
                const continuationRows = new Map<number, number>();
                for (const r of continuationRange.getClientRects()) if (r.width > 0 && r.height > 0) { const y = Math.round(r.top); continuationRows.set(y, Math.min(continuationRows.get(y) ?? Infinity, r.left)); }
                return { continuationRows: [...continuationRows.values()], quoteWidth: parseFloat(getComputedStyle(view.dom).getPropertyValue('--meo-live-container-ch')), quoteCount: line.querySelectorAll('.meo-md-quote-marker-active').length, railRight, markerLeft: marker.getBoundingClientRect().left, markerRight: marker.getBoundingClientRect().right, bodyLeft, rows: [...rows.values()], continuationLeft: [...continuationRows.values()][0], codeLeft: code?.getBoundingClientRect().left, tableLeft: table?.getBoundingClientRect().left, slotWidth: slot?.getBoundingClientRect().width, source: text };
              });
              count++;
              const label = [example.name, number, font.family, width, active ? 'active' : 'inactive'].join('/');
              try {
                assert.ok(result.markerLeft >= result.railRight + 4, 'list marker crosses the quote rail: ' + JSON.stringify(result));
                assert.ok(result.bodyLeft >= result.markerRight + (example.marker.includes('[ ]') ? 4 : -1), 'body overlaps its marker');
                assert.ok(result.rows.length > 1 && result.rows.every(x => Math.abs(x - result.bodyLeft) <= 1), 'wrapped list body must retain its first column');
                assert.ok(result.continuationRows.length > 1 && result.continuationRows.every(x => Math.abs(x - result.continuationLeft) <= 1), 'wrapped continuation must stay inside its containers');
                assert.ok(Math.abs(result.continuationLeft - (result.bodyLeft - result.quoteCount * result.quoteWidth)) <= 1, 'list continuation must share its body column: ' + JSON.stringify(result));
                assert.ok(Math.abs(result.codeLeft - (result.bodyLeft - result.quoteCount * result.quoteWidth)) <= 1 && Math.abs(result.tableLeft - (result.bodyLeft - result.quoteCount * result.quoteWidth)) <= 1, 'code and table must share the list body column: ' + JSON.stringify(result));
                assert.equal(result.source, text, 'layout must preserve source');
              } catch (error) { failures.push(label + ': ' + String(error).split(': {')[0]); }
            }
          }
        }
      }
    }
  } finally { await page.close(); }
  assert.deepEqual(failures, [], failures.slice(0, 30).join('\n') + '\nFailures: ' + failures.length + '/' + count);
  console.log('PASS', count, 'list container layouts: note digits, quotes, markers, fonts, wrapping and editing');
}


async function verifyCodeContainerLayouts(browser: Awaited<ReturnType<typeof launchTestBrowser>>, bundlePath: string) {
  const payload = 'const probe = "' + 'long code '.repeat(20) + '";';
  const examples = [
    {name:'task fence',parent:'- [ ] Item',prefix:'  ',kind:'fenced'},
    {name:'quote/task fence',parent:'> - [x] Item',prefix:'>   ',kind:'fenced'},
    {name:'footnote/task/quote fence',parent:'Reference[^n].\n\n[^n]: Definition\n\n    - [~] Item\n\n      > Explanation',prefix:'      > ',kind:'fenced'},
    {name:'task indented',parent:'- [-] Item',prefix:'      ',kind:'indented'},
    {name:'root fence',parent:'',prefix:'',kind:'fenced'},
    {name:'indented opening fence',parent:'',prefix:'  ',kind:'fenced'},
    {name:'quote with indented opening fence',parent:'> Explanation',prefix:'>   ',kind:'fenced'},
    {name:'list with indented opening fence',parent:'- Item',prefix:'    ',kind:'fenced'},
    {name:'partial tab list fence',parent:'- Item',prefix:'  ',bodyPrefix:'\t',inset:2,kind:'fenced'},
    {name:'partial tab list indented',parent:'- Item',prefix:'  \t\t',inset:2,kind:'indented'},
    {name:'list fence',parent:'- Item',prefix:'  ',kind:'fenced'},
    {name:'quote fence',parent:'> Explanation',prefix:'> ',kind:'fenced'},
    {name:'quote/list fence',parent:'> > - Item',prefix:'> >   ',kind:'fenced'},
    {name:'list/quote fence',parent:'- Item\n\n  > Explanation',prefix:'  > ',kind:'fenced'},
    {name:'footnote fence',parent:'Reference[^n].\n\n[^n]: Definition',prefix:'    ',kind:'fenced'},
    {name:'footnote/quote fence',parent:'Reference[^n].\n\n[^n]: Definition\n\n    > Explanation',prefix:'    > ',kind:'fenced'},
    {name:'footnote/list fence',parent:'Reference[^n].\n\n[^n]: Definition\n\n    - Item',prefix:'      ',kind:'fenced'},
    {name:'footnote/list/quote fence',parent:'Reference[^n].\n\n[^n]: Definition\n\n    - Item\n\n      > Explanation',prefix:'      > ',kind:'fenced'},
    {name:'tab footnote/quote fence',parent:'Reference[^n].\n\n[^n]: Definition\n\n\t> Explanation',prefix:'\t> ',kind:'fenced'},
    {name:'tab list fence',parent:'10. Item',prefix:'\t',kind:'fenced'},
    {name:'mixed whitespace fence',parent:'10. Item',prefix:'  \t',kind:'fenced'},
    {name:'root indented',parent:'',prefix:'    ',kind:'indented'},
    {name:'footnote indented',parent:'Reference[^n].\n\n[^n]: Definition',prefix:'        ',kind:'indented'},
    {name:'footnote/list indented',parent:'Reference[^n].\n\n[^n]: Definition\n\n    - Item',prefix:'          ',kind:'indented'},
    {name:'quote indented',parent:'> Explanation',prefix:'>     ',kind:'indented'},
    {name:'list indented',parent:'- Item',prefix:'      ',kind:'indented'},
    {name:'footnote/quote indented',parent:'Reference[^n].\n\n[^n]: Definition\n\n    > Explanation',prefix:'    >     ',kind:'indented'},
    {name:'tab indented',parent:'',prefix:'\t',kind:'indented'}
  ];
  const page = await browser.newPage();
  const failures: string[] = [];
  let count = 0;
  let operations = 0;
  try {
    await page.setViewport({width:900,height:1100});
    await page.setContent('<!doctype html><style>html,body{margin:0}#matrix{height:1000px}#matrix .cm-editor{height:100%}</style><div id="matrix"></div>');
    await page.addStyleTag({path:path.join(root,'webview/src/styles.css')});
    await page.addStyleTag({content:':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-font-source:monospace;--meo-semantic-blockquoteBorder:#888;--meo-semantic-blockquoteForeground:#555;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'});
    await page.addScriptTag({path:bundlePath});
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(text:string){(window as any).__copiedCode=text;return Promise.resolve();}}}));
    for(const font of [{family:'Arial',size:16},{family:'Consolas, monospace',size:24}]) {
      for(const width of [680,420]) {
        await page.evaluate(({font,width})=>{
          document.documentElement.style.setProperty('--meo-font-live',font.family);
          document.documentElement.style.setProperty('--meo-font-live-size',font.size+'px');
          document.getElementById('matrix')!.style.width=width+'px';
        },{font,width});
        for(const fixture of examples) {
          const bodyPrefix = 'bodyPrefix' in fixture ? fixture.bodyPrefix! : fixture.prefix;
          const code = fixture.kind==='fenced'
            ? [fixture.prefix+fence+'js',bodyPrefix+payload,bodyPrefix+'  const child = 2;',fixture.prefix+fence]
            : [fixture.prefix+payload,fixture.prefix+'  const child = 2;'];
          const blank = fixture.prefix.includes('>') ? fixture.prefix.slice(0,fixture.prefix.lastIndexOf('>')+1) : '';
          const text = ['# Layout','',fixture.parent,blank,...code,'','After'].join('\n');
          await page.evaluate(text=>{
            (window as any).__matrix?.destroy();
            (window as any).__matrix=(window as any).ListEditingHarness.createEditor({parent:document.getElementById('matrix')!,text,initialMode:'live',uiLanguage:'en',onApplyChanges(){}});
          },text);
          let inactiveRail:number|null=null;
          for(const active of [false,true]) {
            await page.evaluate(active=>{
              const view=(window as any).__matrix.view;
              view.dispatch({selection:{anchor:active?view.state.doc.toString().indexOf('const probe'):0}});
            },active);
            await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
            const result = await page.evaluate(()=>{
              const view=(window as any).__matrix.view, text=view.state.doc.toString(),pos=text.indexOf('const probe');
              const start=view.domAtPos(pos),end=view.domAtPos(view.state.doc.lineAt(pos).to);
              const line=(start.node.nodeType===Node.ELEMENT_NODE?start.node:start.node.parentElement).closest('.cm-line') as HTMLElement;
              const range=document.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);
              const bodyTop=view.coordsAtPos(pos).top,rows=new Map<number,number>();
              let payloadRight=0;
              for(const r of range.getClientRects())if(r.width>0&&r.height>0&&r.top>=bodyTop-2){const y=Math.round(r.top);rows.set(y,Math.min(rows.get(y)??Infinity,r.left));payloadRight=Math.max(payloadRight,r.right);}
              const r=line.getBoundingClientRect(),s=getComputedStyle(line),number=getComputedStyle(line,line.classList.contains('meo-md-quote')?'::after':'::before');
              const expectedLeft=r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft);
              const rails=getComputedStyle(line,'::before');
              const lastRail=line.classList.contains('meo-md-quote')?r.left+parseFloat(rails.left)+Math.max(...rails.backgroundPositionX.split(',').map(Number.parseFloat)):null;
              const childPos=text.indexOf('const child'),child=view.domAtPos(childPos),childEnd=view.domAtPos(childPos+1),childRange=document.createRange();childRange.setStart(child.node,child.offset);childRange.setEnd(childEnd.node,childEnd.offset);
              const unit=document.createElement('span');unit.style.cssText='position:absolute;width:1ch;height:0';line.append(unit);const ch=unit.getBoundingClientRect().width;unit.remove();
              const header=document.querySelector('#matrix .meo-md-code-block-start')!;
              const infoPos=text.indexOf('```js')+3;
              let headerSourceHidden=true;
              if(infoPos>=3){
                const info=view.domAtPos(infoPos+1);
                let element:HTMLElement|null=info.node.nodeType===Node.ELEMENT_NODE?info.node as HTMLElement:info.node.parentElement;
                headerSourceHidden=false;
                for(;element&&header.contains(element);element=element.parentElement){
                  const style=getComputedStyle(element);
                  if(style.opacity==='0'||style.color==='transparent'||style.color==='rgba(0, 0, 0, 0)'||style.display==='none'||style.visibility==='hidden'){headerSourceHidden=true;break;}
                }
              }
              return {rows:[...rows.values()],expectedLeft,numberRight:r.left+parseFloat(number.left)+parseFloat(number.width),lastRail,panelLeft:r.left,childLeft:childRange.getBoundingClientRect().left,ch,numberTop:parseFloat(number.top),topPadding:parseFloat(s.paddingTop),payloadRight,panelRight:r.right,rightPadding:parseFloat(s.paddingRight),prefixHidden:[...line.querySelectorAll('.meo-md-code-container-prefix')].every(e=>getComputedStyle(e).opacity==='0'),headerSourceHidden,labels:header.querySelectorAll('.meo-code-language-label').length};
            });
            count++;
            const label=fixture.name+'/'+font.family+'/'+width+'/'+(active?'active':'inactive');
            try {
              assert.ok(result.rows.length>=2,'fixture did not wrap');
              assert.ok(Math.abs(result.numberTop-result.topPadding)<=1,'wrapped code number must align to the first visual row');
              assert.ok(result.rightPadding>=2*result.ch-1,'code must retain its right inner spacing');
              assert.ok(result.payloadRight<=result.panelRight-2*result.ch+1,'wrapped payload touches the right panel edge');
              assert.equal(result.labels,1,'code header must own exactly one label');
              assert.ok(result.headerSourceHidden,'raw fence language duplicates the header label');
              assert.ok(result.prefixHidden,'consumed Markdown prefix must stay outside the code gutter');
              if(!active)inactiveRail=result.lastRail;
              else assert.equal(result.lastRail,inactiveRail,'quote rail must not move when code is activated');
              assert.ok(result.rows.every((x,i)=>Math.abs(x-result.expectedLeft-(i===0?('inset' in fixture?fixture.inset!:0)*result.ch:0))<=1),'source prefix shifts code: '+JSON.stringify(result));
              assert.ok(result.rows[0]!>=result.numberRight+6,'code overlaps the line-number gutter');
              assert.ok(Math.abs(result.childLeft-result.expectedLeft-(2+('inset' in fixture?fixture.inset!:0))*result.ch)<=1,'payload indentation was consumed as a container prefix');
              if(result.lastRail!==null)assert.ok(result.panelLeft>=result.lastRail+6,'code panel covers a quote rail');
            }catch(error){failures.push(label+': '+String(error));}
          }
          if(font.size===16&&width===680) {
            const label=fixture.name+'/operations';
            try {
              await page.click('#matrix .meo-copy-code-btn');
              const copied=await page.evaluate(()=>(window as any).__copiedCode);
              const inset='inset' in fixture?fixture.inset!:0;
              assert.equal(copied,' '.repeat(inset)+payload+'\n'+' '.repeat(inset+2)+'const child = 2;','copy must exclude Markdown containers and retain payload indentation');
              const anchor=text.indexOf('const probe')+'const probe'.length;
              await page.evaluate(anchor=>{const editor=(window as any).__matrix;editor.view.dispatch({selection:{anchor}});editor.view.focus();},anchor);
              await page.evaluate(async()=>{for(let i=0;i<3;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
              const caret=await page.evaluate(anchor=>(window as any).__matrix.view.coordsAtPos(anchor),anchor);
              assert.ok(caret);await page.mouse.click(caret.left,(caret.top+caret.bottom)/2);
              assert.equal(await page.evaluate(()=>(window as any).__matrix.view.state.selection.main.head),anchor,'pointer must map to the original source');
              await page.keyboard.type('X');
              const edited=text.slice(0,anchor)+'X'+text.slice(anchor);
              await page.waitForFunction(text=>(window as any).__matrix.getText()===text,{timeout:2000},edited);
              for(const [key,expected] of [['z',text],['y',edited],['z',text]]) {
                await page.keyboard.down('Control');await page.keyboard.press(key!);await page.keyboard.up('Control');
                await page.waitForFunction(text=>(window as any).__matrix.getText()===text,{timeout:2000},expected);
              }
              const end=text.indexOf(payload)+payload.length;
              await page.evaluate(anchor=>{const editor=(window as any).__matrix;editor.view.dispatch({selection:{anchor}});editor.view.focus();},end);
              await page.keyboard.press('Enter');await page.keyboard.type('const added = 3;');
              await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
              await page.click('#matrix .meo-copy-code-btn');
              assert.equal(await page.evaluate(()=>(window as any).__copiedCode),' '.repeat(inset)+payload+'\n'+' '.repeat(inset)+'const added = 3;\n'+' '.repeat(inset+2)+'const child = 2;','Enter must keep the new line inside the code container and retain payload indentation');
              await page.evaluate(text=>(window as any).__matrix.setText(text,true),text);
              await page.evaluate(()=>{(window as any).__matrix.setMode('source');});
              await page.waitForFunction(()=>!!document.querySelector('#matrix .meo-mode-source'),{timeout:2000});
              await page.evaluate(()=>{(window as any).__matrix.setMode('live');});
              await page.waitForFunction(text=>!!document.querySelector('#matrix .meo-mode-live')&&(window as any).__matrix.getText()===text,{timeout:2000},text);
              if(fixture.kind==='fenced'){
                const languagePos=text.indexOf('```js')+4;
                await page.evaluate(anchor=>{const view=(window as any).__matrix.view;view.dispatch({selection:{anchor}});view.focus();},languagePos);
                await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
                assert.equal(await page.evaluate(()=>document.querySelectorAll('#matrix .meo-md-code-block-start .meo-code-language-label').length),0,'active fence must expose its editable language instead of a duplicate label');
                await page.keyboard.type('x');
                await page.waitForFunction(text=>(window as any).__matrix.getText()===text,{timeout:2000},text.slice(0,languagePos)+'x'+text.slice(languagePos));
                await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');
                await page.waitForFunction(text=>(window as any).__matrix.getText()===text,{timeout:2000},text);
              }
              operations++;
            }catch(error){failures.push(label+': '+String(error));}
          }
        }
      }
    }
    await page.evaluate(()=>{document.documentElement.style.setProperty('--meo-font-live','Arial');document.documentElement.style.setProperty('--meo-font-live-size','16px');document.getElementById('matrix')!.style.width='680px';});
    for(const fixture of examples.filter(e=>['quote/list fence','footnote/list/quote fence','list with indented opening fence'].includes(e.name))) {
      const payloads=Array.from({length:125},(_,i)=>'const line'+i+' = '+i+';');
      const blank=fixture.prefix.slice(0,fixture.prefix.lastIndexOf('>')+1);
      const rows=payloads.map(p=>fixture.prefix+p);
      const code=fixture.kind==='fenced'?[fixture.prefix+fence+'js',...rows,fixture.prefix+fence]:rows;
      const text=['# Fold','',fixture.parent,blank,...code,'','After'].join('\n');
      try {
        await page.evaluate(text=>{
          (window as any).__matrix.destroy();
          (window as any).__matrix=(window as any).ListEditingHarness.createEditor({parent:document.getElementById('matrix')!,text,initialMode:'live',uiLanguage:'en',initialLongCodeBlockFolding:true,onApplyChanges(){}});
        },text);
        await page.waitForSelector('#matrix .meo-md-long-code-placeholder');
        const checkEdges=async(selector:string)=>{
          const edges=await page.evaluate(selector=>{
            const code=document.querySelector('#matrix .meo-md-code-line-numbered')!.getBoundingClientRect();
            const control=document.querySelector(selector)!.getBoundingClientRect();
            return {code:{left:code.left,right:code.right},control:{left:control.left,right:control.right}};
          },selector);
          assert.ok(Math.abs(edges.code.left-edges.control.left)<=1&&Math.abs(edges.code.right-edges.control.right)<=1,'fold controls must share the code panel boundary: '+JSON.stringify(edges));
        };
        await checkEdges('#matrix .meo-md-long-code-placeholder');
        await page.click('#matrix .meo-md-long-code-placeholder .meo-long-code-action');
        await page.waitForFunction(()=>!document.querySelector('#matrix .meo-md-long-code-placeholder'));
        await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
        await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');
        await page.waitForSelector('#matrix .meo-md-long-code-footer');
        await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
        await checkEdges('#matrix .meo-md-long-code-footer');
        await page.click('#matrix .meo-md-long-code-footer .meo-long-code-action');
        await page.waitForSelector('#matrix .meo-md-long-code-placeholder');
        await page.keyboard.down('Control');await page.keyboard.press('Home');await page.keyboard.up('Control');
        await page.evaluate(async()=>{for(let i=0;i<6;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
        await page.click('#matrix .meo-copy-code-btn');
        assert.equal(await page.evaluate(()=>(window as any).__copiedCode),payloads.join('\n'),'folded copy must include every payload line');
        assert.equal(await page.evaluate(()=>(window as any).__matrix.getText()),text,'folding must preserve source');
        console.log('PASS nested folding, three-digit gutter and complete copy:',fixture.name);
      }catch(error){failures.push(fixture.name+'/folding: '+String(error));}
    }
  }finally{await page.close();}
  assert.deepEqual(failures,[],failures.slice(0,24).join('\n')+'\nFailures: '+failures.length+'/'+count);
  console.log('PASS',count,'code container layouts: fonts, narrow/wide, active/inactive, footnotes, quotes, lists, tabs and indented code');
  console.log('PASS',operations,'code container operations: copy, pointer, input, Enter, undo/redo and Source/Live roundtrip');
}

async function main() {
  for (const baseline of [2, 4]) {
    const markdownText = ["Reference[^nested]", "", "[^nested]: Opening", "",
      " ".repeat(baseline) + "- Parent", " ".repeat(baseline + 2) + "- Child"].join("\n");
    const result = renderMarkdownToHtml({markdownText, markdownFilePath:"test.md", target:"html"});
    assert.equal((result.html.match(/<ul\b/g) ?? []).length, 2, "footnote nesting must retain its continuation baseline");
  }
  const build = await Bun.build({entrypoints:[path.join(root,'scripts/test-list-editing-entry.ts')], outdir:temp, target:'browser', format:'iife', naming:'bundle.js'});
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({width:900,height:1100});
    await page.setContent('<!doctype html><style>html,body{margin:0}.host{width:680px;height:500px}.host .cm-editor{height:100%}</style><div id="quote" class="host"></div><div id="table" class="host"></div><div id="footnote" class="host"></div><div id="preview"></div><div id="preview-notes"></div>');
    await page.addStyleTag({path:path.join(root,'webview/src/styles.css')});
    await page.addStyleTag({content:':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-color-base05:#0969da;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:14px;--meo-semantic-blockquoteBorder:#888;--meo-semantic-blockquoteForeground:#555;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'});
    await page.addScriptTag({path:path.join(temp,'bundle.js')});
    const preview = renderMarkdownToHtml({markdownText:fixtures.cells+'\n\nFirst[^repeat], second[^repeat], third[^repeat].\n\n[^repeat]: Repeated definition.',markdownFilePath:'test.md',target:'html',uiLanguage:'en',showComments:false,deferImages:true});
    const previewNotes = renderMarkdownToHtml({markdownText:fixtures.footnote,markdownFilePath:'test.md',target:'html',uiLanguage:'en',showComments:false});
    await page.evaluate(({fixtures,html,notes}) => {
      (window as any).mermaid = {initialize(){}, async render(){return {svg:'<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>'};}};
      (window as any).__editors = {};
      for(const id of ['quote','table','footnote']) (window as any).__editors[id]=(window as any).ListEditingHarness.createEditor({parent:document.getElementById(id)!,text:fixtures[id as keyof typeof fixtures],initialMode:'live',uiLanguage:'en',onApplyChanges(){}});
      document.getElementById('preview')!.innerHTML=html;
      document.getElementById('preview-notes')!.innerHTML=notes;
    },{fixtures,html:preview.html,notes:previewNotes.html});
    await page.waitForSelector('#quote .meo-mermaid-mode-btn');
    await page.evaluate(async()=>{for(let i=0;i<12;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
    const before = await page.evaluate(()=>{
      const block = document.querySelector<HTMLElement>('#quote .meo-rendered-block-preview')!;
      const shell = document.querySelector<HTMLElement>('#table .meo-md-html-table-shell');
      const footnoteTable = document.querySelector<HTMLElement>('#footnote .meo-md-html-table-shell');
      const quoteLines = [...document.querySelectorAll<HTMLElement>('#quote .cm-line')];
      const continuation = quoteLines.find(e=>e.textContent?.includes('Continuation'))!;
      const preview = document.getElementById('preview')!;
      const quoteLine = [...document.querySelectorAll<HTMLElement>('#footnote .cm-line')].find(e=>e.textContent?.includes('Nested quotation'))!;
      const walker = document.createTreeWalker(quoteLine, NodeFilter.SHOW_TEXT);
      let node:Node|null;
      let textLeft=0;
      while((node=walker.nextNode())) {
        if(!node.textContent?.includes('Nested quotation'))continue;
        const range=document.createRange();range.selectNodeContents(node);textLeft=range.getBoundingClientRect().left;break;
      }
      const ruleLeft=footnoteTable!.getBoundingClientRect().left+parseFloat(getComputedStyle(footnoteTable!,'::before').left);
      return {
        diagramHeader:{labelBottom:block.querySelector('.meo-rendered-block-preview-language')!.getBoundingClientRect().bottom,contentTop:block.querySelector('.meo-mermaid-svg-wrapper')!.getBoundingClientRect().top},
        quote:{overflow:getComputedStyle(block).overflowX,rule:getComputedStyle(block,'::before').backgroundImage,indent:block.style.getPropertyValue('--meo-live-block-indent'),bars:block.style.getPropertyValue('--meo-live-block-quote-depth'),x:block.getBoundingClientRect().left,lineX:continuation.getBoundingClientRect().left},
        table:{rendered:!!shell,text:shell?.textContent,refs:shell?.querySelectorAll('.meo-md-footnote-ref').length,alignments:[...document.querySelectorAll<HTMLElement>('#table .meo-md-html-table:not(.meo-md-html-table-sticky-table) th')].map(e=>e.style.textAlign)},
        footnote:{textClearOfRule:textLeft>ruleLeft+3,rendered:!!footnoteTable,indent:footnoteTable?.style.getPropertyValue('--meo-html-table-indent'),bars:footnoteTable?.style.getPropertyValue('--meo-live-block-quote-depth'),refs:document.querySelectorAll('#footnote .meo-md-footnote-ref').length},
        backlinks:[...preview.querySelectorAll<HTMLAnchorElement>('.footnote-backref')].map(a=>({href:a.getAttribute('href'),targetExists:!!document.getElementById(a.hash.slice(1)),label:a.getAttribute('aria-label'),text:a.textContent})),
        notes:{tables:document.querySelectorAll('#preview-notes .footnote-body table').length,graphs:document.querySelectorAll('#preview-notes .footnote-body .meo-export-mermaid').length},
        preview:{numberedTasks:preview.querySelectorAll('.meo-export-task-show-marker').length,quotes:preview.querySelectorAll('blockquote').length,tasks:preview.querySelectorAll('.meo-export-task-checkbox').length,text:preview.textContent}
      };
    });
    const geometry = await page.evaluate(()=>{
      const lines=[...document.querySelectorAll<HTMLElement>('#table .cm-line')];
      const prose=lines.find(e=>e.textContent?.includes('Inner explanation'))!;
      const code=lines.find(e=>e.classList.contains('meo-md-code-line-numbered'))!;
      const shell=document.querySelector<HTMLElement>('#table .meo-md-html-table-shell')!;
      const metric=(e:HTMLElement)=>{
        const r=e.getBoundingClientRect(),s=getComputedStyle(e),p=getComputedStyle(e,'::before'),a=getComputedStyle(e,'::after');
        return {x:r.left,font:s.fontFamily,size:s.fontSize,padding:s.paddingLeft,border:parseFloat(s.borderLeftWidth),before:{left:parseFloat(p.left),width:parseFloat(p.width),content:p.content,bg:p.backgroundImage,positions:p.backgroundPositionX},after:{left:parseFloat(a.left),width:parseFloat(a.width),content:a.content,bg:a.backgroundImage,positions:a.backgroundPositionX},panelLeft:r.left};
      };
      const textLeft=(needle:string)=>{
        const line=lines.find(e=>e.textContent?.includes(needle))!;
        const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
        let node:Node|null;
        while((node=walker.nextNode())) {
          const i=node.textContent?.indexOf(needle)??-1;
          if(i<0)continue;
          const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+needle.length);
          return range.getBoundingClientRect().left;
        }
        throw new Error('Missing text: '+needle);
      };
      const codeWalker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
      let startNode:Node|null;
      while((startNode=codeWalker.nextNode()))if(startNode.textContent?.includes('{'))break;
      if(!startNode)throw new Error('Missing code content');
      const codeRange=document.createRange();codeRange.setStart(startNode,startNode.textContent!.indexOf('{'));codeRange.setEnd(code,code.childNodes.length);
      const rows=new Map<number,number>();
      for(const r of codeRange.getClientRects())if(r.width>0&&r.height>0){const y=Math.round(r.top);rows.set(y,Math.min(rows.get(y)??Infinity,r.left));}
      const wrapLeft=[...rows.values()];
      const header=lines.find(e=>e.classList.contains('meo-md-code-block-start'))!;
      const label=header.querySelector('.meo-code-language-label')!.getBoundingClientRect();
      return {wrapLeft,label:{left:label.left,bottom:label.bottom,headerBottom:header.getBoundingClientRect().bottom},prose:metric(prose),code:metric(code),table:metric(shell),itemLeft:textLeft('Code item'),continuationLeft:textLeft('Code continuation')};
    });
    const cornerPoints = await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>('#table .meo-md-code-block-start')!.getBoundingClientRect();
      const lastElement = document.querySelector<HTMLElement>('#table .meo-md-code-block-end')!;
      const last = lastElement.getBoundingClientRect();
      const left = first.left;
      return [
        {name:'top-left', corner:{x:left+1,y:first.top+1}, surface:{x:left+8,y:first.top+1}},
        {name:'top-right', corner:{x:first.right-2,y:first.top+1}, surface:{x:first.right-9,y:first.top+1}},
        {name:'bottom-left', corner:{x:left+1,y:last.bottom-2}, surface:{x:left+8,y:last.bottom-2}},
        {name:'bottom-right', corner:{x:last.right-2,y:last.bottom-2}, surface:{x:last.right-9,y:last.bottom-2}}
      ];
    });
    const screenshot = await page.screenshot();
    const corners = await page.evaluate(async ({source,points}) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image,0,0);
      const rgb = (p:{x:number;y:number}) => [...context.getImageData(Math.floor(p.x),Math.floor(p.y),1,1).data].slice(0,3);
      return points.map(p=>({name:p.name,corner:rgb(p.corner),surface:rgb(p.surface)}));
    },{source:'data:image/png;base64,'+Buffer.from(screenshot).toString('base64'),points:cornerPoints});
    const editAnchor = fixtures.table.indexOf('"nested": true') + '"nested": true'.length;
    await page.evaluate(anchor => {
      const view = (window as any).__editors.table.view;
      view.dispatch({selection:{anchor}}); view.focus();
    },editAnchor);
    await page.evaluate(async()=>{for(let i=0;i<4;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
    const caret = await page.evaluate(anchor => (window as any).__editors.table.view.coordsAtPos(anchor),editAnchor);
    assert.ok(caret,'quoted code must expose a visible caret');
    await page.mouse.click(caret.left,(caret.top+caret.bottom)/2);
    const clickedAnchor = await page.evaluate(() => (window as any).__editors.table.view.state.selection.main.head);
    assert.equal(clickedAnchor,editAnchor,'moving the panel must preserve pointer-to-source coordinates');
    await page.keyboard.type(' ');
    await page.waitForFunction(source=>(window as any).__editors.table.getText()===source,{timeout:2000},fixtures.table.slice(0,editAnchor)+' '+fixtures.table.slice(editAnchor));
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await page.waitForFunction(source=>(window as any).__editors.table.getText()===source,{timeout:2000},fixtures.table);
    await page.click('#quote .meo-mermaid-mode-btn');
    await page.evaluate(async()=>{for(let i=0;i<4;i++)await new Promise<void>(r=>requestAnimationFrame(()=>r()));});
    const splitSelector='#quote .meo-mermaid-editing-block.is-split .cm-content';
    if(await page.$(splitSelector)) {
      await page.click(splitSelector);
      await page.keyboard.down('Control');
      await page.keyboard.press('End');
      await page.keyboard.up('Control');
      await page.keyboard.type('\nB --> C');
      await page.waitForFunction(()=>(window as any).__editors.quote.getText().includes('>   B --> C'),{timeout:2000});
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await page.waitForFunction(source=>(window as any).__editors.quote.getText()===source,{timeout:2000},fixtures.quote);
    }
    await page.click('#table tbody .meo-md-footnote-ref');
    const after = await page.evaluate(()=>({
      footnoteNavigation:document.querySelector('#table .cm-activeLine')?.textContent?.includes('[^cell]'),
      split:!!document.querySelector('#quote .meo-mermaid-editing-block.is-split'),
      sources:Object.fromEntries(Object.entries((window as any).__editors).map(([id,e]:any)=>[id,e.getText()]))
    }));
    const failures:string[]=[];
    function check(name:string,fn:()=>void){try{fn();console.log('PASS',name);}catch(e){failures.push(name+': '+String(e));}}
    check('Rounded code surfaces follow the nested container at all four corners',()=>{
      for(const point of corners) {
        assert.deepEqual(point.surface,[246,248,250],point.name+' must sample the actual code background');
        // Fractional edges may antialias; a rounded corner must expose the lighter page surface.
        assert.ok(point.corner.reduce((sum,value)=>sum+value,0)>=point.surface.reduce((sum,value)=>sum+value,0)+5,point.name+' remains square: '+JSON.stringify(point.corner));
      }
    });
    check('Repeated footnotes link back to each citation',()=>{
      assert.deepEqual(before.backlinks.map(a=>a.href),['#fnref-1','#fnref-1-2','#fnref-1-3']);
      assert.ok(before.backlinks.every(a=>a.targetExists));
      assert.equal(new Set(before.backlinks.map(a=>a.label)).size,3);
    });
    check('Wrapped quoted code keeps its content column',()=>{
      assert.ok(geometry.wrapLeft.length>=2, 'fixture must actually wrap');
      assert.ok(geometry.wrapLeft.every(left=>Math.abs(left-geometry.wrapLeft[0]!)<=1), 'wrapped code drifts into the gutter: '+JSON.stringify(geometry.wrapLeft));
    });
    check('Block labels stay inside a separate header',()=>{
      assert.ok(geometry.label.left>=geometry.code.panelLeft+8, 'code label must remain inside the panel padding');
      assert.ok(geometry.label.bottom<=geometry.label.headerBottom-3, 'code label must clear the first source line');
      assert.ok(before.diagramHeader.contentTop>=before.diagramHeader.labelBottom+4, 'diagram label must clear its rendered content');
    });
    check('Nested code and table keep quote rails aligned',()=>{
      const prosePositions=geometry.prose.before.positions.split(',').map(Number.parseFloat);
      const innerProse=geometry.prose.x+geometry.prose.border+geometry.prose.before.left+(prosePositions[1]??0);
      const positions=geometry.table.before.positions.split(',').map(Number.parseFloat);
      const innerTable=geometry.table.x+geometry.table.before.left+(positions[1]??0);
      assert.ok(Math.abs(innerTable-innerProse)<=1, 'inner quote rail drifts at table: '+JSON.stringify({innerProse,innerTable}));
      const codePositions=geometry.code.before.positions.split(',').map(Number.parseFloat);
      const innerCode=geometry.code.x+geometry.code.before.left+(codePositions[1]??0);
      assert.ok(Math.abs(innerCode-innerProse)<=1, 'inner quote rail drifts when code font changes');
      assert.ok(geometry.code.panelLeft>innerCode+6, 'code background must begin inside the quote rails');
      assert.ok(geometry.code.x+geometry.code.after.left>geometry.code.panelLeft, 'line number must stay inside the code panel');
      assert.ok(geometry.wrapLeft[0]!>=geometry.code.x+geometry.code.after.left+geometry.code.after.width+8, 'code content must clear the line number gutter');
      assert.ok(Math.abs(geometry.itemLeft-geometry.continuationLeft)<=1, 'list continuation should align with the item body: '+JSON.stringify({item:geometry.itemLeft,continuation:geometry.continuationLeft,table:geometry.table.x,code:geometry.code.panelLeft}));
      assert.ok(Math.abs(geometry.continuationLeft-geometry.table.x)<=1, 'nested table should align with the list continuation');
      assert.ok(Math.abs(geometry.continuationLeft-geometry.code.panelLeft)<=1, 'nested code should align with the list continuation');
      assert.ok(!(geometry.code.after.content==='"1"'&&geometry.code.after.bg!=='none'), 'code line number and quote rails share the same painted layer');
    });
    check('Quoted diagram retains container',()=>{assert.ok(before.quote.indent);assert.equal(before.quote.bars,'1');assert.ok(before.quote.x>before.quote.lineX);assert.equal(before.quote.overflow,'visible');assert.notEqual(before.quote.rule,'none');});
    check('Quoted diagram editing opens and preserves source',()=>{assert.ok(after.split);assert.equal(after.sources.quote,fixtures.quote);});
    check('Double quote/list table renders with source alignment',()=>{assert.ok(before.table.rendered);assert.ok(before.table.text?.includes('nested cell'));assert.deepEqual(before.table.alignments,['left','right']);assert.equal(before.table.refs,1);assert.ok(after.footnoteNavigation);assert.equal(after.sources.table,fixtures.table);});
    check('Footnote blocks retain both definition and quote indentation',()=>{assert.ok(before.footnote.rendered);assert.equal(before.footnote.refs,1);assert.ok(before.footnote.indent?.includes('calc'));assert.equal(before.footnote.bars,'1');assert.ok(before.footnote.textClearOfRule);assert.equal(after.sources.footnote,fixtures.footnote);});
    check('Preview table cells retain quote/task composites',()=>{assert.equal(before.preview.quotes,2);assert.equal(before.preview.tasks,3);assert.equal(before.preview.numberedTasks,1);assert.ok(!before.preview.text?.includes('[ ]'));});
    check('Preview preserves blocks inside footnote definitions',()=>{assert.equal(before.notes.tables,1);assert.equal(before.notes.graphs,1);});
    if(failures.length)throw new Error(failures.join('\n'));
    await verifyFootnoteParagraphLayouts(browser,path.join(temp,'bundle.js'));
    await verifyPreviewTaskContainerLayouts(browser);
    await verifyListContainerLayouts(browser,path.join(temp,'bundle.js'));
    await verifyCodeContainerLayouts(browser,path.join(temp,'bundle.js'));
    console.log('Composite block checks passed');
  } finally {await closeTestBrowser(browser);}
}
main().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1;});
