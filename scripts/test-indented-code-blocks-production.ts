import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const fixtures = [
  { name: 'multiline', source: '    通过右上角的设置按钮打开小\n    菜单点击“更多设置”打1\n    开完整设置窗口。', expected: '通过右上角的设置按钮打开小\n菜单点击“更多设置”打1\n开完整设置窗口。' },
  { name: 'single', source: '    单行代码内容', expected: '单行代码内容' },
  { name: 'wrapped', source: '    ' + '一条需要自动换行的代码内容'.repeat(12), expected: '一条需要自动换行的代码内容'.repeat(12) },
  { name: 'indent-and-blank', source: '      alpha\n\n        beta', expected: '  alpha\n\n    beta' },
  { name: 'tabs', source: '\t alpha\n\t\tbeta', expected: ' alpha\n\tbeta' },
  { name: 'quote', source: '>     alpha\n>\n>     beta', expected: 'alpha\n\nbeta' },
  { name: 'list', source: '- Parent\n\n      alpha\n      beta', expected: 'alpha\nbeta' },
  { name: 'literal-fences', source: '    ```\n    alpha\n    ```', expected: '```\nalpha\n```' },
  { name: 'plain-fence', source: '```\nalpha\n\nbeta\n```', expected: 'alpha\n\nbeta' },
  { name: 'text-fence', source: '```text\nalpha\n\nbeta\n```', expected: 'alpha\n\nbeta' },
  { name: 'plaintext-fence', source: '```plaintext\nalpha\n\nbeta\n```', expected: 'alpha\n\nbeta' }
];
const build = await Bun.build({
  entrypoints: ['scripts/test-code-block-line-numbers-entry.ts'], target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0].text();
const browser = await launchTestBrowser();

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

async function codeColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const colors = new Set<string>();
    for (const line of document.querySelectorAll('.meo-md-code-line-numbered')) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || text.parentElement!.closest('.meo-code-block-actions, .meo-code-language-label, .meo-md-marker, .meo-md-marker-active')) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (range.getClientRects().length) colors.add(getComputedStyle(text.parentElement!).color);
      }
    }
    return [...colors];
  });
}

