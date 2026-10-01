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
  const placeNestedSelection = async (selector: string, anchor: number, head: number) => {
    await page.evaluate((selector) => {
      const content = document.querySelector<HTMLElement>(selector);
      if (!content) throw new Error('Missing nested input ' + selector + ': ' + JSON.stringify({
        text: (window as any).editor.view.state.doc.toString(),
        toolbar: document.querySelector('.meo-mermaid-toolbar')?.outerHTML,
        body: document.querySelector('.cm-content')?.textContent
      }));
      content.focus();
    }, selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('Home');
    await page.keyboard.up('Control');
    for (let index = 0; index < anchor; index++) await page.keyboard.press('ArrowRight');
    await page.keyboard.down('Shift');
    for (let index = head; index < anchor; index++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await frames();
  };
  const nestedSelection = (selector: string) => page.evaluate((selector) => {
    const content = document.querySelector<HTMLElement>(selector);
    if (!content) return null;
    const selection = window.getSelection();
    const lines = Array.from(content.querySelectorAll<HTMLElement>(':scope > .cm-line'));
    const offset = (node: Node | null, nodeOffset: number): number => {
      let precedingLength = 0;
      for (const line of lines) {
        if (node && line.contains(node)) {
          const range = document.createRange();
          range.selectNodeContents(line);
          range.setEnd(node, nodeOffset);
          return precedingLength + range.toString().length;
        }
        precedingLength += (line.textContent?.length ?? 0) + 1;
      }
      return -1;
    };
    return {
      anchor: offset(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
      head: offset(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
      focused: document.activeElement === content,
      mode: content.closest('.meo-rendered-block-mode-shell')?.getAttribute('data-meo-rendered-block-mode')
    };
  }, selector);

  for (const scenario of [
    { kind: 'mermaid', mode: 'split', edited: false, blurred: false, prefix: '', range: false },
    { kind: 'mermaid', mode: 'source', edited: true, blurred: false, prefix: '', range: true },
    { kind: 'mermaid', mode: 'split', edited: true, blurred: true, prefix: '    ', range: true },
    { kind: 'latex', mode: 'split', edited: false, blurred: false, prefix: '', range: false },
    { kind: 'latex', mode: 'source', edited: true, blurred: true, prefix: '', range: true }
  ]) {
    const isMermaid = scenario.kind === 'mermaid';
    const block = isMermaid
      ? ['```mermaid', 'graph TD', 'A --> B', 'B --> C', '```'].map((line) => scenario.prefix + line)
      : ['$$', 'x^2 + y^2 = 1', '+ z^2', '$$'];
    const introduction = scenario.prefix ? ['intro', '', '- Parent', '', '  - Child', ''] : ['intro', ''];
    await create([...introduction, ...block, '', 'tail'].join('\n'));
    const button = isMermaid ? '.meo-mermaid-mode-btn' : '.meo-latex-math-mode-btn';
    const source = isMermaid ? '.meo-mermaid-source-editor .cm-content' : '.meo-latex-math-source-editor .cm-content';
    await click(button);
    if (scenario.mode === 'source') await click(button);
    if (scenario.edited) {
      await placeNestedSelection(source, 11, 11);
      await page.keyboard.type(' ');
    }
    const anchor = scenario.range ? 14 : 11;
    const head = 11;
    await placeNestedSelection(source, anchor, head);
    check('Initial nested selection ' + JSON.stringify(scenario), await nestedSelection(source), {
      anchor, head, focused: true, mode: scenario.mode
    });
    const expected = await page.evaluate(({ source, prefix, anchor, head }) => {
      const doc = (window as any).editor.view.state.doc.toString();
      const lines = Array.from(document.querySelectorAll<HTMLElement>(source + ' > .cm-line'))
        .map((line) => line.textContent ?? '');
      const position = (offset: number) => {
        for (const line of lines) {
          if (offset <= line.length) return doc.indexOf(prefix + line) + prefix.length + offset;
          offset -= line.length + 1;
        }
        throw new Error('Nested selection outside source');
      };
      return { anchor: position(anchor), head: position(head), focused: true };
    }, { source, prefix: scenario.prefix, anchor, head });
    if (scenario.blurred) await page.focus('#outside');
    await switchMode('source');
    check('Source selection ' + JSON.stringify(scenario), await outerSelection(), expected);
    await switchMode('live');
    check('Restored nested selection ' + JSON.stringify(scenario), await nestedSelection(source), {
      anchor, head, focused: true, mode: scenario.mode
    });

    await switchMode('source');
    await page.evaluate((isMermaid) => {
      const view = (window as any).editor.view;
      const text = view.state.doc.toString();
      view.dispatch({ selection: { anchor: text.indexOf(isMermaid ? 'graph TD' : 'x^2') + 3 } });
    }, isMermaid);
    await switchMode('live');
    check('Source position within block wins ' + JSON.stringify(scenario), await nestedSelection(source), {
      anchor: 3, head: 3, focused: true, mode: scenario.mode
    });

    await switchMode('source');
    await page.evaluate(() => {
      const view = (window as any).editor.view;
      view.dispatch({ changes: { from: 0, insert: 'lead\n' }, selection: { anchor: view.state.selection.main.head + 5 } });
    });
    await switchMode('live');
    check('Source edits map block mode and position ' + JSON.stringify(scenario), await nestedSelection(source), {
      anchor: 3, head: 3, focused: true, mode: scenario.mode
    });

    // Source navigation supersedes the selection saved in the old inner editor.
    await switchMode('source');
    const newPosition = await page.evaluate(() => {
      const view = (window as any).editor.view;
      const position = view.state.doc.toString().indexOf('tail') + 2;
      view.dispatch({ selection: { anchor: position } });
      return position;
    });
    await switchMode('live');
    check('Source navigation wins ' + JSON.stringify(scenario), await outerSelection(), {
      anchor: newPosition, head: newPosition, focused: true
    });
    check('Block mode remains selected ' + JSON.stringify(scenario), await page.evaluate((source) => (
      document.querySelector(source)?.closest('.meo-rendered-block-mode-shell')?.getAttribute('data-meo-rendered-block-mode') ?? null
    ), source), scenario.mode);
  }

  const html = 'intro\n\n<div>\n<p>alpha beta gamma</p>\n</div>\n\ntail';
  const htmlHead = html.indexOf('beta') + 2;
  await create(html);
  await click('.meo-md-html-source-toggle');
  await page.evaluate((head) => {
    const view = (window as any).editor.view;
    view.dispatch({ selection: { anchor: head + 2, head } });
    view.focus();
  }, htmlHead);
  await switchMode('source');
  await switchMode('live');
  check('HTML returns to rendered content', await page.evaluate(() => ({
    preview: !!document.querySelector('.meo-md-html-block'),
    source: !!document.querySelector('.meo-md-html-source-control')
  })), { preview: true, source: false });
  check('HTML keeps logical selection', await outerSelection(), { anchor: htmlHead + 2, head: htmlHead, focused: true });
  await click('.meo-md-html-source-toggle');
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
    const replacement = operation === 'Enter' ? '\n  ' : deletion ? '' : operation === 'composition' ? '中' : 'Z';
    const from = operation === 'Backspace' ? htmlHead - 1 : htmlHead;
    const to = htmlHead + (operation === 'Delete' ? 1 : operation === 'cut' ? 2 : 0);
    const text = html.slice(0, from) + replacement + html.slice(to);
    check('HTML reveals source before ' + operation, await page.evaluate(() => ({
      source: !!document.querySelector('.meo-md-html-source-control'),
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
    source: !!document.querySelector('.meo-md-html-source-control'),
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
