import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { getBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

const root = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-composite-lists-'));
const source = [
  '- [ ] plain task',
  '> - [ ] quoted task alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
  '> 1. first quoted ordered',
  '> 99. second quoted ordered',
  '> > - [x] nested quoted task',
  '- parent',
  '  > - [ ] task in quote in list',
  '- > quote in list',
  '  - nested **bold** item',
  '- > - [ ] same-line nested task',
  '> - > 1. same-line quoted ordered'
].join('\n');

async function assertContainerBodyHits(page: import('puppeteer-core').Page): Promise<void> {
  const complex = fs.readFileSync(path.join(root, 'scripts/fixtures/github-readme/complex/README.md'), 'utf8').replace(/\r\n?/g, '\n');
  const fixtures = [
    ...[' > > - [ ] ', '  > > - [x] ', ' > > - ', ' > > 1. ', '> - > - [ ] ',
      '> 1. > - [ ] ', '- > > - [x] ', '- [ ] ', '> > - [ ] ', ' > > ']
      .map(prefix => ({ text: prefix + '正文测试', targets: ['正文测试'] })),
    { text: ' > > - [ ] **正文测试**', targets: ['正文测试'] },
    { text: ' > > - [ ] 正文测试 ' + 'wrapped content '.repeat(14) + '末行正文', targets: ['正文测试', '末行正文'], wrapped: true },
    { text: complex.slice(complex.indexOf('## S02'), complex.indexOf('## S03')), targets: ['内层待办', '内层已完成项'], input: true },
    { text: '  > > - [ ] 正文测试', targets: ['正文测试'], mode: 'source' }
  ];
  await page.setViewport({ width: 1000, height: 800 });
  await page.setContent('<!doctype html><style>body{margin:0}#body-hits{height:720px}</style><div id="body-hits"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  // This page gets the same production bundle as the existing layout checks.
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  let clicks = 0;
  for (const large of [false, true]) for (const [index, fixture] of fixtures.entries()) {
    const text = fixture.text + '\n\nAFTER' + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const label = `${large ? 'optimized' : 'ordinary'}/${fixture.mode ?? 'live'}/${index}`;
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, label + '/size policy');
    const optimized = await page.evaluate(async ({ text, mode, width, font, appearance }) => {
      const harness = (window as any).ListEditingHarness;
      harness.applyBuiltInVisualBaseline(appearance);
      document.documentElement.dataset.editorAppearance = appearance;
      const host = document.getElementById('body-hits')!; host.style.width = width + 'px';
      const editor = harness.createEditor({ parent: host, text, initialMode: mode, onApplyChanges() {} });
      editor.view.dom.style.setProperty('--meo-user-editor-font-size', font + 'px');
      (window as any).__bodyHitEditor = editor; editor.view.focus();
      for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return harness.usesLargeDocumentDerivedWorkBudget(editor.view.state);
    }, { text, mode: fixture.mode ?? 'live', width: fixture.wrapped ? 340 : 950,
      font: fixture.input ? 30 : index % 3 ? 16 : 24, appearance: index % 2 ? 'light' : 'dark' });
    assert.equal(optimized, large, label + '/actual derived-work budget');
    const pointAt = (target: string, offset: number, fraction: number, reset = true) => page.evaluate(async ({ target, offset, fraction, reset }) => {
      const editor = (window as any).__bodyHitEditor, view = editor.view;
      if (reset) {
        view.dispatch({ selection: { anchor: 0 } });
        for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start + offset); range.setEnd(node, start + offset + 1);
        const rect = range.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width * fraction), y = Math.floor((rect.top + rect.bottom) / 2);
        return { x, y, expected: editor.getText().indexOf(target) + offset + (fraction > 0.5 ? 1 : 0),
          mapped: view.posAtCoords({ x, y }) };
      }
      throw Error('Missing body text: ' + target);
    }, { target, offset, fraction, reset });
    const selection = () => page.evaluate(() => {
      const view = (window as any).__bodyHitEditor.view, range = view.state.selection.main, native = getSelection();
      return { anchor: range.anchor, head: range.head, empty: range.empty,
        nativeHead: native?.focusNode ? view.posAtDOM(native.focusNode, native.focusOffset) : null };
    });
    try {
      if (fixture.wrapped) {
        const first = await pointAt(fixture.targets[0], 0, 0.2);
        const last = await pointAt(fixture.targets[1], 0, 0.2);
        assert.ok(last.y > first.y + 1, label + '/body actually wraps');
      }
      for (const target of fixture.targets) for (const offset of [0, Math.floor(target.length / 2), target.length - 1]) for (const fraction of [0.2, 0.8]) {
        const point = await pointAt(target, offset, fraction);
        await page.mouse.move(point.x, point.y); await page.mouse.down();
        try {
          const held = await selection();
          assert.equal(held.head, point.expected, label + '/' + target + '/pressed body character');
          assert.equal(held.nativeHead, point.expected, label + '/' + target + '/native body character');
          assert.equal(point.mapped, point.expected, label + '/coordinate mapping');
        } finally { await page.mouse.up(); }
        assert.equal((await selection()).head, point.expected, label + '/release retains the clicked character');
        clicks++;
      }
      assert.equal(await page.evaluate(() => (window as any).__bodyHitEditor.getText()), text, label + '/unchanged source');
      if (fixture.input) {
        const start = await pointAt(fixture.targets[0], 0, 0.2);
        const end = await pointAt(fixture.targets[0], fixture.targets[0].length - 1, 0.8, false);
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 5 });
        const dragged = await selection();
        await page.mouse.up();
        assert.equal(dragged.anchor, start.expected, label + '/drag anchor');
        assert.equal(dragged.head, end.expected, label + '/drag head');
        assert.equal(dragged.empty, false, label + '/drag selects body');
        assert.deepEqual(await selection(), dragged, label + '/released drag');
        const caret = await pointAt(fixture.targets[0], 2, 0.2);
        await page.mouse.click(caret.x, caret.y); await page.keyboard.type('Z');
        const typed = text.slice(0, caret.expected) + 'Z' + text.slice(caret.expected);
        assert.equal(await page.evaluate(() => (window as any).__bodyHitEditor.getText()), typed, label + '/native input');
        for (const operation of ['undo', 'redo', 'undo'] as const) {
          const result = await page.evaluate(async operation => {
            const editor = (window as any).__bodyHitEditor; await editor[operation]();
            return { text: editor.getText(), head: editor.view.state.selection.main.head };
          }, operation);
          assert.equal(result.text, operation === 'redo' ? typed : text, label + '/' + operation);
          assert.equal(result.head, caret.expected + (operation === 'redo' ? 1 : 0), label + '/' + operation + '/caret');
        }
        await page.click('#body-hits .meo-task-checkbox');
        assert.equal(await page.evaluate(() => (window as any).__bodyHitEditor.getText()), text.replace('[ ]', '[x]'), label + '/checkbox click');
      }
      if (process.env.MEO_TEST_SCREENSHOTS && fixture.input && !large) {
        fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'nested-quote-task-body.png') });
      }
    } finally { await page.evaluate(() => (window as any).__bodyHitEditor.destroy()); }
  }
  console.log(`container body hit tests passed: ${clicks} glyph clicks, task/bullet/ordered/quoted/wrapped bodies, ordinary/optimized, native input/history, dragging and checkbox controls`);
}

