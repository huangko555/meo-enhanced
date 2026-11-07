// Run as VS Code's --extensionTestsPath in an isolated, disposable workspace.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async function () {
  assert.equal(process.env.MEO_CONFIRM_LONG_RUN, '1', 'Explicit long-run authorization is required');
  const root = process.env.MEO_NATIVE_ENDURANCE_WORKSPACE;
  assert.ok(root && path.isAbsolute(root), 'A disposable workspace path is required');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), root.toLowerCase());
  const rounds = Number(process.env.MEO_NATIVE_ENDURANCE_ROUNDS || 60);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 120);
  const report = { vscode: vscode.version, rounds, completed: 0, saves: 0, passed: false };
  const file = path.join(root, 'auto-save-endurance.md');
  const baseline = '# Auto-save endurance\n\nParagraph\n\n| Name | Value |\n| --- | --- |\n| Alpha | base |\n';
  fs.writeFileSync(file, baseline);
  const uri = vscode.Uri.file(file);
  let browser;
  const subscription = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.toString() === uri.toString()) report.saves++;
  });
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      try {
        if (await predicate()) return;
      } catch (error) {
        // Webview replacement can detach a frame between enumeration and
        // evaluate(), including a synchronous Puppeteer decorator throw. Keep
        // the original bound; assertion and product errors still fail at once.
        if (!/detached Frame|Execution context was destroyed|Cannot find context/i.test(String(error))) throw error;
      }
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    await vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('files').update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor');
    browser = await puppeteer.connect({ browserURL: process.env.MEO_NATIVE_BROWSER_URL || 'http://127.0.0.1:9337', defaultViewport: null });
    let frame;
    const locateActiveFrame = async () => {
      const matches = [];
      for (const page of await browser.pages()) {
        for (const candidate of page.frames()) {
          const active = await candidate.evaluate(() => window.frameElement?.id === 'active-frame'
            && getComputedStyle(window.frameElement).visibility === 'visible'
            && document.querySelector('.editor-root')?.textContent.includes('Auto-save endurance')
            && !document.querySelector('.meo-preload-toolbar')
            && !!document.querySelector('.cm-content')).catch(() => false);
          if (active) matches.push(candidate);
        }
      }
      assert.ok(matches.length <= 1, 'Only one active Webview may own the disposable document');
      return matches[0];
    };
    const waitForActiveFrame = async label => {
      await waitFor(async () => {
        frame = await locateActiveFrame();
        return !!frame;
      }, label);
      return frame;
    };
    await waitForActiveFrame('production editor');
    // A selected mode button can precede the final interactive surface. Input
    // must reach that surface before automatic-save assertions have meaning.
    const waitModeReady = async mode => frame.waitForFunction(mode => {
      if (document.querySelector('.meo-preload-toolbar')) return false;
      if (document.querySelector('.editor-root')?.dataset.mode !== mode) return false;
      const selected = document.querySelector(`button[data-mode="${mode}"]`);
      if (selected?.getAttribute('aria-selected') !== 'true') return false;
      if (mode === 'preview') {
        const preview = document.querySelector('.preview-host');
        const previewFrame = document.querySelector('.preview-frame');
        return preview?.hidden === false && document.querySelector('.preview-status')?.hidden === true
          && !!previewFrame?.contentDocument?.querySelector('main.meo-export-doc')?.textContent;
      }
      const host = document.querySelector('.editor-host');
      const content = host?.querySelector(`.meo-mode-${mode} .cm-content`);
      return host?.hidden === false && host.inert === false && !!content && !content.closest('[inert]')
        && getComputedStyle(content).visibility === 'visible' && content.getBoundingClientRect().height > 0;
    }, {timeout:8000}, mode);
    await waitModeReady(await frame.evaluate(()=>document.querySelector('.editor-root').dataset.mode));
    const selectMode = async mode => {
      await frame.click(`button[data-mode="${mode}"]`);
      await waitModeReady(mode);
    };
    let doc = await vscode.workspace.openTextDocument(uri);
    const saved = async expected => {
      await waitFor(() => !doc.isDirty && fs.readFileSync(file, 'utf8') === expected, 'automatic disk save');
      assert.equal(doc.getText(), expected, 'Host and disk must match the expected revision');
    };
    let expected = baseline;
    let cellValue = 'base';
    for (let round = 0; round < rounds; round++) {
      const before = expected;
      const mode = round % 3 === 1 ? 'live' : 'source';
      await selectMode(mode);
      const savesBefore = report.saves;
      if (mode === 'live') {
        const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]';
        await frame.click('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview');
        await frame.waitForSelector(selector, { visible: true });
        const cell = await frame.$(selector);
        await cell.click();
        await cell.evaluate(input => input.select());
        const next = `cell-${round}`;
        await cell.type(next, { delay: 30 });
        expected = before.replace(`| Alpha | ${cellValue} |`, `| Alpha | ${next} |`);
        cellValue = next;
        await saved(expected);
        assert.equal(await cell.evaluate(input => input === document.activeElement), true, 'Auto-save must preserve cell focus');
      } else {
        await frame.click('.cm-content[contenteditable="true"]');
        const page = frame.page();
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        assert.equal(await frame.evaluate(() => {
          const content = document.querySelector('.editor-host .cm-content');
          const selection = window.getSelection();
          if (document.activeElement !== content || !selection?.isCollapsed
            || !selection.focusNode || !content.contains(selection.focusNode)) return false;
          const remaining = document.createRange();
          remaining.selectNodeContents(content);
          remaining.setStart(selection.focusNode, selection.focusOffset);
          return remaining.toString() === '';
        }), true, 'Source input must target the document end');
        const marker = ` round-${round}`;
        // This sample is one edit with one Undo. Real per-key arrival gaps can
        // split a typing burst into several history groups on a busy native UI.
        // Keep live-cell typing above; use a real atomic text input for this
        // automatic-save/history round trip.
        await page.keyboard.sendCharacter(marker);
        expected = before + marker;
        await saved(expected);
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await saved(before);
        await page.keyboard.down('Control');
        await page.keyboard.press('y');
        await page.keyboard.up('Control');
        await saved(expected);
      }
      assert.ok(report.saves > savesBefore, 'The platform must emit a native save event');
      await selectMode('preview');
      await selectMode('source');
      report.completed++;
      console.log(`Native auto-save endurance ${report.completed}/${rounds}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor');
    doc = await vscode.workspace.openTextDocument(uri);
    assert.equal(doc.getText(), expected);
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
    await waitForActiveFrame('production editor after native close/reopen');
    await waitModeReady(await frame.evaluate(() => document.querySelector('.editor-root').dataset.mode));

    const commandIds = await vscode.commands.getCommands(true);
    const commands = { reload: 'workbench.action.webview.reloadWebviewAction', close: 'workbench.action.closeActiveEditor' };
    report.pendingCellHandoffs = [];
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    const previousAutoSave = filesConfiguration.inspect('autoSave')?.workspaceValue;
    await filesConfiguration.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace);
    try {
    for (const [action, command] of Object.entries(commands)) {
      assert.ok(commandIds.includes(command), `Required native command is unavailable: ${command}`);
      await selectMode('live');
      const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]';
      await frame.click('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview');
      await frame.waitForSelector(selector, { visible: true });
      await frame.$eval(selector, input => { input.focus(); input.select(); });
      const value = `pending-${action}-${rounds}`;
      const generationMarker = `${action}-${Date.now()}`;
      await frame.evaluate(marker => { globalThis.__nativeDraftHandoffGeneration = marker; }, generationMarker);
      await frame.page().keyboard.sendCharacter(value);
      const before = await frame.evaluate(selector => ({
        textareaValue: document.querySelector(selector)?.value,
        editorText: document.querySelector('.editor-host .cm-content').cmTile.root.view.state.doc.toString()
      }), selector);
      const next = expected.replace(`| Alpha | ${cellValue} |`, `| Alpha | ${value} |`);
      const receipt = { action, command, before, hostBefore: doc.getText(), diskBefore: fs.readFileSync(file, 'utf8'), passed: false };
      report.pendingCellHandoffs.push(receipt);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(), uri.toString(), 'The real Workbench command must target the pending-cell document');
      assert.equal(before.textareaValue, value, 'Real native input must reach the active cell');
      assert.equal(before.editorText, expected, 'The native handoff must start with an uncommitted cell, not an already flushed edit');
      assert.equal(receipt.hostBefore, expected, 'Host must not have accepted the pending cell before the handoff');
      assert.equal(receipt.diskBefore, expected, 'Disk must still contain the previous revision before the handoff');
      const handoffDocument = doc;
      const previousDocuments = new Set(vscode.workspace.textDocuments.map(document => document.uri.toString()));
      let timeout;
      try {
        await Promise.race([
          vscode.commands.executeCommand(command),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Native ${action} command did not complete`)), 8000); })
        ]);
      } finally { clearTimeout(timeout); }
      if (action === 'close') {
        await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== uri.toString(), 'native editor close');
        await vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor');
      }
      await waitFor(async () => {
        const candidate = await locateActiveFrame();
        if (!candidate || await candidate.evaluate(marker => globalThis.__nativeDraftHandoffGeneration === marker, generationMarker).catch(() => true)) return false;
        frame = candidate;
        return true;
      }, `new production Webview generation after ${action}`);
      doc = await vscode.workspace.openTextDocument(uri);
      await waitModeReady(await frame.evaluate(() => document.querySelector('.editor-root').dataset.mode));
      let recoveryCopy;
      await waitFor(() => {
        recoveryCopy = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'untitled'
          && !previousDocuments.has(document.uri.toString())
          && document.getText().startsWith('<<<<<<< MEO local recovery')
          && document.getText().includes('\n' + next + '\n'));
        return doc.getText() === next || !!recoveryCopy;
      }, `Host or protected-copy pending-cell recovery after ${action}`);
      if (recoveryCopy) {
        assert.equal(action, 'close', 'An ordinary Webview reload must recover its still-open Host document');
        assert.equal(doc.getText(), expected, 'A terminal recovery copy must leave the reopened original unchanged');
        assert.equal(fs.readFileSync(file, 'utf8'), expected, 'Terminal recovery must not overwrite the saved original');
        await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input?.uri?.toString() === recoveryCopy.uri.toString())), 'visible recovery-copy tab');
        const copyFile = path.join(root, 'pending-cell-close-recovery.md');
        fs.writeFileSync(copyFile, recoveryCopy.getText());
        assert.ok(fs.readFileSync(copyFile, 'utf8').includes('\n' + next + '\n'), 'The independent recovery artifact must preserve every local character');
        receipt.outcome = 'protected-copy';
        receipt.originalDocumentClosed = handoffDocument.isClosed;
        receipt.recoveryCopy = { file: copyFile, text: recoveryCopy.getText() };
        receipt.hostAfter = doc.getText();
        receipt.diskAfter = fs.readFileSync(file, 'utf8');
        const discard = 'workbench.action.revertAndCloseActiveEditor';
        assert.ok(commandIds.includes(discard), 'Owned untitled test-buffer cleanup command must exist');
        await vscode.window.showTextDocument(recoveryCopy, { preview: false });
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), recoveryCopy.uri.toString());
        await vscode.commands.executeCommand(discard);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor');
        receipt.passed = true;
        continue;
      }
      await frame.waitForFunction(text => document.querySelector('.editor-host .cm-content')?.cmTile?.root?.view?.state.doc.toString() === text, { timeout: 8000 }, next);
      await vscode.commands.executeCommand('workbench.action.files.save');
      await saved(next);
      receipt.hostAfter = doc.getText();
      receipt.diskAfter = fs.readFileSync(file, 'utf8');
      receipt.outcome = 'original-document';
      receipt.passed = true;
      expected = next;
      cellValue = value;
    }
    } finally {
      await filesConfiguration.update('autoSave', previousAutoSave, vscode.ConfigurationTarget.Workspace);
    }
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error);
    try {
      report.failureDocuments = vscode.workspace.textDocuments.filter(document => document.uri.toString() === uri.toString()
        || document.uri.scheme === 'untitled' && document.getText().startsWith('<<<<<<< MEO local recovery'))
        .map(document => ({ uri: document.uri.toString(), isDirty: document.isDirty, text: document.getText() }));
      report.diskAtFailure = fs.readFileSync(file, 'utf8');
    } catch (observationError) { report.observationError = String(observationError); }
    throw error;
  } finally {
    subscription.dispose();
    if (browser) browser.disconnect();
    fs.writeFileSync(path.join(root, 'auto-save-endurance-result.json'), JSON.stringify(report, null, 2));
  }
};