async function verifyCodePaletteAndHighlightBounds(): Promise<void> {
  const failures: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    const page = await browser.newPage();
    try {
      const codeBackground = theme === 'dark' ? '#1b2024' : '#f6f8fa';
      const codeForeground = theme === 'dark' ? '#c5cad3' : '#3f4854';
      await page.setViewport({ width: 520, height: 420, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${theme}"><div id="app" class="editor-host"></div></body>`);
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addStyleTag({ content: `:root{
        --meo-background:${theme === 'dark' ? '#24292e' : '#ffffff'};
        --meo-foreground:${theme === 'dark' ? '#ffffff' : '#111111'};
        --vscode-editor-foreground:${theme === 'dark' ? '#ffffff' : '#111111'};
        --vscode-editor-background:${theme === 'dark' ? '#24292e' : '#ffffff'};
        --meo-code-palette-background:${codeBackground};--meo-code-palette-foreground:${codeForeground};
        --meo-token-foreground-color:${codeForeground};--meo-code-background:${codeBackground};
        --meo-semantic-codeLanguageLabelForeground:#8b949e;
        --meo-font-source:monospace;--meo-font-source-weight:400;
        --vscode-editor-font-family:monospace;--vscode-editor-font-size:18px;--vscode-editor-line-height:26px;
      }` });
      await page.addScriptTag({ content: bundle });
      for (const kind of ['multiline', 'single'] as const) {
        await page.evaluate(kind => {
          const scope = window as any;
          scope.__editor?.destroy();
          document.getElementById('app')!.replaceChildren();
          scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
            parent: document.getElementById('app')!,
            text: kind === 'single' ? '    alpha\n\n尾部' : '    alpha\n    beta\n    gamma\n\n尾部',
            initialMode: 'live', onApplyChanges() {}
          });
          scope.__editor.view.focus();
        }, kind);
        await settle(page);
        const palette = await page.evaluate(() => {
          const probe = document.createElement('span'); document.body.append(probe);
          probe.style.backgroundColor = 'var(--meo-code-background)';
          const background = getComputedStyle(probe).backgroundColor;
          probe.style.backgroundColor = 'var(--meo-code-block-active-line-bg)';
          const active = getComputedStyle(probe).backgroundColor; probe.remove();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const hex = () => '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
          context.fillStyle = background; context.fillRect(0, 0, 1, 1);
          const code = hex();
          context.fillStyle = active; context.fillRect(0, 0, 1, 1);
          return { code, active: hex() };
        });
        const rowColors = await codeColors(page);
        const expectedCodeColor = codeForeground === '#c5cad3' ? 'rgb(197, 202, 211)' : 'rgb(63, 72, 84)';
        if (JSON.stringify(rowColors) !== JSON.stringify([expectedCodeColor])) failures.push(`${theme}/${kind}: plain code palette expected ${expectedCodeColor}, got ${rowColors}`);
        const cases = kind === 'single' ? ['first', 'range'] : ['first', 'middle', 'last', 'range'];
        for (const active of cases) {
          await page.evaluate(({ active, kind }) => {
            const view = (window as any).__editor.view;
            const lineNumber = active === 'middle' ? 2 : active === 'last' && kind === 'multiline' ? 3 : 1;
            const line = view.state.doc.line(lineNumber);
            view.dispatch({ selection: active === 'range'
              ? { anchor: view.state.doc.line(1).from + 4, head: view.state.doc.line(kind === 'single' ? 1 : 3).to }
              : { anchor: line.to } });
            view.focus();
          }, { active, kind });
          await settle(page);
          const geometry = await page.evaluate(() => {
            const first = document.querySelector<HTMLElement>('.meo-md-indented-code-block-start')!;
            const last = document.querySelector<HTMLElement>('.meo-md-indented-code-block-end')!;
            const current = document.querySelector<HTMLElement>('.cm-activeLine.meo-md-code-block');
            const top = first.getBoundingClientRect();
            const bottom = last.getBoundingClientRect();
            const header = Number.parseFloat(getComputedStyle(first).paddingTop);
            const footer = Number.parseFloat(getComputedStyle(last).paddingBottom);
            const points = [{ x: top.right - 150, y: top.top + header / 2 }, { x: bottom.right - 150, y: bottom.bottom - footer / 2 }];
            if (current) {
              const box = current.getBoundingClientRect();
              const style = getComputedStyle(current);
              points.push({ x: box.right - 150, y: box.top + Number.parseFloat(style.paddingTop) + 12 });
            }
            return points;
          });
          const screenshot = await page.screenshot();
          const screenshotDir = process.env.MEO_CODE_BLOCK_SCREENSHOT_DIR;
          if (screenshotDir && kind === 'multiline' && active !== 'middle') {
            fs.mkdirSync(screenshotDir, { recursive: true });
            fs.writeFileSync(path.join(screenshotDir, `${theme}-${active}.png`), screenshot);
          }
          const pixels = await page.evaluate(async ({ source, points }) => {
            const screenshot = new Image();
            screenshot.src = source;
            await screenshot.decode();
            const canvas = document.createElement('canvas');
            canvas.width = screenshot.width; canvas.height = screenshot.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(screenshot, 0, 0);
            return points.map(point => '#' + [...context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join(''));
          }, { source: 'data:image/png;base64,' + Buffer.from(screenshot).toString('base64'), points: geometry });
          if (pixels[0] !== palette.code || pixels[1] !== palette.code) failures.push(`${theme}/${kind}/${active}: visual padding must stay ${palette.code}, got ${pixels.slice(0, 2)}`);
          if (active !== 'range' && pixels[2] !== palette.active) failures.push(`${theme}/${kind}/${active}: body highlight must stay ${palette.active}, got ${pixels[2]}`);
        }
        if (kind === 'multiline') {
          await page.evaluate(() => {
            const view = (window as any).__editor.view;
            view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
            view.focus();
          });
          await page.keyboard.type('x');
          await settle(page);
          const editedColors = await codeColors(page);
          if (JSON.stringify(editedColors) !== JSON.stringify([expectedCodeColor])) failures.push(`${theme}/${kind}: typing must retain the plain code palette, got ${editedColors}`);
        }
      }
    } finally { await page.close(); }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}


async function verifyInputAndNavigationFrames(): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1050, height: 620 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: ':root{--meo-background:#23272e;--meo-foreground:#d5dce5;--meo-code-background:#1c2026;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:20px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:20px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:20px;--vscode-editor-line-height:28px}' });
    await page.addScriptTag({ content: bundle });
    for (const size of [50, 4500]) for (const indent of ['    ', '\t']) {
      const actions = size === 50 ? ['split-last', 'enter-last', 'extend-blank', 'above', 'below', 'navigate'] as const
        : ['split-last', 'enter-last'] as const;
      for (const action of actions) {
        const initialText = [...Array.from({ length: size }, (_, index) => `前置 ${index}`), '',
          indent + 'one', indent + 'two', indent + '多个行内公式: $a^2 + b^2 = c^2$, ...$\\alpha + \\beta = \\gamma$。',
          ...(action === 'extend-blank' ? [indent] : []), '',
          ...Array.from({ length: size }, (_, index) => `后置 ${index}`)].join('\n');
        const setup = await page.evaluate(async ({ text, action, indentLength, targetLine }) => {
          const scope = window as any;
          scope.__editor?.destroy();
          document.getElementById('app')!.replaceChildren();
          const editor = scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
            parent: document.getElementById('app')!, text, initialMode: 'live',
            initialLongCodeBlockFolding: false, onApplyChanges() {}
          });
          editor.scrollToLine(targetLine, 'center');
          for (let frame = 0; frame < 10; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const view = editor.view;
          const target = view.state.doc.line(targetLine + (action === 'extend-blank' ? 1 : 0));
          const position = action === 'split-last' ? target.from + indentLength + 15 : target.to;
          view.dispatch({ selection: { anchor: position } });
          view.focus();
          for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const caret = view.coordsAtPos(position)!;
          const viewport = view.scrollDOM.getBoundingClientRect();
          if (action === 'above') view.scrollDOM.scrollTop += caret.top - viewport.top + 5;
          if (action === 'below') view.scrollDOM.scrollTop += caret.bottom - viewport.bottom - 5;
          for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const samples: Array<{ top: number | null; left: number | null; scroll: number; code: boolean; numbers: string[] }> = [];
          let sampling = true;
          const sample = () => {
            const head = view.state.selection.main.head;
            const coords = view.coordsAtPos(head);
            const dom = view.domAtPos(head).node;
            const row = (dom instanceof Element ? dom : dom.parentElement)?.closest('.cm-line');
            samples.push({ top: coords?.top ?? null, left: coords?.left ?? null,
              scroll: view.scrollDOM.scrollTop, code: Boolean(row?.classList.contains('meo-md-code-block')),
              numbers: Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'))
                .map(row => row.dataset.meoCodeLineNumber!) });
            if (sampling) requestAnimationFrame(sample);
          };
          scope.__inputFrames = { samples, beforeScroll: view.scrollDOM.scrollTop, stop() { sampling = false; } };
          // Trusted commands are sampled from their first painted frame.
          if (action === 'navigate') {
            editor.scrollToLine(targetLine, 'top');
            requestAnimationFrame(sample);
          } else {
            window.addEventListener('keydown', () => requestAnimationFrame(sample), { capture: true, once: true });
          }
          return { position };
        }, { text: initialText, action, indentLength: indent.length, targetLine: size + 4 });
        if (action !== 'navigate') await page.keyboard.press(action === 'split-last' || action === 'enter-last' ? 'Enter' : 'X');
        await settle(page);
        await settle(page);
        const result = await page.evaluate(() => {
          const scope = window as any;
          scope.__inputFrames.stop();
          const view = scope.__editor.view;
          const caret = view.coordsAtPos(view.state.selection.main.head);
          const viewport = view.scrollDOM.getBoundingClientRect();
          return { ...scope.__inputFrames, text: scope.__editor.getText(),
            visible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom) };
        });
        const context = `${size}/${indent === '\t' ? 'tab' : 'spaces'}/${action}`;
        assert.ok(result.samples.length >= 10, context + ': captured initial and settled frames');
        const last = result.samples.at(-1)!;
        assert.ok(result.visible, context + ': caret remains visible');
        for (const sample of result.samples) {
          assert.ok(sample.top !== null && Math.abs(sample.top - last.top) <= 1, context + ': caret Y jumped: ' + JSON.stringify(result.samples));
          assert.ok(sample.left !== null && Math.abs(sample.left - last.left) <= 1, context + ': caret X jumped: ' + JSON.stringify(result.samples));
          assert.ok(Math.abs(sample.scroll - last.scroll) <= 1, context + ': viewport scrolled twice');
          // Enter continues an explicitly indented row. Empty-Enter exit is
          // asserted separately by verifyIndentedCodeLifecycle.
          assert.equal(sample.code, true, context + ': correct source surface from first frame');
          assert.deepEqual(sample.numbers, last.numbers, context + ': gutter stable from first frame');
        }
        if (action !== 'above' && action !== 'below' && action !== 'navigate') {
          assert.ok(Math.abs(last.scroll - result.beforeScroll) <= 1, context + ': visible input preserves viewport');
        }
        const insertion = action === 'split-last' || action === 'enter-last' ? '\n' + indent : 'X';
        const expectedText = action === 'navigate' ? initialText
          : initialText.slice(0, setup.position) + insertion + initialText.slice(setup.position);
        assert.equal(result.text, expectedText, context + ': source and indentation retained');
      }
    }
  } finally { await page.close(); }
}

