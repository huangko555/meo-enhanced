import { enterMermaidSource, findMermaidOpening, setMermaidLayout } from './history-mermaid-chromium';
import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-mermaid-editing-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent('<!doctype html><button id="outside">Outside</button><div id="app" style="height:750px"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    (window as any).mermaid = {
      initialize() {},
      async render() {
        return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>' };
      }
    };
  });
  const failures: string[] = [];
  const check = (label: string, actual: unknown, expected: unknown) => {
    try { assert.deepEqual(actual, expected); }
    catch { failures.push(label + ': ' + JSON.stringify({ actual, expected })); }
  };
  const frames = (count = 4) => page.evaluate(async (count) => {
    for (let index = 0; index < count; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
  const create = async (text: string) => {
    await page.evaluate((text) => {
      (window as any).editor?.destroy();
      const parent = document.getElementById('app')!;
      parent.replaceChildren();
      (window as any).editor = (window as any).MermaidEditingHarness.createEditor({
        parent, text, initialMode: 'live', onApplyChanges() {}
      });
    }, text);
    await frames();
  };
  const switchMode = async (mode: 'live' | 'source') => {
    await page.evaluate((mode) => {
      const editor = (window as any).editor;
      editor.setMode(mode, editor.captureModeTransitionAnchorToken('editor'));
      editor.focus();
    }, mode);
    await frames();
  };
  const click = async (selector: string) => {
    await page.evaluate((selector) => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error('Missing control ' + selector);
      button.click();
    }, selector);
    await frames();
  };
  const outerSelection = () => page.evaluate(() => {
    const view = (window as any).editor.view;
    const selection = view.state.selection.main;
    return { anchor: selection.anchor, head: selection.head, focused: document.activeElement === view.contentDOM };
  });
  for (const scenario of [
    { layout: 'side-by-side', edited: false, blurred: false, prefix: '', range: false },
    { layout: 'stacked', edited: true, blurred: false, prefix: '', range: true },
    { layout: 'side-by-side', edited: true, blurred: true, prefix: '    ', range: true }
  ] as const) {
    const block = ['```mermaid', 'graph TD', 'A --> B', 'B --> C', '```'].map(line => scenario.prefix + line);
    const intro = scenario.prefix ? ['intro', '', '- Parent', '', '  - Child', ''] : ['intro', ''];
    await create([...intro, ...block, '', 'tail'].join('\n'));
    const opening = await findMermaidOpening(page, 'editor', 'graph TD');
    await setMermaidLayout(page, 'editor', opening, scenario.layout);
    const bounds = await enterMermaidSource(page, 'editor', opening);
    const base = bounds.from + scenario.prefix.length;
    if (scenario.edited) {
      await page.evaluate(position => (window as any).editor.revealSelection(position, position, { focusEditor: true, align: 'none' }), base + 3);
      await page.keyboard.type(' ');
    }
    const head = base + 3, anchor = head + (scenario.range ? 3 : 0);
    await page.evaluate(({ anchor, head }) => {
      const v = (window as any).editor.view; v.dispatch({ selection: { anchor, head } }); v.focus();
    }, { anchor, head });
    const expected = { anchor, head, focused: true };
    check('Initial native selection', await outerSelection(), expected);
    if (scenario.blurred) await page.focus('#outside');
    await switchMode('source'); check('Source preserves document selection', await outerSelection(), expected);
    await switchMode('live'); check('Live preserves document selection', await outerSelection(), expected);
    check('Live restores selected layout', !!await page.$('.meo-mermaid-inline-preview'), scenario.layout === 'side-by-side');
    await switchMode('source');
    await page.evaluate(position => (window as any).editor.view.dispatch({ selection: { anchor: position } }), base + 2);
    await switchMode('live');
    check('Source navigation within the block wins', await outerSelection(), { anchor: base + 2, head: base + 2, focused: true });
    await switchMode('source');
    await page.evaluate(() => {
      const v = (window as any).editor.view;
      v.dispatch({ changes: { from: 0, insert: 'lead\n' }, selection: { anchor: v.state.selection.main.head + 5 } });
    });
    await switchMode('live');
    check('Source edits map native document position', await outerSelection(), { anchor: base + 7, head: base + 7, focused: true });
    await switchMode('source');
    const tail = await page.evaluate(() => {
      const v = (window as any).editor.view, pos = v.state.doc.toString().indexOf('tail') + 2;
      v.dispatch({ selection: { anchor: pos } }); return pos;
    });
    await switchMode('live');
    check('Source navigation outside the block wins', await outerSelection(), { anchor: tail, head: tail, focused: true });
    check('Leaving the block closes native source', await page.$('.meo-mermaid-editing-preview'), null);
  }

  const html = 'intro\n\n<div>\n<p>alpha beta gamma</p>\n</div>\n\ntail';
  const htmlHead = html.indexOf('beta') + 2;
  await create(html);
  await page.click('.meo-md-html-content');
  await page.evaluate((head) => {
    const view = (window as any).editor.view;
    view.dispatch({ selection: { anchor: head + 2, head } });
    view.focus();
  }, htmlHead);
  await switchMode('source');
  await switchMode('live');
  check('HTML restores source and live result', await page.evaluate(() => ({
    preview: !!document.querySelector('.meo-md-html-block'),
    source: !!document.querySelector('.meo-md-html-source-range')
  })), { preview: true, source: true });
  check('HTML keeps logical selection', await outerSelection(), { anchor: htmlHead + 2, head: htmlHead, focused: true });
  await page.click('.meo-md-html-live-result');
  check('Reopening HTML source keeps selection', await outerSelection(), { anchor: htmlHead + 2, head: htmlHead, focused: true });

  for (const operation of ['type', 'Enter', 'Backspace', 'Delete', 'paste', 'cut', 'composition']) {
    await create(html);
    await switchMode('source');
    await page.evaluate(({ head, operation }) => (window as any).editor.view.dispatch({
      selection: { anchor: operation === 'cut' ? head + 2 : head, head }
    }), { head: htmlHead, operation });
    await switchMode('live');
    if (operation === 'type') await page.keyboard.type('Z');
    else if (operation === 'paste' || operation === 'cut') {
      await page.evaluate((operation) => {
        const view = (window as any).editor.view;
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'Z');
        view.contentDOM.dispatchEvent(new ClipboardEvent(operation, { clipboardData, bubbles: true, cancelable: true }));
      }, operation);
    } else if (operation === 'composition') {
      const input = await page.createCDPSession();
      try {
        await input.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
        await input.send('Input.insertText', { text: '中' });
      } finally {
        await input.detach();
      }
    } else await page.keyboard.press(operation);
    await frames();
    const deletion = ['Backspace', 'Delete', 'cut'].includes(operation);
    const replacement = operation === 'Enter' ? '\n' : deletion ? '' : operation === 'composition' ? '中' : 'Z';
    const from = operation === 'Backspace' ? htmlHead - 1 : htmlHead;
    const to = htmlHead + (operation === 'Delete' ? 1 : operation === 'cut' ? 2 : 0);
    const text = html.slice(0, from) + replacement + html.slice(to);
    check('HTML reveals source before ' + operation, await page.evaluate(() => ({
      source: !!document.querySelector('.meo-md-html-source-range'),
      text: (window as any).editor.view.state.doc.toString()
    })), { source: true, text });
  }

  // A new source position must not reopen the old HTML editing target.
  await create(html);
  await switchMode('source');
  await page.evaluate(() => (window as any).editor.view.dispatch({ selection: { anchor: 2 } }));
  await switchMode('live');
  await page.keyboard.type('Z');
  await frames();
  check('New position outside HTML wins', await page.evaluate(() => ({
    source: !!document.querySelector('.meo-md-html-source-range'),
    text: (window as any).editor.view.state.doc.toString()
  })), { source: false, text: html.slice(0, 2) + 'Z' + html.slice(2) });

  await page.evaluate(() => (window as any).editor.destroy());
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('Mode selection continuity browser tests passed');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
  else await closeTestBrowser(browser);
}
