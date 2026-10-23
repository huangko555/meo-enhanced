// Run through the isolated native launcher; no user's workspace/profile is opened.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

exports.run = async () => {
  const output = process.env.MEO_HTML_COPY_OUTPUT;
  assert.ok(output && path.isAbsolute(output));
  const workspace = path.join(output, 'workspace');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), workspace.toLowerCase());
  const html = '<ul>\n  <li>第一项。</li>\n  <li>第二项 <strong>强调</strong>。</li>\n</ul>';
  const math = '$$\nx^2 + y^2\n$$';
  const text = `Before.\n\n<div><p>Visible paragraph.</p><p hidden>Hidden tail.</p></div>\n\n${html}\n\nBetween.\n\n${math}\n\nAfter.`;
  const file = path.join(workspace, 'html-copy.md');
  fs.writeFileSync(file, text);
  const report = { vscode: vscode.version, runs: [], passed: false, phase: 'connect' };
  const previousClipboard = await vscode.env.clipboard.readText();
  let browser;
  const waitFor = async (predicate, label, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
      if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  try {
    browser = await puppeteer.connect({ browserURL: process.env.MEO_HTML_COPY_BROWSER_URL, defaultViewport: null });
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor');
    report.phase = 'find-webview';
    let frame;
    await waitFor(async () => {
      report.phase = 'list-pages';
      const pages = await browser.pages();
      report.phase = 'find-content-frame';
      for (const page of pages) for (const candidate of page.frames()) {
        // The outer webview boot frame has no usable evaluation context during
        // cross-process startup. Its fake.html child owns the actual document.
        if (!candidate.url().includes('/fake.html')) continue;
        try {
          if (await candidate.evaluate(() => !!document.querySelector('.editor-host .cm-content')
            && !document.querySelector('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'))) { frame = candidate; return true; }
        } catch (error) {
          if (!/detached|Execution context was destroyed|Cannot find context/i.test(String(error))) throw error;
        }
      }
      return false;
    }, 'MEO webview', 30000);
    report.phase = 'switch-live';
    await frame.$eval('[data-mode="live"]', button => button.click());
    const page = frame.page();
    const settle = () => frame.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame); });
    const chord = async key => {
      await page.keyboard.down('Control');
      try { await page.keyboard.press(key); } finally { await page.keyboard.up('Control'); }
    };
    for (const [kind, block] of [['html', html], ['math', math]]) {
      report.phase = `${kind}-select`;
      await frame.evaluate(block => {
        // Read CodeMirror's mounted view; no test globals are added to production.
        const view = document.querySelector('.editor-host .cm-content').cmView.rootView.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(block) + 5 }, scrollIntoView: true });
        view.focus();
      }, block);
      await settle();
      const points = await frame.evaluate(block => {
        const view = document.querySelector('.editor-host .cm-content').cmView.rootView.view;
        const from = view.state.doc.toString().indexOf(block), to = from + block.length;
        const first = view.coordsAtPos(from), last = view.coordsAtPos(to);
        return { from, to, first: { x: first.left + 0.5, y: (first.top + first.bottom) / 2 },
          last: { x: last.left + 0.5, y: (last.top + last.bottom) / 2 } };
      }, block);
      // Electron's webview frame crosses CDP targets; frameElement() can ask
      // DOM.getFrameOwner on the wrong target. The isolated workbench has one
      // visible webview mount, whose native bounds provide the page offset.
      const mounts = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(node => {
        const r = node.getBoundingClientRect();
        return { x: r.left + node.clientLeft, y: r.top + node.clientTop, width: r.width, height: r.height };
      }).filter(r => r.width > 0 && r.height > 0));
      assert.equal(mounts.length, 1, 'The isolated workbench has exactly one visible webview');
      const offset = mounts[0];
      await page.mouse.move(offset.x + points.first.x, offset.y + points.first.y); await page.mouse.down();
      await page.mouse.move(offset.x + points.last.x, offset.y + points.last.y, { steps: 14 }); await page.mouse.up(); await settle();
      const selected = await frame.evaluate(() => {
        const content = document.querySelector('.editor-host .cm-content'), view = content.cmView.rootView.view;
        const range = view.state.selection.main;
        return { text: view.state.sliceDoc(range.from, range.to), focused: document.activeElement === content, native: window.getSelection()?.toString() };
      });
      assert.equal(selected.text, block, `${kind}: real mouse drag selects the entire source`);
      assert.ok(selected.focused, `${kind}: source owns keyboard focus`);
      for (const route of ['Ctrl+C', 'host-command']) {
        report.phase = `${kind}-${route}`;
        const sentinel = `MEO_COPY_SENTINEL_${kind}_${route}`;
        await vscode.env.clipboard.writeText(sentinel);
        if (route === 'Ctrl+C') await chord('KeyC');
        else await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        await waitFor(async () => await vscode.env.clipboard.readText() !== sentinel, `${kind}: ${route} clipboard write`);
        assert.equal((await vscode.env.clipboard.readText()).replaceAll('\r\n', '\n'), block, `${kind}: ${route} native clipboard contents`);
        report.runs.push({ kind, route, sourceCharacters: block.length, exact: true });
      }
      report.phase = `${kind}-paste`;
      await chord('KeyV'); await settle();
      assert.equal(await frame.evaluate(() => document.querySelector('.editor-host .cm-content').cmView.rootView.view.state.doc.toString()), text,
        `${kind}: native paste retains the exact raw HTML/TeX`);
      report.runs.push({ kind, route: 'Ctrl+V', exact: true });
    }
    report.phase = 'cross-block-copy';
    await frame.$eval('.editor-host .cm-content', content => content.focus({ preventScroll: true }));
    await chord('KeyA'); await settle(); await chord('KeyC');
    await waitFor(async () => (await vscode.env.clipboard.readText()).replaceAll('\r\n', '\n') === text, 'cross-block source copy');
    report.runs.push({ kind: 'cross-block', route: 'Ctrl+A, Ctrl+C', exact: true });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.getText().replaceAll('\r\n', '\n'), text, 'The Host document retains raw source');
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'Clipboard checks do not save or rewrite the fixture');
    await page.screenshot({ path: path.join(output, 'source-copy.png') });
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (browser) try { await (await browser.pages())[0]?.screenshot({ path: path.join(output, 'failure.png') }); } catch {}
    throw error;
  } finally {
    browser?.disconnect();
    await vscode.env.clipboard.writeText(previousClipboard);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  }
};