async function verifyIndentedCodeLifecycle(): Promise<void> {
  const page = await browser.newPage();
  const failures: string[] = [];
  try {
    await page.setViewport({ width: 720, height: 540 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addScriptTag({ content: bundle });
    for (const mode of ['live', 'source']) {
      for (const fixture of [
        { name: 'spaces', text: '    alpha', prefix: '    ', container: '' },
        { name: 'tabs', text: '\talpha', prefix: '\t', container: '' },
        { name: 'extra-indent', text: '      alpha', prefix: '      ', container: '' },
        { name: 'literal-quote', text: '    > alpha', prefix: '    ', container: '' },
        { name: 'literal-list', text: '    - alpha', prefix: '    ', container: '' },
        { name: 'quote', text: '>     alpha', prefix: '>     ', container: '> ' },
        { name: 'list', text: '- Parent\n\n      alpha', prefix: '      ', container: '  ' },
        { name: 'footnote', text: '[^a]: note\n\n        alpha', prefix: '        ', container: '    ' }
      ]) {
        const context = `${mode}/${fixture.name}`;
        await page.evaluate(({ text, mode }) => {
          const scope = window as any;
          scope.__editor?.destroy();
          document.getElementById('app')!.replaceChildren();
          const editor = scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
            parent: document.getElementById('app')!, text, initialMode: mode,
            initialLongCodeBlockFolding: false, onApplyChanges() {}
          });
          editor.view.dispatch({ selection: { anchor: text.length } });
          editor.view.focus();
        }, { text: fixture.text, mode });
        await settle(page);
        const read = () => page.evaluate(() => {
          const view = (window as any).__editor.view;
          const head = view.state.selection.main.head;
          const dom = view.domAtPos(head).node;
          const row = (dom instanceof Element ? dom : dom.parentElement)?.closest<HTMLElement>('.cm-line');
          return { text: view.state.doc.toString(), head, number: row?.dataset.meoCodeLineNumber ?? '',
            code: Boolean(row?.classList.contains('meo-md-code-block')) };
        });
        await page.keyboard.press('Enter');
        const immediate = await read();
        await settle(page);
        const continued = await read();
        const expected = fixture.text + '\n' + fixture.prefix;
        if (continued.text !== expected || continued.head !== expected.length) {
          failures.push(`${context}: Enter must retain the exact prefix: ${JSON.stringify(continued)}`);
        }
        if (mode === 'live' && (!immediate.code || immediate.number !== '2' || !continued.code || continued.number !== '2')) {
          failures.push(`${context}: trailing editable blank must stay in the code surface with line 2: ${JSON.stringify({ immediate, continued })}`);
        }
        const paste = await page.evaluate(() => {
          const view = (window as any).__editor.view;
          const data = new DataTransfer();
          data.setData('text/plain', 'a\tb\nc\td');
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
          view.contentDOM.dispatchEvent(event);
          return view.state.doc.toString();
        });
        if (paste !== expected + 'a\tb\n' + fixture.prefix + 'c\td') {
          failures.push(context + ': code paste must retain literal text and structural indentation');
        }
        await page.evaluate(() => (window as any).__editor.undo());
        await settle(page);
        if ((await read()).text !== expected) failures.push(context + ': one undo must remove the complete paste');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await settle(page);
        const blank = await read();
        if (blank.text !== expected + '\n' + fixture.prefix || (mode === 'live' && (!blank.code || blank.number !== '3'))) {
          failures.push(`${context}: Shift+Enter must retain a numbered code blank: ${JSON.stringify(blank)}`);
        }
        await page.evaluate(() => (window as any).__editor.undo());
        await settle(page);
        if ((await read()).text !== expected) failures.push(context + ': undo must restore the previous code blank');
        await page.evaluate(() => (window as any).__editor.redo());
        await settle(page);
        if ((await read()).text !== blank.text) failures.push(context + ': redo must restore the code blank');
        await page.evaluate(() => (window as any).__editor.undo());
        await settle(page);
        await page.keyboard.press('Enter');
        await settle(page);
        const exited = await read();
        const expectedExit = fixture.text + '\n' + fixture.container;
        if (exited.text !== expectedExit || exited.head !== expectedExit.length || (mode === 'live' && exited.code)) {
          failures.push(`${context}: Enter on an empty code line must exit and retain its container: ${JSON.stringify(exited)}`);
        }
        await page.keyboard.type('tail');
        await settle(page);
        const tail = await read();
        if (tail.text !== expectedExit + 'tail' || (mode === 'live' && tail.code)) {
          failures.push(`${context}: text after exit must remain prose: ${JSON.stringify(tail)}`);
        }
      }
    }
    for (const mode of ['live', 'source']) {
      await page.evaluate(mode => {
        const scope = window as any;
        scope.__editor?.destroy(); document.getElementById('app')!.replaceChildren();
        scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
          parent: document.getElementById('app')!, text: 'alpha\n\nTail', initialMode: mode, onApplyChanges() {}
        });
        scope.__editor.view.focus();
      }, mode);
      await settle(page);
      const readIndent = () => page.evaluate(() => ({ text: (window as any).__editor.getText(),
        code: Boolean(document.querySelector('.cm-line.meo-md-code-line-numbered')) }));
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await settle(page);
      const entered = await readIndent();
      assert.equal(entered.text, '    alpha\n\nTail', mode + ': Tab can enter indented code');
      if (mode === 'live') assert.equal(entered.code, true, 'Tab projects a numbered code surface');
      // Test the outdent's own undo separately from rapid repeated indentation,
      // which CodeMirror deliberately combines into one typing history group.
      await page.evaluate(({ mode, text }) => {
        const scope = window as any;
        scope.__editor.destroy(); document.getElementById('app')!.replaceChildren();
        scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: mode, onApplyChanges() {}
        });
        scope.__editor.view.focus();
      }, { mode, text: entered.text });
      await settle(page);
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      await settle(page);
      const outdented = await readIndent();
      assert.equal(outdented.text, '  alpha\n\nTail', mode + ': Shift+Tab preserves content');
      assert.equal(outdented.code, false, mode + ': outdent exits the code surface');
      const undoReceipt = await page.evaluate(async () => {
        const editor = (window as any).__editor;
        const before = editor.getHistoryDepth(), undone = await editor.undo();
        return { before, undone, after: editor.getHistoryDepth() };
      });
      await settle(page);
      assert.equal((await readIndent()).text, entered.text, mode + ': undo restores indentation ' + JSON.stringify(undoReceipt));
      await page.evaluate(() => {
        const view = (window as any).__editor.view;
        view.dispatch({ selection: { anchor: 4 } }); view.focus();
      });
      await page.keyboard.press('Backspace'); await settle(page);
      const deleted = await readIndent();
      assert.equal(deleted.text, '  alpha\n\nTail', mode + ': Backspace removes one indentation unit');
      assert.equal(deleted.code, false, mode + ': Backspace retires code decorations');
    }
    for (const prefix of ['', '    ']) {
      const text = '    alpha\n' + prefix + '\n    beta';
      await page.evaluate(({ text, prefix }) => {
        const scope = window as any;
        scope.__editor.destroy(); document.getElementById('app')!.replaceChildren();
        scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
        });
        const view = scope.__editor.view;
        view.dispatch({ selection: { anchor: view.state.doc.line(2).from + prefix.length } }); view.focus();
      }, { text, prefix });
      await settle(page);
      await page.keyboard.press('Enter');
      const expected = prefix ? '    alpha\n\n    beta' : '    alpha\n\n\n    beta';
      assert.equal(await page.evaluate(() => (window as any).__editor.getText()), expected,
        'Enter on an internal code blank exits indentation without a no-op');
      await page.keyboard.type('prose'); await settle(page);
      const row = await page.evaluate(() => {
        const view = (window as any).__editor.view, head = view.state.selection.main.head;
        const dom = view.domAtPos(head).node;
        return { code: Boolean((dom instanceof Element ? dom : dom.parentElement)?.closest('.meo-md-code-block')),
          line: view.state.doc.lineAt(head).text, last: view.state.doc.line(view.state.doc.lines).text };
      });
      assert.deepEqual(row, { code: false, line: 'prose', last: '    beta' }, 'internal exit keeps following code intact');
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally { await page.close(); }
}