async function assertTwoStateTasks(page: import('puppeteer-core').Page): Promise<void> {
  const taskSource = [
    '- [ ] Pending', '- [x] Completed', '- [X] Uppercase',
    '- [~] Progress', '- [-] Dropped', '> - [~] Quoted',
    '1. [-] Ordered', '- parent', '  - [~] Nested', '',
    '- [/] Slash', '- [!] Unsupported', '- [?] Question', '- [word] Label', '',
    'Plain [label] (round) {curly} tail',
    'Missing [label][ref] and ![alt] tail', '',
    'Valid [inline](https://example.com) [Known][target] [defined] tail',
    'Formatting **Bold [~] words** and `const [x] = [1]` tail', '',
    '## Heading [-] headingwords', '',
    '[target]: https://example.com/reference', '[defined]: https://example.com/defined', '',
    '| Tasks |', '| --- |',
    '| - [ ] Cell pending<br>- [x] Cell done<br>- [X] Cell upper<br>- [~] Cell progress<br>- [-] Cell dropped |',
    '', 'After'
  ].join('\n');
  await page.setViewport({ width: 1000, height: 1000 });
  for (const large of [false, true]) {
    const text = taskSource + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    for (const appearance of ['light', 'dark']) {
      const label = `${appearance}/${large ? 'optimized' : 'ordinary'}`;
      await page.setContent('<!doctype html><style>html,body,#tasks{height:100%;margin:0}</style><div id="tasks"></div>');
      await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
      await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      const budget = await page.evaluate(({ text, appearance, caret }) => {
        document.documentElement.dataset.editorAppearance = appearance;
        const harness = (window as any).ListEditingHarness;
        harness.applyBuiltInVisualBaseline(appearance);
        document.documentElement.style.setProperty('--meo-token-link-color', '#0088ee');
        const editor = harness.createEditor({
          parent: document.getElementById('tasks')!, text, initialMode: 'live',
          uiLanguage: appearance === 'light' ? 'zh-CN' : 'en', onApplyChanges() {}
        });
        (window as any).__taskStateEditor = editor;
        editor.view.dispatch({ selection: { anchor: caret } });
        return harness.usesLargeDocumentDerivedWorkBudget(editor.view.state);
      }, { text, appearance, caret: taskSource.length });
      assert.equal(budget, large, `${label}: production derived-work budget`);
      const waitForTasks = () => page.waitForFunction(() => {
        const host = document.getElementById('tasks')!;
        return host.querySelectorAll('.meo-task-checkbox:not(:disabled)').length === 3
          && host.querySelectorAll('.meo-task-checkbox:disabled').length === 3;
      });
      await waitForTasks();
      const rendered = await page.evaluate(() => {
        (window as any).__taskColorSnapshot = () => {
          const host = document.getElementById('tasks')!;
          const editor = (window as any).__taskStateEditor;
          const colorAt = (at: number) => {
            const node = editor.view.domAtPos(at, 1).node as Node;
            const element = node instanceof HTMLElement ? node : node.parentElement!;
            return { color: getComputedStyle(element).color, html: element.outerHTML };
          };
          const source = editor.getText() as string;
          const literals = ['[~] Progress', '[-] Dropped', '[~] Quoted', '[-] Ordered', '[~] Nested',
            '[/] Slash', '[!] Unsupported', '[?] Question', '[word] Label',
            '[label] (round) {curly} tail', '[label][ref] and ![alt] tail', '[~] words', '[-] headingwords'];
          return {
            text: source, visible: host.textContent,
            literalColors: literals.map(literal => {
              const from = source.indexOf(literal), end = literal.lastIndexOf(' ');
              return { literal, body: colorAt(from + literal.length - 1).color,
                symbols: Array.from(literal.slice(0, end), (char, offset) => ({ char, ...colorAt(from + offset) })) };
            }),
            links: ['inline]', 'Known]', 'defined]'].map(text => colorAt(source.indexOf(text)).color),
            body: colorAt(source.indexOf('Plain ')).color,
            inlineHref: host.querySelector('.meo-md-link')?.getAttribute('data-meo-link-href'),
            codeLiterals: host.querySelectorAll('.meo-md-inline-code .meo-md-literal-link').length,
            checked: Array.from(host.querySelectorAll<HTMLInputElement>('.meo-task-checkbox'), box => box.checked),
            retiredStates: host.querySelectorAll('.is-inprogress, .is-dropped, .meo-task-dropped').length
          };
        };
        return (window as any).__taskColorSnapshot();
      });
      assert.equal(rendered.text, text, `${label}: rendering preserves source`);
      assert.deepEqual(rendered.checked, [false, true, true, false, true, true], label);
      assert.equal(rendered.retiredStates, 0, label);
      const assertLiteralColors = (sample: typeof rendered) => {
        for (const item of sample.literalColors) {
          for (const symbol of item.symbols) {
            assert.equal(symbol.color, item.body, `${label}: ${item.literal} ${JSON.stringify(symbol)}`);
          }
        }
        for (const color of sample.links) assert.notEqual(color, sample.body, `${label}: valid links retain their palette`);
        assert.equal(sample.inlineHref, 'https://example.com', `${label}: valid link target`);
        assert.equal(sample.codeLiterals, 0, `${label}: inline code is not prose`);
      };
      assertLiteralColors(rendered);
      for (const literal of ['[~] Progress', '[-] Dropped', '[~] Quoted', '[-] Ordered', '[~] Nested', '[~] Cell progress', '[-] Cell dropped']) {
        assert.ok(rendered.visible?.includes(literal), `${label}: visible literal ${literal}`);
      }
      if (process.env.MEO_TEST_SCREENSHOTS) {
        fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `task-states-${appearance}-${large ? 'optimized' : 'ordinary'}.png`) });
      }
      await page.evaluate(() => (window as any).__taskStateEditor.setMode('source'));
      await page.waitForSelector('#tasks .meo-mode-source');
      const nativeSourcePalette = await page.evaluate(() => (window as any).__taskColorSnapshot().literalColors
        .map((item: any) => [item.body, ...item.symbols.map((symbol: any) => symbol.color)]));
      await page.evaluate(() => (window as any).__taskStateEditor.setMode('live'));
      await waitForTasks();
      await page.evaluate(caret => (window as any).__taskStateEditor.view.dispatch({ selection: { anchor: caret } }), text.indexOf('[~] Progress') + 1);
      assertLiteralColors(await page.evaluate(() => (window as any).__taskColorSnapshot()));
      await page.evaluate(caret => (window as any).__taskStateEditor.view.dispatch({ selection: { anchor: caret } }), taskSource.length);
      await page.click('#tasks .meo-task-checkbox:not(:disabled)');
      const checkedText = text.replace('- [ ] Pending', '- [x] Pending');
      await page.waitForFunction(expected => (window as any).__taskStateEditor.getText() === expected, {}, checkedText);
      assert.equal(await page.evaluate(async () => {
        const editor = (window as any).__taskStateEditor;
        await editor.undo();
        return editor.getText();
      }), text, `${label}: undo preserves literal markers`);
      assert.equal(await page.evaluate(async () => {
        const editor = (window as any).__taskStateEditor;
        await editor.redo();
        return editor.getText();
      }), checkedText, `${label}: redo`);
      await page.evaluate(() => (window as any).__taskStateEditor.setMode('source'));
      await page.waitForSelector('#tasks .meo-mode-source');
      assert.equal(await page.evaluate(() => (window as any).__taskStateEditor.getText()), checkedText, `${label}: Source preserves source`);
      const sourcePalette = await page.evaluate(() => (window as any).__taskColorSnapshot().literalColors
        .map((item: any) => [item.body, ...item.symbols.map((symbol: any) => symbol.color)]));
      assert.deepEqual(sourcePalette, nativeSourcePalette, `${label}: Source retains its native syntax palette`);
      // History can restore a caret inside the marker, where Live intentionally reveals source.
      await page.evaluate(caret => (window as any).__taskStateEditor.view.dispatch({ selection: { anchor: caret } }), taskSource.length);
      await page.evaluate(() => (window as any).__taskStateEditor.setMode('live'));
      await waitForTasks();
      assertLiteralColors(await page.evaluate(() => (window as any).__taskColorSnapshot()));
      await page.click('#tasks .meo-task-checkbox:not(:disabled)');
      await page.waitForFunction(expected => (window as any).__taskStateEditor.getText() === expected, {}, text);
      await page.evaluate(() => (window as any).__taskStateEditor.destroy());
    }
  }
  console.log('two-state tasks: ordinary/optimized, light/dark, literal markers, table cells, click, history and mode roundtrip passed');
}

