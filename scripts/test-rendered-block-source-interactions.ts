import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
const build = await Bun.build({
  entrypoints: ['scripts/test-mermaid-editing-entry.ts'],
  target: 'browser',
  format: 'iife'
});
assert.ok(build.success);
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const p = await browser.newPage();
  await p.setViewport({ width: 1100, height: 800 });
  await p.setContent('<style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await p.addStyleTag({ path: 'webview/src/styles.css' });
  await p.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = () =>
    p.evaluate(async () => {
      for (let i = 0; i < 8; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
  const read = () =>
    p.evaluate(() => {
      const e = (window as any).ed;
      return {
        text: e.getText(),
        head: e.view.state.selection.main.head,
        anchor: e.view.state.selection.main.anchor,
        focus: e.view.hasFocus
      };
    });
  const select = async (from: number, to = from) => {
    await p.evaluate(
      ({ from, to }) => {
        const v = (window as any).ed.view;
        v.dispatch({ selection: { anchor: from, head: to } });
        v.focus();
      },
      { from, to }
    );
    await frames();
  };
  for (const prefix of ['', '> ', '    ']) {
    const text =
      (prefix === '    ' ? 'Before[^1]\n\n[^1]: Note\n\n' : 'Before\n\n') +
      ['```mermaid', 'graph LR', 'A[Original]-->B', '```'].map((s) => prefix + s).join('\n') +
      '\n\nAfter';
    await p.evaluate((text) => {
      const w = window as any;
      w.ed?.destroy();
      document.getElementById('app')!.replaceChildren();
      w.mermaid = {
        initialize() {},
        async render() {
          return { svg: '<svg viewBox="0 0 200 100"></svg>' };
        }
      };
      w.ed = w.MermaidEditingHarness.createEditor({
        parent: document.getElementById('app'),
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await frames();
    const from = text.indexOf('graph LR'),
      to = text.indexOf('A[Original]-->B') + 'A[Original]-->B'.length;
    await select(from);
    await p.keyboard.press('Backspace');
    await frames();
    assert.notEqual((await read()).text, text, 'Backspace at body start uses native deletion');
    await p.evaluate(() => (window as any).ed.undo());
    await frames();
    assert.equal((await read()).text, text, 'Native undo restores opening boundary');
    await select(to);
    await p.keyboard.press('Delete');
    await frames();
    assert.notEqual((await read()).text, text, 'Delete at body end uses native deletion');
    await p.evaluate(() => (window as any).ed.undo());
    await frames();
    assert.equal((await read()).text, text, 'Native undo restores closing boundary');
    for (const position of [text.indexOf('mermaid') + 'mermaid'.length, text.lastIndexOf('```') + 2]) {
      await select(from);
      const point = await p.evaluate(position => {
        const rect = (window as any).ed.view.coordsAtPos(position, -1);
        return { x: rect.left + 0.5, y: (rect.top + rect.bottom) / 2 };
      }, position);
      await p.mouse.click(point.x, point.y);
      await frames();
      assert.equal((await read()).head, position, 'Mouse can place the native caret in either fence');
      assert.equal(await p.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'edit', 'Fence caret keeps editing open');
      await p.keyboard.type('x');
      await frames();
      assert.equal((await read()).text, text.slice(0, position) + 'x' + text.slice(position), 'Both fences accept native text input');
      await p.evaluate(() => (window as any).ed.undo());
      await frames();
      assert.equal((await read()).text, text, 'Undo restores edited fence and Mermaid identity');
      assert.equal(await p.$eval('.meo-mermaid-toolbar', e => (e as HTMLElement).dataset.meoMermaidMode), 'edit');
    }
    await select(from);
    await p.keyboard.down('Shift');
    await p.keyboard.press('ArrowUp');
    await p.keyboard.up('Shift');
    await frames();
    const cross = await read();
    assert.equal(cross.anchor, from);
    assert.ok(cross.head < from, 'Native selection crosses source boundary');
    await select(from, to);
    await p.evaluate(() => (window as any).ed.pastePlainText('graph LR\nA[中文]-->B\n\nB-->C'));
    await frames();
    assert.ok(
      (await read()).text.includes('graph LR\n' + prefix + 'A[中文]-->B\n' + prefix + '\n' + prefix + 'B-->C'),
      'Multiline paste preserves container and blank rows'
    );
    await p.evaluate(() => (window as any).ed.undo());
    await frames();
    assert.equal((await read()).text, text, 'One native undo restores pasted selection');
    await select(from);
    await p.keyboard.down('Control');
    await p.keyboard.press('a');
    await p.keyboard.up('Control');
    await frames();
    const all = await read();
    assert.equal(Math.min(all.anchor, all.head), 0);
    assert.equal(Math.max(all.anchor, all.head), text.length, 'Native Ctrl+A selects main document');
    await p.$eval('.meo-select-all-code-btn', (e) => (e as HTMLElement).click());
    await frames();
    const body = await read();
    assert.equal(body.anchor, from);
    assert.equal(body.head, to, 'Toolbar All selects only Mermaid body');
    await p.keyboard.press('Escape');
    await frames();
    assert.equal(await p.$eval('.meo-mermaid-toolbar', (e) => (e as HTMLElement).dataset.meoMermaidMode), 'preview');
  }
  const mixed =
    'Before\n\n```mermaid\ngraph LR\nA[First]-->B\n```\n\nMiddle\n\n```mermaid\ngraph LR\nC[Second]-->D\n```\n\nAfter';
  await p.evaluate((text) => {
    const w = window as any;
    w.ed.destroy();
    document.getElementById('app')!.replaceChildren();
    w.ed = w.MermaidEditingHarness.createEditor({
      parent: document.getElementById('app'),
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, mixed);
  await frames();
  const snapshots = [mixed];
  for (const [needle, replacement] of [
    ['First', 'First edited'],
    ['Middle', 'Middle edited'],
    ['Second', 'Second edited']
  ]) {
    const current = await read(),
      from = current.text.indexOf(needle!);
    await select(from, from + needle!.length);
    await p.evaluate((text) => (window as any).ed.pastePlainText(text), replacement!);
    await frames();
    snapshots.push((await read()).text);
  }
  for (const direction of ['undo', 'redo']) {
    for (const index of direction === 'undo' ? [2, 1, 0] : [1, 2, 3]) {
      assert.equal(await p.evaluate((direction) => (window as any).ed[direction](), direction), true);
      await frames();
      assert.equal((await read()).text, snapshots[index]);
      assert.equal((await read()).focus, true);
    }
  }
  console.log(
    'Native Mermaid source interactions passed: editable fences, native boundary deletion/undo, cross-boundary selection, paste/undo, select-all and Escape'
  );
} catch (error) {
  failure = error;
}
if (failure === undefined) await closeTestBrowser(browser);
else await closeTestBrowser(browser, failure);
