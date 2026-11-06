import { installPackagedMermaid } from './mermaid-runtime-test-helpers';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const workerBuild = await Bun.build({ entrypoints: ['webview/src/markdownParseWorker.ts'], target: 'browser', format: 'iife' });
assert.ok(workerBuild.success, workerBuild.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 950, height: 950 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:Consolas,monospace;--meo-font-source-size:14px}' });
  await installPackagedMermaid(page);
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(uri => {
    document.body.dataset.meoMarkdownWorkerSrc = uri;
    const NativeWorker = Worker;
    (window as any).syntaxReplies = 0;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', event => {
          if (event.data.kind === 'syntax') (window as any).syntaxReplies++;
        });
      }
    };
  },
    'data:text/javascript;base64,' + Buffer.from(await workerBuild.outputs[0]!.text()).toString('base64'));
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const complex = fs.readFileSync('scripts/fixtures/github-readme/complex/README.md', 'utf8').replace(/\r\n/g, '\n');
  const headings = 'Before\n\n' + Array.from({ length: 6 }, (_, index) => '#'.repeat(index + 1) + ' Heading 标题').join('\n\n')
    + '\n\nSetext heading\n===\n\nSetext subheading\n---\n\nAfter';
  for (const [name, text] of [['ordinary', headings], ['optimized', headings + '\n\n' + 'Paragraph\n\n'.repeat(4500)],
    ['deep', complex]] as const) {
    const large = assessLargeDocument(text).boundedEditorWork;
    const target = name === 'deep' ? text.indexOf('## 14. Long Paragraph') : text.indexOf('## Heading');
    const targetLine = text.slice(0, target).split('\n').length;
    const initialReplies = await page.evaluate(() => (window as any).syntaxReplies);
    await page.evaluate(text => {
      const host = window as any;
      host.ed = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), initialMode: 'live',
        text, sourceLineNumbers: 'on', onApplyChanges() {} });
      host.headingSamples = [];
      let observing = false;
      let frame = 0;
      host.stopHeadingSamples = () => { observing = false; cancelAnimationFrame(frame); };
      host.readHeadingNumbers = () => {
        const view = host.ed.view;
        return Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line:is(.meo-md-h1,.meo-md-h2,.meo-md-h3,.meo-md-h4,.meo-md-h5,.meo-md-h6)')).map(row => {
          const line = view.state.doc.lineAt(view.posAtDOM(row)).number;
          const gutter = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
            .find(element => element.textContent === String(line));
          if (!gutter) return { line, offset: null };
          const range = document.createRange(); range.selectNodeContents(gutter);
          const number = range.getBoundingClientRect(), box = row.getBoundingClientRect();
          return { line, offset: (number.top + number.bottom - box.top - box.bottom) / 2 };
        });
      };
      const sample = () => {
        if (!observing) return;
        host.headingSamples.push(...host.readHeadingNumbers());
        frame = requestAnimationFrame(() => setTimeout(sample, 0));
      };
      host.startHeadingSamples = () => {
        observing = true;
        frame = requestAnimationFrame(() => setTimeout(sample, 0));
      };
    }, text);
    assert.equal(await page.evaluate(() => (window as any).ed.prepareLiveSyntax(() => true)), true,
      name + ': production Live preparation completes before accepting the visible surface');
    await page.evaluate(async () => {
      const host = window as any;
      // The production bootstrap keeps its cover until this same readiness
      // boundary. Sample its first accepted frame, not covered preparation DOM.
      await host.ed.whenVisiblePresentationReady(500);
      host.startHeadingSamples();
    });
    await settle();
    if (name === 'deep') await page.evaluate(line => (window as any).ed.scrollToLine(line - 2, 'top'), targetLine);
    await page.waitForFunction(line => (window as any).readHeadingNumbers().some((row: any) => row.line === line), {}, targetLine)
      .catch(async error => {
        const diagnostic = await page.evaluate(line => {
          const host = window as any, view = host.ed.view;
          const mounted = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).map(row => ({
            line: view.state.doc.lineAt(view.posAtDOM(row)).number, text: row.textContent?.slice(0, 100), className: row.className
          }));
          return { replies: host.syntaxReplies, rows: host.readHeadingNumbers(),
            pending: typeof host.MermaidEditingHarness.isLiveInputDerivedWorkPending === 'function'
              ? host.MermaidEditingHarness.isLiveInputDerivedWorkPending(view.state) : null,
            viewport: view.viewport, target: { line, text: view.state.doc.line(line).text },
            scroll: { top: view.scrollDOM.scrollTop, height: view.scrollDOM.clientHeight, maximum: view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight },
            mounted: [...mounted.slice(0, 3), ...mounted.filter(row => Math.abs(row.line - line) < 5), ...mounted.slice(-3)] };
        }, targetLine).catch(diagnosticError => ({ diagnosticError: String(diagnosticError) }));
        throw new Error(name + ': ' + String(error) + ' ' + JSON.stringify(diagnostic) + ' ' + JSON.stringify(errors), { cause: error });
      });
    await settle();
    const cold = await page.evaluate(() => {
      const host = window as any;
      host.stopHeadingSamples();
      return { rows: host.readHeadingNumbers(), samples: host.headingSamples, replies: host.syntaxReplies,
        large: host.MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(host.ed.view.state) };
    });
    assert.equal(cold.large, large, name + ': actual production derived-work budget');
    if (large) assert.ok(cold.replies > initialReplies, name + ': real Markdown Worker publication');
    if (name !== 'deep') assert.equal(cold.rows.length, 8, name + ': all six ATX and both Setext headings');
    const aligned = (rows: Array<{ line: number; offset: number | null }>, stage: string) => {
      assert.ok(rows.length > 0, name + '/' + stage + ': missing heading witnesses');
      assert.deepEqual(rows.filter(row => row.offset === null || !Number.isFinite(row.offset) || Math.abs(row.offset) > 1), [],
        name + '/' + stage + ': heading numbers must be vertically centered');
    };
    aligned(cold.rows, 'cold');
    aligned(cold.samples, 'cold frames');
    if (name === 'optimized' && process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'heading-line-numbers.png') });
    }
    const editAt = await page.evaluate(line => {
      const view = (window as any).ed.view;
      view.dispatch({ selection: { anchor: view.state.doc.line(line).to } }); view.focus();
      return view.state.selection.main.head;
    }, targetLine);
    await page.keyboard.press('1'); await settle();
    assert.ok(await page.evaluate(() => (window as any).ed.getText()) === text.slice(0, editAt) + '1' + text.slice(editAt),
      name + ': native input reaches the heading');
    aligned(await page.evaluate(() => (window as any).readHeadingNumbers()), 'input');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await settle();
    assert.equal(await page.evaluate(() => (window as any).ed.getText()), text, name + ': undo restores source');
    if (large) {
      await page.evaluate(() => { const ed = (window as any).ed; ed.scrollToLine(ed.view.state.doc.lines - 2, 'top'); });
      await settle();
      assert.equal(await page.evaluate(line => (window as any).readHeadingNumbers().some((row: any) => row.line === line), targetLine),
        false, name + ': target heading unmounted');
      await page.evaluate(line => (window as any).ed.scrollToLine(Math.max(1, line - 2), 'top'), targetLine);
      await page.waitForFunction(line => (window as any).readHeadingNumbers().some((row: any) => row.line === line), {}, targetLine);
      await settle();
      aligned(await page.evaluate(() => (window as any).readHeadingNumbers()), 'remount');
    }
    await page.evaluate(() => (window as any).ed.destroy());
    console.log(`Heading line numbers: ${name}, cold frames, input/undo and ${large ? 'Worker/remount' : 'synchronous'} passed`);
  }
  await page.evaluate(() => {
    const host = window as any;
    host.ed = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), initialMode: 'live',
      text: 'Before\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n<details open>\n<summary>Summary</summary>\n<p>HTML row</p>\n</details>\n\nAfter', onApplyChanges() {} });
  });
  await page.waitForSelector('.meo-mermaid-block svg'); await settle();
  await page.evaluate(()=>{const w=window as any;w.nativeMermaidRows=()=>{const v=w.ed.view;return [4,5].flatMap(n=>{const pos=v.state.doc.line(n).from,node=v.domAtPos(pos).node;const line=(node.nodeType===1?node as Element:node.parentElement)?.closest<HTMLElement>('.cm-line.meo-md-code-block');if(!line)return [];const top=line.getBoundingClientRect().top;const number=Array.from(v.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement')).find(e=>e.style.visibility!=='hidden'&&Math.abs(e.getBoundingClientRect().top-top)<1);return [{line,number}];});};});
  const transitionFrames = await page.evaluate(async () => {
    const samples: number[][] = [];
    const pending = new Promise<void>(resolve => {
      const sample = () => requestAnimationFrame(() => setTimeout(() => {
        const rows=(window as any).nativeMermaidRows();
        samples.push(rows.map(({line,number}:any)=>number?number.getBoundingClientRect().top-line.getBoundingClientRect().top:NaN));
        if (samples.length < 8) sample(); else resolve();
      }, 0));
      sample();
    });
    document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
    await pending; return samples;
  });
  assert.ok(transitionFrames.every(rows => rows.length === 2 && rows.every(offset => Number.isFinite(offset) && Math.abs(offset) <= 1)),
    'The first split frame must already contain aligned source numbers: ' + JSON.stringify(transitionFrames));
  for (const mode of ['on', 'relative', 'interval', 'off', 'on'] as const) {
    await page.evaluate(mode => {
      const host = window as any;
      host.ed.setSourceLineNumbers(mode);
      host.ed.view.dispatch({ selection: { anchor: host.ed.view.state.doc.line(4).from } });
    }, mode); await settle();
    const rows = await page.evaluate(() => {
      const host = window as any;
      const visible = (element: HTMLElement) => getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().height > 0;
      return { current: host.ed.view.state.doc.lineAt(host.ed.view.state.selection.main.head).number,
        mermaid: host.nativeMermaidRows().map(({number}:any)=>number?.textContent).filter(Boolean),
        html: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-details-line-number')).filter(visible).map(element => element.textContent).filter(Boolean) };
    });
    const number = (line: number) => mode === 'off' ? '' : mode === 'relative'
      ? String(line === rows.current ? line : Math.abs(line - rows.current))
      : mode === 'interval' && line !== rows.current && line % 10 !== 0 ? '' : String(line);
    assert.deepEqual(rows.mermaid, [4, 5].map(number).filter(Boolean), `${mode}: Mermaid document line numbers`);
    assert.deepEqual(rows.html, [9, 10].map(number).filter(Boolean), `${mode}: HTML document line numbers`);
  }
  for (const current of [1, 9, 13]) {
    await page.evaluate(current => {
      const host = window as any;
      host.ed.setSourceLineNumbers('relative');
      host.ed.view.dispatch({ selection: { anchor: host.ed.view.state.doc.line(current).from } });
    }, current); await settle();
    const labels = await page.evaluate(() => {
      const gutter = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .filter(element => element.getBoundingClientRect().height > 0);
      return {
        mermaid: (window as any).nativeMermaidRows().map(({number}:any)=>number?.textContent),
        html: Array.from(document.querySelectorAll('.meo-md-html-details-line-number')).map(element => element.textContent),
        source: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-source-range')).map(line =>
          gutter.find(element => Math.abs(element.getBoundingClientRect().top - line.getBoundingClientRect().top) < 1)?.textContent)
      };
    });
    const relative = (line: number) => String(line === current ? line : Math.abs(line - current));
    assert.deepEqual(labels.mermaid, [], `Mermaid relative numbers after caret moves to ${current}`);
    assert.deepEqual(labels.html, current === 9 ? [] : [9, 10].map(relative), `HTML projected numbers after caret moves to ${current}`);
    assert.deepEqual(labels.source, current === 9 ? [8, 9, 10, 11].map(relative) : [], `HTML source numbers after caret moves to ${current}`);
  }
  await page.evaluate(() => {const e=(window as any).ed;e.setSourceLineNumbers('on');e.view.dispatch({selection:{anchor:e.view.state.doc.line(4).from}});}); await settle();
  await page.evaluate(() => {
    const host = window as any;
    host.paintSamples = []; host.observePaint = true;
    host.originalNumberNodes = host.nativeMermaidRows().map(({number}:any)=>number);
    if (host.originalNumberNodes.length !== 2) throw new Error('Missing source-number node witnesses');
    const read = () => {
      return host.nativeMermaidRows().map(({line,number}:any)=>({content:line.getBoundingClientRect().top,gutter:number?.getBoundingClientRect().top??NaN}));
    };
    const sample = () => {
      if (!host.observePaint) return;
      setTimeout(() => { if (host.observePaint) host.paintSamples.push(read()); }, 0);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const client = await page.createCDPSession();
  for (const width of [520, 1100]) {
    await page.setViewport({ width, height: 950 }); await settle();
    await page.evaluate(()=>{const v=(window as any).ed.view;v.dispatch({selection:{anchor:v.state.doc.line(5).to}});v.focus();});
    await page.keyboard.press('End');
    for (const key of ['1', 'Backspace']) {
      const pending: Promise<unknown>[] = [];
      for (let index = 0; index < 45; index++) {
        pending.push(client.send('Input.dispatchKeyEvent', { type: 'keyDown', key,
          code: key === '1' ? 'Digit1' : 'Backspace', windowsVirtualKeyCode: key === '1' ? 49 : 8,
          ...(key === '1' ? { text: '1', unmodifiedText: '1' } : {}), autoRepeat: index > 0 }));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await Promise.all(pending);
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === '1' ? 'Digit1' : 'Backspace' });
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--meo-font-source-size', '18px')); await settle();
    await page.evaluate(() => document.documentElement.style.setProperty('--meo-font-source-size', '14px')); await settle();
  }
  const paint = await page.evaluate(() => {
    const host = window as any; host.observePaint = false;
    return { count: host.paintSamples.length, bad: host.paintSamples.flat().filter((row: any) =>
      !Number.isFinite(row.gutter) || Math.abs(row.gutter - row.content) > 1).slice(0, 5) };
  });
  assert.ok(paint.count > 60, 'Missing intermediate projection frames');
  assert.deepEqual(paint.bad, [], 'Mermaid native rows and document projection must move together');
  const idleMutations = await page.evaluate(async () => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    for (const column of document.querySelectorAll('.cm-lineNumbers,.meo-md-html-details-line-number-column'))
      observer.observe(column, { attributes: true, childList: true, characterData: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 200)); observer.disconnect(); return changes;
  });
  assert.equal(idleMutations, 0, 'Settled line-number projection must stop rewriting DOM');
  await page.evaluate(() => { (window as any).ed.destroy(); }); await settle();
  assert.deepEqual(errors, []);
  console.log(`Line-number layout contract passed: shared settings, resize/font changes and ${paint.count} passive projection frames`);
} catch (error) { primary = error; } finally {
  if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary);
}
