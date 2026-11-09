const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

exports.run = async () => {
  const output = process.env.MEO_OUTLINE_OUTPUT;
  assert.ok(output && path.isAbsolute(output));
  const result = { passed: false, cases: [] };
  const restoring = process.env.MEO_OUTLINE_PHASE === 'restore';
  const browser = await puppeteer.connect({ browserURL: process.env.MEO_OUTLINE_BROWSER_URL, defaultViewport: null });
  let page;
  try {
    page = (await browser.pages()).find(candidate => candidate.url().startsWith('vscode-file:'));
    assert.ok(page, 'A real VS Code workbench must be connected');
    page.setDefaultTimeout(15000);
    if (!restoring) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('workbench.action.joinAllGroups');
      // This full scenario moves the view out of Explorer. Start from that
      // layout even when a previous disposable-profile run already moved it.
      await vscode.commands.executeCommand('workbench.action.resetViewLocations');
      result.initialViewLocationsReset = true;
    }
    const file = path.join(output, 'workspace', 'outline.md');
    const headings = ['Native root', 'Native second', 'Native third', 'Native fourth', 'Native fifth', 'Native sixth'];
    fs.writeFileSync(file, headings.map((text, index) => `${'#'.repeat(index + 1)} ${text}\n\n${'Readable content.\n\n'.repeat(35)}`).join('\n'));
    await vscode.workspace.getConfiguration('meoEnhanced').update('language', 'en', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor');
    // Admit the editor that supplies this interactive native-tree scenario.
    // Cold first publication has its own independent production gate.
    const admissionStarted = performance.now();
    const expectedText = fs.readFileSync(file, 'utf8');
    const admissionDeadline = Date.now() + 30000;
    let admitted;
    while (!admitted && Date.now() < admissionDeadline) {
      for (const candidate of page.frames()) {
        admitted = await candidate.evaluate(({ expectedText, headings }) => {
          const root = document.querySelector('.editor-root');
          if (!root || document.visibilityState !== 'visible' || document.querySelector('.meo-preload-toolbar')) return null;
          const bounds = root.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return null;
          const mode = root.dataset.mode;
          if (mode === 'preview') {
            const host = document.querySelector('.preview-host');
            const doc = document.querySelector('.preview-frame')?.contentDocument;
            if (!host || host.hidden || host.inert || document.querySelector('.preview-loading')?.hidden !== true
              || doc?.documentElement.inert !== false || !headings.every(text => doc.querySelector('main.meo-export-doc')?.textContent.includes(text))) return null;
          } else {
            const host = document.querySelector('.editor-host');
            const view = host?.querySelector('.cm-content')?.cmTile?.root?.view;
            if (!['live', 'source'].includes(mode) || !host || host.hidden || host.inert
              || document.querySelector('.editor-loading')?.hidden !== true || view?.state.doc.toString() !== expectedText) return null;
          }
          return { mode, visible: true, interactive: true, width: bounds.width, height: bounds.height };
        }, { expectedText, headings }).catch(() => null);
        if (admitted) break;
      }
      if (!admitted) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(admitted, 'The exact visible, interactive outline fixture must be ready before native controls are tested');
    result.editorAdmission = { ...admitted, milliseconds: performance.now() - admissionStarted };
    await vscode.commands.executeCommand('meoEnhanced.outline.focus');
    const tree = '.monaco-list[aria-label="MEO Outline"]';
    const rows = `${tree} .monaco-list-rows > .monaco-list-row`;
    if (restoring) {
      await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Native root')), {}, rows);
      await page.evaluate(() => new Promise(resolve => {
        let count = 0;
        const next = () => ++count < 12 ? requestAnimationFrame(next) : resolve();
        requestAnimationFrame(next);
      }));
      // Custom TreeView does not persist its expansion model across workbench
      // restarts. Verify fresh publication rather than require an extension-owned
      // persistence mechanism that this feature does not otherwise need.
      assert.equal(await page.$$eval(rows, nodes => nodes.length), 6, 'fresh host restores the complete outline');
      assert.equal(await page.$$eval(`${rows} .codicon-symbol-string`, icons => icons.length), 0);
      result.cases.push('a fresh extension host restores complete icon-free outline contents');
      result.passed = true;
      return;
    }
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 6, {}, rows);
    result.initialRowShape = await page.evaluate(({rows,tree}) => ({direct:document.querySelectorAll(rows).length,descendants:document.querySelectorAll(`${tree} .monaco-list-rows .monaco-list-row`).length,labels:[...document.querySelectorAll(rows)].map(row=>row.textContent.trim())}),{rows,tree});
    assert.deepEqual(result.initialRowShape.labels,headings,'All six actual native rows must expose the exact fixture headings');
    assert.equal(await page.$$eval(`${rows} .codicon-symbol-string, ${rows} .codicon-symbol-number`, icons => icons.length), 0);
    result.cases.push('six native heading rows without symbol icons');

    const collapse = (await vscode.commands.getCommands(true)).find(command => command.includes('meoEnhanced.outline') && /collapseAll/i.test(command));
    assert.ok(collapse, 'The native collapse-all action is registered');
    await vscode.commands.executeCommand(collapse);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, {}, rows);
    const outlineHeader = '.pane-header:has(.codicon-expand-all), .composite.title:has(.codicon-expand-all)';
    const visibleHeader = element => {
      const bounds = element.getBoundingClientRect();
      return element.textContent.includes('MEO Outline') && bounds.width > 0 && bounds.height > 0
        && bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth
        && getComputedStyle(element).visibility !== 'hidden';
    };
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(element => {
      const bounds = element.getBoundingClientRect();
      return element.textContent.includes('MEO Outline') && bounds.width > 0 && bounds.height > 0
        && bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth
        && getComputedStyle(element).visibility !== 'hidden';
    }), {}, outlineHeader);
    const headers = await page.$$(outlineHeader);
    let header;
    for (const candidate of headers) if (await candidate.evaluate(visibleHeader)) { header = candidate; break; }
    assert.ok(header, 'The current visible outline header exposes the native expand action');
    await header.hover();
    const expandButton = await header.$('.codicon-expand-all');
    assert.ok(expandButton);
    await page.waitForFunction(element => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden', {}, expandButton);
    await expandButton.click();
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 6
      && ![...document.querySelectorAll(selector)].some(row => row.getAttribute('aria-expanded') === 'false'), {}, rows);
    result.cases.push('native collapse all and complete six-level expansion');

    await vscode.commands.executeCommand('meoEnhanced.outline.focus');
    await vscode.commands.executeCommand('list.focusLast');
    await vscode.commands.executeCommand('list.select');
    let editorFrame;
    for (const frame of page.frames()) {
      if (await frame.evaluate(() => !!document.querySelector('.editor-root')).catch(() => false)) editorFrame = frame;
    }
    assert.ok(editorFrame);
    await editorFrame.waitForFunction(() => [...document.querySelectorAll('.cm-line')].some(line =>
      line.textContent.includes('Native sixth') && line.getBoundingClientRect().top >= 0 && line.getBoundingClientRect().top < 400));
    result.cases.push('native tree click navigates the MEO editor');

    await vscode.commands.executeCommand('meoEnhanced.outline.focus');
    await vscode.commands.executeCommand('workbench.action.moveFocusedView', 'meoEnhanced.outline');
    const destinationInput = '.quick-input-widget input';
    await page.waitForSelector(destinationInput, { visible: true });
    await page.type(destinationInput, 'New Side Bar Entry');
    await page.keyboard.press('Enter');
    await page.waitForSelector(destinationInput, { hidden: true });
    await page.waitForFunction(() => document.querySelector('.part.sidebar .composite.title .title-label')?.textContent.trim() === 'MEO Outline');
    result.cases.push('standalone sidebar container shows one MEO Outline title');

    for (const language of ['zh-CN', 'en']) {
      await vscode.workspace.getConfiguration('meoEnhanced').update('language', language, vscode.ConfigurationTarget.Global);
      await page.waitForFunction(() => [...document.querySelectorAll('.pane-header')].some(header => header.textContent.includes('MEO Outline')));
      assert.ok(!await page.evaluate(() => [...document.querySelectorAll('.pane-header')].some(header => header.textContent.includes('MEO 大纲'))),
        'the view title remains English when MEO language changes');
      assert.equal(await page.$eval('.part.sidebar .composite.title .title-label', element => element.textContent.trim()), 'MEO Outline',
        'standalone title does not combine container and view names');
      for (const [theme, themeClass] of [['Light 2026', 'vs'], ['Dark 2026', 'vs-dark']]) {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
        await page.waitForFunction(themeClass => document.querySelector('.monaco-workbench')?.classList.contains(themeClass), {}, themeClass);
        assert.equal(await page.$$eval(rows, nodes => nodes.length), 6);
        assert.equal(await page.$$eval(`${rows} .monaco-highlighted-label .highlight`, nodes => nodes.length), 0,
          'visible sections have no label highlights');
        assert.equal(await page.$$eval(`${rows}[aria-selected="true"]`, nodes => nodes.length), 1,
          'only the current heading is selected');
        await page.screenshot({ path: path.join(output, `${language}-${themeClass}.png`) });
        result.cases.push(`${language}, ${theme}: rows and expansion preserved`);
      }
    }

    const otherFile = path.join(output, 'workspace', 'other.md');
    fs.writeFileSync(otherFile, '# Other focused document\n');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(otherFile), 'meoEnhanced.editor', vscode.ViewColumn.Beside);
    // A new native split has a separate Webview bootstrap. Admit that document
    // before measuring its outline publication; a blank loading surface is not
    // an active editor. Keep the subsequent outline and bulk-expansion budgets.
    const splitStarted = Date.now();
    const splitDeadline = splitStarted + 120000;
    let splitReady = false;
    while (!splitReady && Date.now() < splitDeadline) {
      for (const candidate of page.frames()) {
        splitReady = await Promise.race([
          candidate.evaluate(() => {
            const root = document.querySelector('.editor-root');
            if (window.frameElement?.id !== 'active-frame' || !document.hasFocus()
              || !root?.textContent.includes('Other focused document') || document.querySelector('.meo-preload-toolbar')) return false;
            return root.dataset.mode === 'preview'
              ? document.querySelector('.preview-host')?.hidden === false && !document.querySelector('.preview-host')?.inert
                && document.querySelector('.preview-loading')?.hidden === true
                && document.querySelector('.preview-frame')?.contentDocument?.documentElement.inert === false
              : document.querySelector('.editor-host')?.hidden === false && !document.querySelector('.editor-host')?.inert
                && document.querySelector('.editor-loading')?.hidden === true;
          }).catch(() => false),
          new Promise(resolve => setTimeout(() => resolve(false), 500))
        ]);
        if (splitReady) break;
      }
      if (!splitReady) await new Promise(resolve => setTimeout(resolve, 100));
    }
    result.newSplitAdmissionMilliseconds = Date.now() - splitStarted;
    assert.ok(splitReady, 'The new split must expose its focused, interactive MEO document within native startup admission');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Other focused document')), {}, rows);
    await vscode.commands.executeCommand('meoEnhanced.outline.focus');
    assert.equal(await page.$$eval(rows, nodes => nodes.length), 1, 'Sidebar focus preserves the last MEO outline');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Native root')), {}, rows);
    result.cases.push('split focus, sidebar focus and closing the current editor');

    const scaleFile = path.join(output, 'workspace', 'scale.md');
    fs.writeFileSync(scaleFile, Array.from({ length: 10000 }, (_, index) =>
      `# Scale root ${index}\n\n## Scale child ${index}\n\n`).join(''));
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(scaleFile), 'meoEnhanced.editor');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Scale root')), { timeout: 30000 }, rows);
    await vscode.commands.executeCommand(collapse);
    await page.waitForFunction(selector => ![...document.querySelectorAll(selector)].some(row => row.getAttribute('aria-level') === '2'), {}, rows);
    const collapsedHeight = await page.$eval(`${tree} .monaco-list-rows`, element => parseFloat(element.style.height));
    await page.evaluate(({ tree, collapsedHeight }) => {
      const list = document.querySelector(`${tree} .monaco-list-rows`);
      const clock = window.__meoOutlineExpansionClock = { readyAt: null };
      clock.observer = new MutationObserver(() => {
        if (clock.readyAt === null && parseFloat(list.style.height) > collapsedHeight * 1.9) clock.readyAt = Date.now();
      });
      clock.observer.observe(list, { attributes: true, attributeFilter: ['style'] });
    }, { tree, collapsedHeight });
    const started = Date.now();
    await vscode.commands.executeCommand('meoEnhanced.outline.expandAll');
    await page.waitForFunction(({ tree, collapsedHeight }) => parseFloat(document.querySelector(`${tree} .monaco-list-rows`).style.height) > collapsedHeight * 1.9,
      {}, { tree, collapsedHeight });
    result.expandAll20000Milliseconds = Date.now() - started;
    const readyAt = await page.evaluate(() => {
      const clock = window.__meoOutlineExpansionClock;
      clock.observer.disconnect();
      return clock.readyAt;
    });
    if (readyAt !== null) {
      result.independentExpansionMilliseconds = readyAt - started;
      result.expansionObservationLagMilliseconds = result.expandAll20000Milliseconds - result.independentExpansionMilliseconds;
    }
    assert.ok(result.expandAll20000Milliseconds < 10000, '20,000 headings expand within the native interaction budget');
    await vscode.commands.executeCommand('meoEnhanced.outline.focus');
    await vscode.commands.executeCommand('list.focusLast');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Scale child 9999')), {}, rows);
    result.cases.push('20,000 native headings: bulk expansion reaches the final child');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(row => row.textContent.includes('Native root')), {}, rows);
    await vscode.commands.executeCommand(collapse);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, {}, rows);
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    if (page) {
      result.trees = await page.evaluate(() => [...document.querySelectorAll('.monaco-list')].map(tree => ({
        label: tree.getAttribute('aria-label'), rows: tree.querySelectorAll('.monaco-list-row').length,
        text: tree.textContent.slice(0, 500)
      }))).catch(() => null);
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (page) await page.evaluate(() => window.__meoOutlineExpansionClock?.observer.disconnect()).catch(() => {});
    browser.disconnect();
    fs.writeFileSync(path.join(output, restoring ? 'result-restore.json' : 'result.json'), JSON.stringify(result, null, 2));
  }
};