async function verifyNativeCodeCaret(): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 720, height: 600 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><button id="outside">Outside</button><div id="app" class="editor-host"></div>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: ':root{--meo-background:#23272e;--meo-foreground:#d5dce5;--meo-font-source:monospace;--meo-font-source-size:16px}.cm-editor{--meo-caret-color:#ff00ff!important}.cm-content{caret-animation:manual}' });
    await page.addScriptTag({ content: bundle });
    for (const prefix of ['    ', '\t', '>     ', '>\t  ', '> >     ']) {
      await page.evaluate(prefix => {
        const scope = window as any;
        scope.__editor?.destroy();
        document.getElementById('app')!.replaceChildren();
        scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
          parent: document.getElementById('app')!,
          text: ['Before', '', prefix + 'alpha', prefix, prefix + 'beta', '', 'After'].join('\n'),
          initialMode: 'live', onApplyChanges() {}
        });
      }, prefix);
      await settle(page);
      for (const target of [{ line: 3, offset: 0 }, { line: 3, offset: prefix.length },
        { line: 3, offset: prefix.length + 5 }, { line: 4, offset: prefix.length },
        { line: 5, offset: prefix.length }]) {
        await page.focus('#outside');
        const point = await page.evaluate(({ line, offset }) => {
          const view = (window as any).__editor.view;
          view.dispatch({ selection: { anchor: view.state.doc.line(line).from + offset } });
          view.focus();
          const rect = view.coordsAtPos(view.state.selection.main.head)!;
          return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
        }, target);
        if (target.offset === prefix.length) await page.mouse.click(point.x, point.y);
        await settle(page);
        const caret = await page.evaluate(() => {
          const view = (window as any).__editor.view, native = getSelection();
          const head = view.state.selection.main.head, rect = view.coordsAtPos(head)!;
          const prefix = native?.focusNode?.parentElement?.closest('.cm-line')?.querySelector<HTMLElement>('.meo-md-code-container-prefix');
          return { head, nativeHead: native?.focusNode ? view.posAtDOM(native.focusNode, native.focusOffset) : null,
            parent: native?.focusNode?.parentElement?.className,
            color: native?.focusNode?.parentElement ? getComputedStyle(native.focusNode.parentElement).caretColor : '',
            nativeRect: native?.rangeCount ? native.getRangeAt(0).getBoundingClientRect().toJSON() : null,
            prefix: prefix ? { html: prefix.outerHTML, width: prefix.getBoundingClientRect().width,
              columns: getComputedStyle(prefix).getPropertyValue('--meo-live-container-ch'),
              font: getComputedStyle(prefix).font } : null,
            clip: { x: Math.max(0, rect.left - 3), y: Math.max(0, rect.top), width: 8, height: Math.max(1, rect.bottom - rect.top) } };
        });
        const screenshot = await page.screenshot({ clip: caret.clip });
        const painted = await page.evaluate(async source => {
          const image = new Image(); image.src = source; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] > 180 && pixels[index + 1] < 90 && pixels[index + 2] > 180) count++;
          }
          return count;
        }, 'data:image/png;base64,' + Buffer.from(screenshot).toString('base64'));
        assert.equal(caret.nativeHead, caret.head, 'native and document code caret agree');
        if (painted < 5) {
          fs.mkdirSync('.local/indented-code-acceptance', { recursive: true });
          await page.screenshot({ path: '.local/indented-code-acceptance/caret-failure.png' });
        }
        assert.ok(painted >= 5, `code caret must be painted (${JSON.stringify({ prefix, target, caret, painted })})`);
      }
    }
  } finally { await page.close(); }
}