async function assertTaskMarkerEditing(page: import('puppeteer-core').Page): Promise<void> {
  await page.setContent('<div id="task-editing"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  for (const large of [false, true]) for (const prefix of ['- ', '-  ', '-\t', '  - ', '1. ', '> - ']) {
    const result = await page.evaluate(async ({ prefix, large }) => {
      const source = prefix + '[ ] parent\n  - [ ] child\n\nafter' + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
      const host = document.getElementById('task-editing')!;
      const editor = (window as any).ListEditingHarness.createEditor({ parent: host, text: source, initialMode: 'live', onApplyChanges() {} });
      const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); };
      editor.view.dispatch({ selection: { anchor: source.indexOf('after') } }); await settle();
      const boxes = () => host.querySelectorAll<HTMLInputElement>('.meo-task-checkbox');
      const before = boxes().length; boxes()[0]?.click(); await settle();
      const checked = editor.getText(); await editor.undo(); await settle();
      const undone = editor.getText();
      const body = source.indexOf('parent') + 6;
      // Establish the body caret before typing, as a real pointer/arrow move does.
      editor.view.dispatch({ selection: { anchor: body } }); await settle();
      editor.view.dispatch({ changes: { from: body, insert: ' edited' }, selection: { anchor: body + 7 }, userEvent: 'input.type' });
      const typingFrames: number[] = [];
      for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); typingFrames.push(boxes().length); }
      await editor.undo(); await settle();
      editor.view.dispatch({ selection: { anchor: source.indexOf('parent'), head: source.indexOf('child') + 5 } }); await settle();
      const selected = boxes().length;
      editor.view.dispatch({ selection: { anchor: source.indexOf('[ ]') + 1 } }); await settle();
      const editing = boxes().length;
      editor.view.dispatch({ selection: { anchor: source.indexOf('after') } }); await settle();
      const restored = boxes().length;
      editor.setMode('source'); await settle(); editor.setMode('live'); await settle();
      const roundtrip = boxes().length; editor.destroy();
      return { source, before, checked, undone, editing, typingFrames, selected, restored, roundtrip };
    }, { prefix, large });
    assert.equal(result.before, 2, `${JSON.stringify(prefix)} initial task controls`);
    assert.equal(result.checked, result.source.replace('[ ]', '[x]'), `${JSON.stringify(prefix)} checkbox must change only the task marker`);
    assert.equal(result.undone, result.source);
    assert.equal(result.editing, 1, 'Only the task whose source marker is being edited is revealed');
    assert(result.typingFrames.every(count => count === 2), `Typing must retain parent and nested controls: ${JSON.stringify({ prefix, large, frames: result.typingFrames })}`);
    assert.deepEqual([result.selected, result.restored, result.roundtrip], [2, 2, 2], 'Selection and mode changes must restore parent and nested task controls');
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    if (process.argv.includes('--body-hit-only')) {
      await assertContainerBodyHits(await browser.newPage());
      return;
    }
    if (process.argv.includes('--tasks-only')) {
      await assertTaskMarkerEditing(await browser.newPage());
      await assertTwoStateTasks(await browser.newPage());
      return;
    }
    await assertTaskMarkerEditing(await browser.newPage());
    await assertContainerBodyHits(await browser.newPage());
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="host"></div><div id="order-host"></div><div id="table-host"></div><div id="nested-table-host"></div><div id="edit-host"></div>');
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    // VS Code's host quote background can differ from the editor appearance.
    await page.addStyleTag({ content: 'blockquote { background: #1c2128; }' });
    const { alertNoteBorder } = getBuiltInVisuals('dark').semanticColors;
    await page.addStyleTag({ content: `:root {
      --meo-semantic-blockquoteBorder: #777;
      --meo-semantic-blockquoteForeground: #444;
      --meo-semantic-alertNoteBorder: ${alertNoteBorder};
    }` });
    await page.addStyleTag({ content: '#host { width: 280px; } #host .cm-editor { width: 280px; } #host .cm-gutters { display: none; }' });
    await page.addStyleTag({ content: '#order-host { width: 280px; } #order-host .cm-editor { width: 280px; } #order-host .cm-gutters { display: none; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(async (markdown) => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('host')!,
        text: markdown,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line'));
      const items = lines.map((line) => ({
        text: line.innerText,
        checkbox: line.querySelectorAll('.meo-task-checkbox').length,
        listMarker: line.querySelectorAll('.meo-md-list-marker').length,
        quote: line.classList.contains('meo-md-quote'),
        list: line.classList.contains('meo-md-list-line')
      }));
      const quotedBody = Array.from(lines[1]!.childNodes).find((node) => node.textContent?.includes('quoted task'))!;
      const textNode = quotedBody.nodeType === Node.TEXT_NODE ? quotedBody : quotedBody.firstChild!;
      const bodyRange = document.createRange();
      bodyRange.setStart(textNode, textNode.textContent!.indexOf('quoted task'));
      bodyRange.setEnd(textNode, textNode.textContent!.length);
      const bodyRects = Array.from(bodyRange.getClientRects()).filter((rect) => rect.width > 1);
      const quotedAlignment = {
        count: bodyRects.length,
        first: bodyRects[0]?.left ?? NaN,
        continuation: bodyRects[1]?.left ?? NaN
      };
      const checkbox = lines[1]!.querySelector<HTMLInputElement>('.meo-task-checkbox');
      checkbox?.click();
      const afterToggle = editor.getText();
      await editor.undo();
      const afterUndo = editor.getText();
      editor.destroy();
      const tableSource = [
        '| Content |',
        '| --- |',
        '| - [ ] plain<br>> - [x] quoted task<br>> 3. ordered<br>> 9. next<br>- **bold** item<br>- > - [ ] same-line task<br>- parent<br>  > - [x] task in list quote<br>> > 2) deeper ordered |'
      ].join('\n');
      const tableEditor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!, text: tableSource,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const cell = document.querySelector<HTMLElement>(
        '#table-host tbody td .meo-md-html-table-cell-preview'
      )!;
      const originalAppearance = document.documentElement.dataset.editorAppearance;
      const quoteBackgrounds = Object.fromEntries(['light', 'dark'].map(appearance => {
        document.documentElement.dataset.editorAppearance = appearance;
        return [appearance, Array.from(cell.querySelectorAll('blockquote'), quote => getComputedStyle(quote).backgroundColor)];
      }));
      if (originalAppearance === undefined) delete document.documentElement.dataset.editorAppearance;
      else document.documentElement.dataset.editorAppearance = originalAppearance;
      const table = {
        listItems: cell.querySelectorAll('li').length,
        quotes: cell.querySelectorAll('blockquote').length,
        checkboxes: cell.querySelectorAll('input[type=checkbox]').length,
        quoteBorder: Number.parseFloat(getComputedStyle(cell.querySelector('blockquote')!).borderLeftWidth),
        quoteBackgrounds,
        checkboxDisplay: getComputedStyle(cell.querySelector('input[type=checkbox]')!).display,
        text: cell.innerText,
        source: tableEditor.getText()
      };
      tableEditor.destroy();
      const nestedTableSource = [
        '- containing table', '',
        '  | Name | Value |', '  | --- | --- |', '  | visible nested cell | yes |'
      ].join('\n');
      const nestedTableEditor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('nested-table-host')!, text: nestedTableSource,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nestedTable = {
        cells: document.querySelectorAll('#nested-table-host .meo-md-html-table-cell-preview').length,
        text: document.getElementById('nested-table-host')!.innerText,
        source: nestedTableEditor.getText()
      };
      nestedTableEditor.destroy();
      return { items, quotedAlignment, afterToggle, afterUndo, table, tableSource, nestedTable, nestedTableSource };
    }, source);

    assert.equal(result.items.length, 11);
    assert.equal(result.items[0]?.checkbox, 1);
    assert.equal(result.items[1]?.checkbox, 1, 'quoted task must render an interactive checkbox');
    assert.equal(result.items[2]?.listMarker, 1, 'quoted ordered item must render its number');
    assert.equal(result.items[3]?.listMarker, 1, 'the next quoted ordered item must render its number');
    assert.equal(result.items[4]?.checkbox, 1, 'nested quoted task must render a checkbox');
    assert.equal(result.items[6]?.checkbox, 1, 'task inside a quote inside a list must render a checkbox');
    assert.ok(result.items[7]?.quote && result.items[7]?.list, 'list item containing a quote needs both styles');
    assert.equal(result.items[8]?.listMarker, 1);
    assert.equal(result.items[9]?.checkbox, 1, 'same-line list and quote nesting must show its task');
    assert.equal(result.items[10]?.listMarker, 2, 'same-line nested lists must show both markers');
    for (const [index, expected] of [
      'plain task', 'quoted task', 'first quoted ordered', 'second quoted ordered',
      'nested quoted task', 'parent', 'task in quote in list', 'quote in list', 'nested bold item',
      'same-line nested task', 'same-line quoted ordered'
    ].entries()) {
      assert.ok(result.items[index]?.text.includes(expected), `line ${index + 1} lost its content`);
    }
    assert.ok(result.quotedAlignment.count >= 2, 'quoted task must wrap in the narrow editor');
    assert.ok(Math.abs(result.quotedAlignment.first - result.quotedAlignment.continuation) <= 1,
      `quoted list continuation is misaligned: ${JSON.stringify(result.quotedAlignment)}`);
    assert.equal(result.afterToggle, source.replace('> - [ ] quoted task', '> - [x] quoted task'));
    assert.equal(result.afterUndo, source);
    assert.equal(result.table.listItems, 10, 'table cell must retain every nested list item');
    assert.equal(result.table.quotes, 5, 'table cell must display each quote container');
    for (const [appearance, backgrounds] of Object.entries(result.table.quoteBackgrounds)) {
      assert.ok(backgrounds.every(background => background === 'rgba(0, 0, 0, 0)'),
        `${appearance}: table-cell quotes must retain the cell background instead of the Host quote background: ${JSON.stringify(backgrounds)}`);
    }
    assert.equal(result.table.checkboxes, 4, 'table cell must display task markers as checkboxes');
    assert.ok(result.table.quoteBorder > 0 && result.table.checkboxDisplay !== 'none',
      'table-cell quote and task styles must be visible');
    assert.ok(result.table.text.includes('quoted task') && result.table.text.includes('bold item'));
    assert.ok(result.table.text.indexOf('plain') < result.table.text.indexOf('quoted task')
      && result.table.text.indexOf('quoted task') < result.table.text.indexOf('bold item')
      && result.table.text.indexOf('bold item') < result.table.text.indexOf('task in list quote'),
    'table-cell containers must keep source order');
    assert.equal(result.table.source, result.tableSource);
    assert.ok(result.nestedTable.cells >= 2 && result.nestedTable.text.includes('visible nested cell'));
    assert.equal(result.nestedTable.source, result.nestedTableSource);

    const sameLine = await page.evaluate(async () => {
      const source = [
        '- 1. bullet then ordered',
        '1. - ordered then bullet',
        '- 1. - three list markers',
        '- 1. [ ] task after two lists',
        '> - 1. quote then two lists',
        '- > 1. list quote ordered',
        '1. > - [x] ordered quote task',
        '- 1. - 2. [ ] five markers',
        '- [ ] 1. task first keeps ordered text',
        '> > - two quote levels',
        '> > nested quote paragraph',
        '- 1. [ ] composite task alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
        '> > > three quote levels',
        '1. - [x] ordered then task'
      ].join('\n');
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const items = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line')).map((line) => ({
        text: line.innerText,
        markers: line.querySelectorAll('.meo-md-list-marker').length,
        checkboxes: line.querySelectorAll('.meo-task-checkbox').length,
        quoteDepthIndicator: String(getComputedStyle(line, '::before').backgroundPositionX.split(',').length),
        markerRects: Array.from(line.querySelectorAll<HTMLElement>('.meo-md-list-marker, .meo-task-checkbox'))
          .map((marker) => ({ left: marker.getBoundingClientRect().left, right: marker.getBoundingClientRect().right }))
      }));
      const wrappedLine = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line'))
        .find((line) => line.textContent?.includes('composite task alpha'))!;
      const textNode = Array.from(wrappedLine.childNodes)
        .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('composite task alpha'))!;
      const bodyRange = document.createRange();
      bodyRange.setStart(textNode, textNode.textContent!.indexOf('composite task alpha'));
      bodyRange.setEnd(textNode, textNode.textContent!.length);
      const bodyRects = Array.from(bodyRange.getClientRects()).filter((rect) => rect.width > 1);
      const wrappedAlignment = {
        count: bodyRects.length,
        first: bodyRects[0]?.left ?? NaN,
        continuation: bodyRects[1]?.left ?? NaN
      };
      editor.destroy();
      return { items, wrappedAlignment };
    });
    assert.deepEqual(sameLine.items.map((line) => line.markers), [2, 2, 3, 2, 2, 2, 1, 4, 0, 1, 0, 2, 0, 1],
      `only non-task list items should display list markers: ${JSON.stringify(sameLine)}`);
    assert.equal(sameLine.items[3]?.checkboxes, 1);
    assert.equal(sameLine.items[6]?.checkboxes, 1);
    assert.equal(sameLine.items[7]?.checkboxes, 1);
    assert.equal(sameLine.items[8]?.checkboxes, 1);
    assert.equal(sameLine.items[11]?.checkboxes, 1);
    assert.equal(sameLine.items[13]?.checkboxes, 1);
    assert.ok(Number.parseFloat(sameLine.items[9]?.quoteDepthIndicator ?? '') > 0
      && Number.parseFloat(sameLine.items[10]?.quoteDepthIndicator ?? '') > 0,
      'the second quote level needs a visible depth indicator');
    assert.ok(Number.parseFloat(sameLine.items[12]?.quoteDepthIndicator ?? '')
      > Number.parseFloat(sameLine.items[10]?.quoteDepthIndicator ?? ''),
    'the third quote level needs an additional visible depth indicator');
    assert.ok(sameLine.wrappedAlignment.count >= 2
      && Math.abs(sameLine.wrappedAlignment.first - sameLine.wrappedAlignment.continuation) <= 1,
    `same-line task continuation is misaligned: ${JSON.stringify(sameLine.wrappedAlignment)}`);
    for (const line of sameLine.items) {
      for (let index = 1; index < line.markerRects.length; index += 1) {
        assert.ok(line.markerRects[index].left >= line.markerRects[index - 1].right - 1,
          `same-line markers overlap: ${JSON.stringify(line)}`);
      }
    }
    for (const text of [
      'bullet then ordered', 'ordered then bullet', 'three list markers', 'task after two lists',
      'quote then two lists', 'list quote ordered', 'ordered quote task', 'five markers',
      '1. task first keeps ordered text', 'two quote levels', 'nested quote paragraph',
      'composite task alpha', 'three quote levels'
    ]) {
      assert.ok(sameLine.items.some((line) => line.text.includes(text)), `same-line content lost: ${text}`);
    }

    const quoteOrder = await page.evaluate(async () => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('order-host')!,
        text: ['1. > - [ ] ordered quote task', '', '> 1. - [ ] quote ordered task', '',
          '- > 1. - [ ] bullet quote ordered task', '', '1. > > - [ ] nested quote task', '',
          '> 1. > - [ ] interleaved quote task', '', '1. > quote starts', '   > quote continues', '',
          '1. > [!NOTE] alert quote', '',
          '1. > - [ ] wrapped quote task alpha beta gamma delta epsilon zeta eta theta'].join('\n'),
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#order-host .cm-line'))
        .filter((line) => line.innerText.includes('task'))
        .map((line) => {
          const rect = line.getBoundingClientRect();
          const before = getComputedStyle(line, '::before');
          const markers = Array.from(line.querySelectorAll<HTMLElement>('.meo-md-list-marker, .meo-task-checkbox'))
            .map((marker) => ({ left: marker.getBoundingClientRect().left, right: marker.getBoundingClientRect().right }));
          const quoteLeft = line.classList.contains('meo-md-quote-source-order')
            ? rect.left + Number.parseFloat(before.left)
            : rect.left;
          return {
            text: line.innerText, quoteLeft, markers,
            quoteBarPositions: before.backgroundPositionX.split(',').map((position) => Number.parseFloat(position)),
            checkboxes: line.querySelectorAll('.meo-task-checkbox').length
          };
        });
      const continuations = Array.from(document.querySelectorAll<HTMLElement>('#order-host .cm-line'))
        .filter((line) => line.innerText.includes('quote starts') || line.innerText.includes('quote continues'))
        .map((line) => ({
          text: line.innerText,
          quoteLeft: line.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(line, '::before').left),
          sourced: line.classList.contains('meo-md-quote-source-order')
        }));
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(9).from + 4 } });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const activeLine = Array.from(document.querySelectorAll<HTMLElement>('#order-host .cm-line'))
        .find((line) => line.innerText.includes('interleaved quote task'))!;
      const sourceLine = editor.view.state.doc.line(9);
      const orderedFrom = editor.view.coordsAtPos(sourceLine.from + 2)!;
      const orderedTo = editor.view.coordsAtPos(sourceLine.from + 4)!;
      const activeOrderedMarker = { text: sourceLine.text.slice(2, 4), left: orderedFrom.left, right: orderedTo.left };
      const activeBefore = getComputedStyle(activeLine, '::before');
      const activeQuoteLeft = activeLine.getBoundingClientRect().left + Number.parseFloat(activeBefore.left);
      const activeQuoteBarPositions = activeBefore.backgroundPositionX.split(',')
        .map((position) => Number.parseFloat(position));
      const activeMarkerRects = Array.from(activeLine.querySelectorAll<HTMLElement>('.meo-md-list-marker, .meo-task-checkbox'))
        .map((marker) => ({ left: marker.getBoundingClientRect().left, right: marker.getBoundingClientRect().right }));
      const alertLine = Array.from(document.querySelectorAll<HTMLElement>('#order-host .cm-line'))
        .find((line) => line.innerText.includes('alert quote'))!;
      const alertMarker = alertLine.querySelector<HTMLElement>('.meo-md-list-marker')!;
      const alert = {
        className: alertLine.className,
        quoteLeft: alertLine.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(alertLine, '::before').left),
        markerRight: alertMarker.getBoundingClientRect().right,
        borderLeftWidth: getComputedStyle(alertLine).borderLeftWidth,
        quoteBackground: getComputedStyle(alertLine, '::before').backgroundImage
      };
      const wrappedLine = Array.from(document.querySelectorAll<HTMLElement>('#order-host .cm-line'))
        .find((line) => line.innerText.includes('wrapped quote task'))!;
      const wrapped = {
        lineHeight: wrappedLine.getBoundingClientRect().height,
        quoteHeight: Number.parseFloat(getComputedStyle(wrappedLine, '::before').height),
        quoteLeft: wrappedLine.getBoundingClientRect().left
          + Number.parseFloat(getComputedStyle(wrappedLine, '::before').left),
        markerRight: wrappedLine.querySelector<HTMLElement>('.meo-md-list-marker')!
          .getBoundingClientRect().right
      };
      editor.destroy();
      return { lines, continuations, activeQuoteLeft, activeQuoteBarPositions, activeMarkerRects, activeOrderedMarker,
        alert, wrapped };
    });
    assert.equal(quoteOrder.lines.length, 6);
    for (const index of [0, 2, 3]) {
      const line = quoteOrder.lines[index]!;
      assert.ok(line.quoteLeft >= line.markers[0]!.right - 1
        && line.quoteLeft <= line.markers[1]!.left + 1,
      `a quote inside a list must follow the outer marker: ${JSON.stringify(line)}`);
      assert.equal(line.checkboxes, 1);
    }
    assert.ok(quoteOrder.lines[1]!.quoteLeft < quoteOrder.lines[1]!.markers[0]!.left,
      `an outer quote must precede the list marker: ${JSON.stringify(quoteOrder.lines[1])}`);
    assert.ok(quoteOrder.continuations.length === 2
      && quoteOrder.continuations.every((line) => line.sourced)
      && Math.abs(quoteOrder.continuations[0]!.quoteLeft - quoteOrder.continuations[1]!.quoteLeft) <= 1,
      `a quote nested in a list must keep its border across source lines: ${JSON.stringify(quoteOrder.continuations)}`);
    const interleaved = quoteOrder.lines[4]!;
    assert.ok(interleaved.quoteLeft < interleaved.markers[0]!.left
      && interleaved.quoteBarPositions.length === 2
      && interleaved.quoteLeft + interleaved.quoteBarPositions[1]! >= interleaved.markers[0]!.right - 1
      && interleaved.quoteLeft + interleaved.quoteBarPositions[1]! <= interleaved.markers[1]!.left + 1,
      `an outer quote and inner quote must remain separate: ${JSON.stringify(interleaved)}`);
    assert.equal(quoteOrder.activeOrderedMarker.text, '1.');
    assert.ok(quoteOrder.activeQuoteBarPositions.length === 2
      && quoteOrder.activeQuoteLeft + quoteOrder.activeQuoteBarPositions[1]!
        >= quoteOrder.activeOrderedMarker.right - 1
      && quoteOrder.activeQuoteLeft + quoteOrder.activeQuoteBarPositions[1]! <= quoteOrder.activeMarkerRects[0]!.left + 1,
      `the inner quote must stay after the list marker while editing: ${JSON.stringify(quoteOrder)}`);
    assert.ok(quoteOrder.alert.className.includes('meo-md-alert')
      && quoteOrder.alert.quoteLeft >= quoteOrder.alert.markerRight - 1
      && quoteOrder.alert.borderLeftWidth === '0px'
      && quoteOrder.alert.quoteBackground !== 'none',
      `an alert quote inside a list must follow the same order: ${JSON.stringify(quoteOrder.alert)}`);
    assert.ok(quoteOrder.wrapped.lineHeight > 40
      && Math.abs(quoteOrder.wrapped.quoteHeight - quoteOrder.wrapped.lineHeight) <= 1
      && quoteOrder.wrapped.quoteLeft >= quoteOrder.wrapped.markerRight - 1,
      `an inner quote rule must span wrapped lines: ${JSON.stringify(quoteOrder.wrapped)}`);

    const sameLineTable = await page.evaluate(async () => {
      const source = '| Items |\n| --- |\n| - 1. forward<br>1. - reverse<br>> - 1. quoted<br>- 1. [ ] task<br>- [ ] 1. task first<br>- > 1. list quote<br>1. - [x] reverse task |';
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const cell = document.querySelector<HTMLElement>('#table-host tbody td .meo-md-html-table-cell-preview')!;
      const result = {
        listItems: cell.querySelectorAll('li').length,
        checkboxes: cell.querySelectorAll('input[type=checkbox]').length,
        taskMarkerStyles: Array.from(cell.querySelectorAll<HTMLElement>('li.meo-md-html-table-cell-task'))
          .map((item) => getComputedStyle(item).listStyleType),
        text: cell.innerText,
        source: editor.getText()
      };
      editor.destroy();
      return result;
    });
    assert.equal(sameLineTable.listItems, 13, 'table cell must retain every parsed same-line nested list');
    assert.equal(sameLineTable.checkboxes, 3);
    assert.deepEqual(sameLineTable.taskMarkerStyles, ['decimal', 'none', 'none'],
      'table task items should use a checkbox as their only marker');
    assert.ok(['forward', 'reverse', 'quoted', 'task first', 'list quote', 'reverse task']
      .every((text) => sameLineTable.text.includes(text)));
    assert.equal(sameLineTable.source, '| Items |\n| --- |\n| - 1. forward<br>1. - reverse<br>> - 1. quoted<br>- 1. [ ] task<br>- [ ] 1. task first<br>- > 1. list quote<br>1. - [x] reverse task |');

    const tableQuoteOrder = await page.evaluate(async () => {
      const source = '| Item |\n| --- |\n| 1. > - [ ] list then quote<br>> 1. - [ ] quote then list |';
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const cell = document.querySelector<HTMLElement>('#table-host tbody td .meo-md-html-table-cell-preview')!;
      const result = {
        listThenQuote: Boolean(cell.querySelector('ol > li > blockquote > ul > li > .meo-md-table-task-content > input[type=checkbox]')),
        quoteThenList: Boolean(cell.querySelector('blockquote > ol > li > ul > li > .meo-md-table-task-content > input[type=checkbox]')),
        source: editor.getText()
      };
      editor.destroy();
      return result;
    });
    assert.ok(tableQuoteOrder.listThenQuote && tableQuoteOrder.quoteThenList,
      `table-cell containers must follow source nesting: ${JSON.stringify(tableQuoteOrder)}`);
    assert.equal(tableQuoteOrder.source,
      '| Item |\n| --- |\n| 1. > - [ ] list then quote<br>> 1. - [ ] quote then list |');

    const taskBoundary = await page.evaluate(async () => {
      const source = [
        'plain [ ] middle', '',
        '- list text [ ] middle', '',
        '1. list text [x] middle', '',
        '> - quote text [ ] middle', '',
        '- [ ] actual task', '',
        '- [ ] 1. task body keeps number as text'
      ].join('\n');
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line'))
        .filter((line) => line.innerText.trim())
        .map((line) => ({ text: line.innerText, boxes: line.querySelectorAll('.meo-task-checkbox').length }));
      editor.destroy();
      const tableEditor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!,
        text: '| Plain | List text | Actual task |\n| --- | --- | --- |\n| plain [ ] middle | - list text [x] middle | - [ ] actual task |',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const cells = Array.from(document.querySelectorAll<HTMLElement>('#table-host tbody td'))
        .map((cell) => ({ text: cell.innerText, boxes: cell.querySelectorAll('input[type=checkbox]').length }));
      tableEditor.destroy();
      return { lines, cells };
    });
    assert.deepEqual(taskBoundary.lines.map((line) => line.boxes), [0, 0, 0, 0, 1, 1],
      'checkbox syntax inside ordinary text must remain text');
    assert.deepEqual(taskBoundary.cells.map((cell) => cell.boxes), [0, 0, 1]);
    assert.ok(taskBoundary.lines[0]?.text.includes('[ ]') && taskBoundary.lines[1]?.text.includes('[ ]')
      && taskBoundary.lines[2]?.text.includes('[x]') && taskBoundary.lines[3]?.text.includes('[ ]')
      && taskBoundary.lines[5]?.text.includes('1. task body'));

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: '> - [ ] task',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__compositeEdit = editor;
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    });
    await page.keyboard.press('Enter');
    const liveEnter = await page.evaluate(() => {
      const editor = (window as any).__compositeEdit;
      const text = editor.getText();
      editor.destroy();
      return text;
    });
    assert.equal(liveEnter, '> - [ ] task\n> - [ ] ', 'Enter must continue the quoted task list');

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!,
        text: '| Items |\n| --- |\n| > - [ ] task |',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__compositeTableEdit = editor;
      const input = document.querySelector<HTMLTextAreaElement>('#edit-host tbody textarea')!;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    const tableEnter = await page.evaluate(() => {
      const editor = (window as any).__compositeTableEdit;
      const value = document.querySelector<HTMLTextAreaElement>('#edit-host tbody textarea')!.value;
      editor.destroy();
      return value;
    });
    assert.ok(tableEnter.endsWith('<br>\n> - [ ] '), `Enter must continue the quoted table-cell task: ${tableEnter}`);

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: '> - [ ] ',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__emptyCompositeEdit = editor;
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    });
    await page.keyboard.press('Enter');
    const emptyExit = await page.evaluate(() => {
      const editor = (window as any).__emptyCompositeEdit;
      const text = editor.getText();
      editor.destroy();
      return text;
    });
    assert.equal(emptyExit, '> ', 'empty quoted task must exit the list and keep the quote');

    const quoteTable = await page.evaluate(async () => {
      const source = '> | A | B |\n> | --- | --- |\n> | visible quote cell | yes |';
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__quoteTableEdit = editor;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const result = {
        cells: document.querySelectorAll('#edit-host .meo-md-html-table-cell-preview').length,
        text: document.getElementById('edit-host')!.innerText,
        source: editor.getText()
      };
      return { ...result, expectedSource: source };
    });
    assert.ok(quoteTable.cells >= 2 && quoteTable.text.includes('visible quote cell'));
    assert.equal(quoteTable.source, quoteTable.expectedSource);
    await page.click('#edit-host tbody tr:first-child td:first-child textarea');
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await page.keyboard.press('Escape');
    const editedQuoteTable = await page.evaluate(async () => {
      const editor = (window as any).__quoteTableEdit;
      const text = editor.getText();
      await editor.undo();
      const undone = editor.getText();
      await editor.redo();
      const redone = editor.getText();
      editor.destroy();
      return { text, undone, redone };
    });
    const editedSource = quoteTable.expectedSource.replace('visible quote cell', 'visible quote cell edited');
    assert.equal(editedQuoteTable.text, editedSource);
    assert.equal(editedQuoteTable.undone, quoteTable.expectedSource);
    assert.equal(editedQuoteTable.redone, editedSource);
    await assertTwoStateTasks(await browser.newPage());
    console.log('live composite list checks passed');
  } finally {
    await closeTestBrowser(browser);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
