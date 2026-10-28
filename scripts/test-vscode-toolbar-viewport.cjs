// Programmatic navigation in the real Electron host. Browser pointer coverage
// lives in test-toolbar-viewport-stability.ts; this checks the embedding boundary.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

exports.run = async () => {
  const output = process.env.MEO_TOOLBAR_OUTPUT;
  assert.ok(output && path.isAbsolute(output));
  const workspace = path.join(output, 'workspace');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), workspace.toLowerCase());
  const large = process.env.MEO_TOOLBAR_LARGE === '1';
  const file = path.join(workspace, 'toolbar-viewport.md');
  const text = '# Document start\n\nReference[^note]. [Jump](#section-20).\n\n'
    + Array.from({ length: large ? 1600 : 60 }, (_, index) => `## Section ${index + 1}\n\n`
      + (index === 19 ? '[Return](#document-start)\n\n' : '')
      + 'Read the document without moving the window menu. '.repeat(8)).join('\n\n')
    + '\n\n[^note]: Footnote destination.\n';
  fs.writeFileSync(file, text);
  const report = { vscode: vscode.version, large, route: 'DOM activation in native Webview', cases: [], passed: false };
  let browser;
  try {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    browser = await puppeteer.connect({ browserURL: process.env.MEO_TOOLBAR_BROWSER_URL, defaultViewport: null });
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor');
    let frame;
    const deadline = Date.now() + 30000;
    while (!frame && Date.now() < deadline) {
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        // VS Code's bootstrap frame can have a pending execution context while
        // it installs the active content frame. Query only the content document.
        if (!candidate.url().includes('/fake.html')) continue;
        if (await candidate.evaluate(() => !!document.querySelector('.mode-toolbar')).catch(() => false)) frame = candidate;
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(frame, 'MEO active content frame required');
    await frame.waitForFunction(() => window.frameElement?.id === 'active-frame'
      && !document.querySelector('.meo-preload-toolbar'));
    const page = frame.page();
    page.setDefaultTimeout(10000);
    await frame.$eval('[data-mode="preview"]', element => element.click());
    await frame.waitForFunction(() => document.querySelector('#app')?.dataset.mode === 'preview'
      && document.querySelector('.preview-status')?.hidden
      && !!document.querySelector('.preview-frame')?.contentDocument?.getElementById('fnref-1'));
    report.optimized = await frame.$eval('.preview-frame', element => !!element.contentDocument.querySelector('[data-meo-preview-document]'));
    assert.equal(report.optimized, large, 'exercise the requested production rendering path');
    // ScrollTop inside the app can remain zero while Electron scrolls this
    // workbench-owned, clipped container by the iframe's inline baseline gap.
    await page.evaluate(() => {
      window.__toolbarHostTrace = { samples: [], stopped: false };
      const sample = () => {
        for (const element of document.querySelectorAll('iframe')) {
          const parent = element.parentElement;
          window.__toolbarHostTrace.samples.push({ scroll: parent.scrollTop,
            offset: element.getBoundingClientRect().top - parent.getBoundingClientRect().top });
        }
        if (!window.__toolbarHostTrace.stopped) requestAnimationFrame(sample);
      };
      sample();
    });
    await frame.evaluate(() => {
      window.__toolbarAppTrace = { samples: [], stopped: false };
      const sample = () => {
        const menu = document.querySelector('.mode-toolbar').getBoundingClientRect();
        window.__toolbarAppTrace.samples.push({ top: menu.top, height: menu.height,
          content: document.querySelector('.editor-wrapper').getBoundingClientRect().top });
        if (!window.__toolbarAppTrace.stopped) requestAnimationFrame(sample);
      };
      sample();
    });
    for (const zoom of ['default', 'zoomed']) {
      if (zoom === 'zoomed') await vscode.commands.executeCommand('workbench.action.zoomIn');
      for (const [selector, destination] of [
        ['[id="fnref-1"]', '.footnote-item'], ['.footnote-index', '[id="fnref-1"]'],
        ['[id="fnref-1"]', '.footnote-item'], ['.footnote-backref', '[id="fnref-1"]'],
        ['a[data-meo-preview-href="#section-20"]', '#section-20'],
        ['a[data-meo-preview-href="#document-start"]', '#document-start']
      ]) {
        await frame.evaluate(selector => {
          const element = document.querySelector('.preview-frame').contentDocument.querySelector(selector);
          if (!element) throw Error('Missing navigation link ' + selector);
          element.click();
        }, selector);
        await frame.waitForFunction(destination => {
          const document = window.document.querySelector('.preview-frame').contentDocument;
          const rect = document.querySelector(destination)?.getBoundingClientRect();
          return rect && rect.bottom > 0 && rect.top < document.documentElement.clientHeight;
        }, {}, destination);
        await frame.evaluate(async () => {
          for (let n = 0; n < 12; n++) await new Promise(resolve => requestAnimationFrame(resolve));
        });
        report.cases.push(zoom + ':' + selector);
      }
    }
    report.host = await page.evaluate(() => { window.__toolbarHostTrace.stopped = true; return window.__toolbarHostTrace.samples; });
    report.app = await frame.evaluate(() => { window.__toolbarAppTrace.stopped = true; return window.__toolbarAppTrace.samples; });
    assert.ok(report.host.length > 24 && report.app.length > 24, 'intermediate native frames required');
    assert.deepEqual(report.host.filter(sample => Math.abs(sample.scroll) > .5 || Math.abs(sample.offset) > .5), [],
      'Preview navigation scrolled the workbench Webview container');
    assert.deepEqual(report.app.filter(sample => Math.abs(sample.top) > .5 || Math.abs(sample.height - 40) > .5 || Math.abs(sample.content - 40) > .5), [],
      'Preview navigation moved the internal menu or document band');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.getText(), text);
    assert.equal(document.isDirty, false);
    await page.screenshot({ path: path.join(output, 'toolbar.png') });
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (browser) report.frames = await Promise.all((await browser.pages()).flatMap(page => page.frames()).filter(frame => frame.url().includes('/fake.html')).map(async frame => ({
      url: frame.url(), state: await frame.evaluate(() => ({ ready: document.readyState, toolbar: !!document.querySelector('.mode-toolbar'),
        frame: window.frameElement?.id, text: document.body?.innerText.slice(0, 160) })).catch(error => String(error))
    })));
    throw error;
  } finally {
    browser?.disconnect();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  }
};
