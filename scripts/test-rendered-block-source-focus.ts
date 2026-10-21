import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
const build = await Bun.build({
  entrypoints: ['scripts/test-mermaid-editing-entry.ts'],
  target: 'browser',
  format: 'iife'
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 8; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
  for (const width of [520, 1100])
    for (const prefix of ['', '  ', '    ', '> ', '>   ']) {
      await page.setViewport({ width, height: 800 });
      await page.evaluate((prefix) => {
        const w = window as any;
        w.ed?.destroy();
        document.getElementById('app')!.replaceChildren();
        w.mermaid = {
          initialize() {},
          async render() {
            return { svg: '<svg viewBox="0 0 200 100"></svg>' };
          }
        };
        const before =
          prefix === '  '
            ? 'Before\n\n- Parent\n\n'
            : prefix === '    '
              ? 'Before\n\n- Parent\n  - Child\n\n'
              : prefix === '>   '
                ? 'Before\n\n> - Parent\n>\n'
                : 'Before\n\n';
        w.ed = w.MermaidEditingHarness.createEditor({
          parent: document.getElementById('app'),
          text: before + ['```mermaid', 'graph LR', 'A-->B', '```'].map((s) => prefix + s).join('\n') + '\n\nAfter',
          initialMode: 'live',
          onApplyChanges() {}
        });
      }, prefix);
      await frames();
      for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
        const expected = await page.evaluate((key) => {
          const e = (window as any).ed,
            view = e.view,
            text = e.getText();
          const opening = view.state.doc.lineAt(text.indexOf('```mermaid'));
          const closing = view.state.doc.line(opening.number + 3);
          const forward = key === 'ArrowRight' || key === 'ArrowDown';
          const outside = view.state.doc.line(forward ? opening.number - 1 : closing.number + 1);
          view.dispatch({ selection: { anchor: forward ? outside.to : outside.from } });
          view.focus();
          return { from: opening.from, to: closing.to, entryLine: forward ? opening.number : closing.number,
            exit: forward ? closing.to : opening.from, forward };
        }, key);
        await frames();
        await page.keyboard.press(key);
        await frames();
        const actual = await page.evaluate(() => {
          const e = (window as any).ed;
          return {
            head: e.view.state.selection.main.head,
            line: e.view.state.doc.lineAt(e.view.state.selection.main.head).number,
            focus: e.view.hasFocus,
            count: e.view.dom.querySelectorAll('.cm-content[contenteditable="true"]').length,
            mode: (e.view.dom.querySelector('.meo-mermaid-toolbar') as HTMLElement)?.dataset.meoMermaidMode
          };
        });
        assert.equal(actual.focus, true, `${width}/${prefix}/${key}: main input retains focus`);
        assert.equal(actual.count, 1);
        assert.equal(actual.line, expected.entryLine, `${width}/${prefix}/${key}: enters through fence ${JSON.stringify(actual)}`);
        assert.equal(actual.mode, 'edit', `${width}/${prefix}/${key}: fence is part of editing`);
        await page.evaluate(position => (window as any).ed.view.dispatch({ selection: { anchor: position } }), expected.exit);
        await frames();
        assert.equal(await page.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'edit', 'Boundary fence remains editable');
        await page.keyboard.press(key);
        await frames();
        const exited = await page.evaluate(() => (window as any).ed.view.state.selection.main.head);
        assert.ok(expected.forward ? exited > expected.to : exited < expected.from, `${key}: leaves whole block`);
        assert.equal(
          await page.$eval('.meo-mermaid-toolbar', (e) => (e as HTMLElement).dataset.meoMermaidMode),
          'preview',
          `${key}: collapses only after leaving fence`
        );
      }
    }
  for (const text of ['```mermaid\ngraph LR\nA-->B\n```', '~~~mermaid\ngraph LR\nA-->B', '> ```mermaid\n> graph LR\n> A-->B\n> ```']) {
    await page.evaluate(text => {
      const w = window as any;
      w.ed.destroy();
      document.getElementById('app')!.replaceChildren();
      w.ed = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {} });
      w.ed.view.focus();
    }, text);
    await frames();
    for (const close of ['Escape', 'button']) {
      if (close === 'Escape') await page.keyboard.press('Escape');
      else await page.$eval('.meo-mermaid-mode-btn', e => (e as HTMLElement).click());
      await frames();
      assert.equal(await page.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'preview', `${close}: explicit close works at document edge`);
      assert.equal(await page.evaluate(() => (window as any).ed.getText()), text, 'Closing adds no document newline');
      await page.$eval('.meo-mermaid-mode-btn', e => (e as HTMLElement).click());
      await frames();
      assert.equal(await page.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'edit', 'Explicit reopening works');
    }
  }
  await page.evaluate(() => {
    const w = window as any;
    w.ed.destroy();
    document.getElementById('app')!.replaceChildren();
    const text = 'Long prose '.repeat(60) + '\n~~~mermaid\ngraph LR\nA-->B\n~~~\nAfter';
    w.ed = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {} });
    w.ed.view.dispatch({ selection: { anchor: 0 } });
    w.ed.view.focus();
  });
  await frames();
  await page.keyboard.press('ArrowDown');
  await frames();
  assert.equal(await page.evaluate(() => (window as any).ed.view.state.doc.lineAt((window as any).ed.view.state.selection.main.head).number), 1, 'Wrapped prose moves within its visual lines');
  assert.equal(await page.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'preview');
  await page.evaluate(() => { const v = (window as any).ed.view; v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }); });
  await page.keyboard.press('ArrowDown');
  await frames();
  assert.equal(await page.evaluate(() => (window as any).ed.view.state.doc.lineAt((window as any).ed.view.state.selection.main.head).number), 2, 'Wrapped prose enters opening tilde fence from final visual line');
  assert.equal(await page.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'edit');
  assert.deepEqual(errors, []);
  console.log('Native Mermaid focus passed: four-direction entry/exit, five containers, two widths, one main input');
} catch (error) {
  failure = error;
}
if (failure === undefined) await closeTestBrowser(browser);
else await closeTestBrowser(browser, failure);