try {
  await verifyNativeCodeCaret();
  await verifyIndentedCodeLifecycle();
  await verifyInputAndNavigationFrames();
  await verifyCodePaletteAndHighlightBounds();
  for (const theme of ['dark', 'light'] as const) {
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      try {
        const context = `${theme}/${fixture.name}`;
        const payloadLines = fixture.expected.split('\n').filter(line => line.trim());
        const uiLanguage = fixture.name === 'wrapped' || theme === 'dark' ? 'zh-CN' : 'en';
        const foreground = theme === 'dark' ? '#e6edf3' : '#24292f';
        const codeForeground = theme === 'dark' ? '#c5cad3' : '#3f4854';
        const expectedCodeColor = theme === 'dark' ? 'rgb(197, 202, 211)' : 'rgb(63, 72, 84)';
        const text = '# 设置界面预览\n\n' + fixture.source + '\n\n尾部与 `行内代码`';
        await page.setViewport({ width: 520, height: 720 });
        await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${theme}"><div id="app" class="editor-host"></div></body>`);
        await page.addStyleTag({ path: 'webview/src/styles.css' });
        await page.addStyleTag({ content: `:root{
          --meo-background:${theme === 'dark' ? '#24292e' : '#ffffff'};
          --meo-foreground:${foreground};--vscode-editor-foreground:${foreground};
          --vscode-editor-background:${theme === 'dark' ? '#24292e' : '#ffffff'};
          --meo-code-palette-background:${theme === 'dark' ? '#1b2024' : '#f6f8fa'};--meo-code-palette-foreground:${codeForeground};
          --meo-token-foreground-color:${codeForeground};--meo-token-monospace-color:#79c0ff;
          --meo-code-background:${theme === 'dark' ? '#1b2024' : '#f6f8fa'};
          --meo-inline-code-background:${theme === 'dark' ? '#1b2024' : '#f6f8fa'};
          --meo-semantic-codeCopyForeground:${theme === 'dark' ? '#79c0ff' : '#0969da'};
          --meo-semantic-codeCopyBackground:transparent;
          --meo-semantic-codeLanguageLabelForeground:#8b949e;--meo-semantic-codeLanguageLabelBackground:transparent;
          --meo-semantic-mutedForeground:#8b949e;--meo-line-number-foreground:#8b949e;
          --meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-text:system-ui;--meo-font-text-weight:400;
          --vscode-editor-font-family:monospace;--vscode-editor-font-size:18px;--vscode-editor-line-height:26px;
        }` });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(({ text, uiLanguage, needle }) => {
          const scope = window as any;
          scope.__copiedCode = null;
          // Observe the production copy payload at the external clipboard boundary.
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            async writeText(value: string) { scope.__copiedCode = value; }
          } });
          scope.__editor = scope.CodeBlockLineNumbersHarness.createEditor({
            parent: document.getElementById('app')!, text, uiLanguage, initialMode: 'live', onApplyChanges() {}
          });
          scope.__editor.view.dispatch({ selection: { anchor: text.indexOf(needle) + 2 } });
          scope.__editor.view.focus();
        }, { text, uiLanguage, needle: payloadLines[Math.min(1, payloadLines.length - 1)].trim() });
        await settle(page);
        assert.deepEqual(await codeColors(page), [expectedCodeColor], context + ': active and inactive plain code colors');
        assert.equal(await page.$eval('.meo-md-inline-code', element => getComputedStyle(element).color),
          theme === 'dark' ? 'rgb(230, 237, 243)' : 'rgb(36, 41, 47)', context + ': inline code keeps its own presentation');
        await page.keyboard.type('x');
        await settle(page);
        assert.deepEqual(await codeColors(page), [expectedCodeColor], context + ': colors after typing');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle(page);
        assert.equal(await page.evaluate(() => (window as any).__editor.view.state.doc.toString()), text, context + ': undo retains original source');
        assert.equal(await page.$$eval('.meo-select-all-code-btn', elements => elements.length), 1, context + ': one select button');
        assert.equal(await page.$$eval('.meo-copy-code-btn', elements => elements.length), 1, context + ': one copy button');
        await page.hover('.meo-md-code-line-numbered');
        await settle(page);
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.meo-code-block-actions')!).opacity === '1', { timeout: 2000 });
        const layout = await page.evaluate(() => {
          const actions = document.querySelector<HTMLElement>('.meo-code-block-actions')!;
          const line = actions.closest('.cm-line')!;
          const box = actions.getBoundingClientRect();
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let overlap = false;
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.textContent?.trim() || text.parentElement!.closest('.meo-code-block-actions, .meo-code-language-label')) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            overlap ||= [...range.getClientRects()].some(rect => rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top);
          }
          return { overlap, opacity: getComputedStyle(actions).opacity,
            numbers: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered')).map(row => row.dataset.meoCodeLineNumber) };
        });
        assert.equal(layout.overlap, false, context + ': actions do not cover content');
        assert.equal(layout.opacity, '1', context + ': hover reveals actions');
        assert.deepEqual(layout.numbers, fixture.expected.split('\n').map((_, index) => String(index + 1)), context + ': visual space has no code line number');
        const alignment = await page.evaluate(needle => {
          const view = (window as any).__editor.view;
          const first = document.querySelector<HTMLElement>('.meo-md-code-line-numbered')!;
          const lineNumber = view.state.doc.lineAt(view.posAtDOM(first)).number;
          const marker = Array.from(view.scrollDOM.querySelectorAll('.cm-gutters > .cm-lineNumbers > .cm-gutterElement') as NodeListOf<HTMLElement>)
            .find(element => getComputedStyle(element).visibility !== 'hidden' && element.textContent?.trim() === String(lineNumber))!;
          const markerRange = document.createRange();
          markerRange.selectNodeContents(marker);
          const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const index = node.data.indexOf(needle);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const textBox = range.getBoundingClientRect();
            const markerBox = markerRange.getBoundingClientRect();
            return Math.abs((markerBox.top + markerBox.bottom) / 2 - (textBox.top + textBox.bottom) / 2);
          }
          throw new Error('First payload text not found');
        }, fixture.expected.split('\n')[0].trim());
        assert.ok(alignment <= 2, context + ': outer document number follows the first text baseline: ' + alignment);
        const label = await page.evaluate(() => {
          const element = document.querySelector<HTMLElement>('.meo-md-indented-code-block-start .meo-code-language-label');
          if (!element) return null;
          const box = element.getBoundingClientRect();
          const actions = document.querySelector('.meo-code-block-actions')!.getBoundingClientRect();
          return { text: element.textContent, role: element.getAttribute('role'), pointer: getComputedStyle(element).pointerEvents,
            topOffset: Math.abs(box.top - actions.top),
            overlapsActions: box.right > actions.left && box.left < actions.right && box.top < actions.bottom && box.bottom > actions.top };
        });
        if (fixture.source.startsWith('```')) {
          assert.equal(label, null, context + ': fenced blocks retain their language label');
        } else {
          assert.equal(label?.text, uiLanguage === 'zh-CN' ? '缩进代码块' : 'Indented code block', context + ': explanatory label');
          assert.equal(label.role, null, context + ': label is not a button');
          assert.equal(label.pointer, 'none', context + ': label does not intercept editing');
          assert.equal(label.overlapsActions, false, context + ': label and actions stay apart');
          assert.ok(label.topOffset <= 1, context + ': label shares the existing language toolbar row');
        }
        const screenshotDir = process.env.MEO_CODE_BLOCK_SCREENSHOT_DIR;
        if (screenshotDir && fixture.name === 'multiline') {
          fs.mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDir, `${theme}.png`) });
        }
        if (fixture.name === 'single') {
          await page.focus('.meo-select-all-code-btn');
          await page.keyboard.press('Enter');
        } else {
          await page.click('.meo-select-all-code-btn');
        }
        const selection = await page.evaluate(() => {
          const view = (window as any).__editor.view;
          return { from: view.state.selection.main.from, to: view.state.selection.main.to,
            text: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) };
        });
        assert.ok(payloadLines.every(line => selection.text.includes(line)), context + ': all content lines selected');
        assert.ok(!selection.text.includes('尾部') && !selection.text.includes('设置界面预览'), context + ': selection stays inside block');
        assert.equal(selection.from, text.indexOf(payloadLines[0]), context + ': selection begins with first payload');
        assert.equal(selection.to, text.lastIndexOf(payloadLines[payloadLines.length - 1]) + payloadLines[payloadLines.length - 1].length, context + ': selection ends with last payload');
        await page.hover('.meo-md-code-line-numbered');
        await page.click('.meo-copy-code-btn');
        assert.equal(await page.evaluate(() => (window as any).__copiedCode), fixture.expected, context + ': complete copy without structural prefixes');
        if (fixture.name === 'multiline') {
          await page.evaluate(language => (window as any).__editor.setUiLanguage(language), uiLanguage === 'zh-CN' ? 'en' : 'zh-CN');
          await settle(page);
          assert.equal(await page.$eval('.meo-md-indented-code-block-start .meo-code-language-label', element => element.textContent), uiLanguage === 'zh-CN' ? 'Indented code block' : '缩进代码块', context + ': localized label after language switch');
          await page.evaluate(() => (window as any).__editor.setMode('source'));
          await settle(page);
          assert.equal(await page.$('.meo-md-indented-code-block-start .meo-code-language-label'), null, context + ': label belongs only to Live');
        }
      } finally { await page.close(); }
    }
  }
  console.log(`Indented-code lifecycle/history, native caret pixels, ordinary/large input frames, plain-code colors, selection/copy and wrapped layouts passed (${fixtures.length * 2} visual fixtures, 12 highlight pixel checks)`);
} finally { await browser.close(); }
