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
      if (await predicate()) return;
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
    await waitFor(async () => {
      for (const page of await browser.pages()) {
        for (const candidate of page.frames()) {
          if (await candidate.$('.cm-content').catch(() => null)) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'production editor');
    const doc = await vscode.workspace.openTextDocument(uri);
    const saved = async expected => {
      await waitFor(() => !doc.isDirty && fs.readFileSync(file, 'utf8') === expected, 'automatic disk save');
      assert.equal(doc.getText(), expected, 'Host and disk must match the expected revision');
    };
    let expected = baseline;
    let cellValue = 'base';
    for (let round = 0; round < rounds; round++) {
      const before = expected;
      const mode = round % 3 === 1 ? 'live' : 'source';
      await frame.click(`button[data-mode="${mode}"]`);
      const savesBefore = report.saves;
      if (mode === 'live') {
        const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]';
        await frame.waitForSelector(selector);
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
        const marker = ` round-${round}`;
        await page.keyboard.type(marker, { delay: 30 });
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
      await frame.click('button[data-mode="preview"]');
      await frame.click('button[data-mode="source"]');
      report.completed++;
      console.log(`Native auto-save endurance ${report.completed}/${rounds}`);
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'meoEnhanced.editor');
    assert.equal((await vscode.workspace.openTextDocument(uri)).getText(), expected);
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error);
    throw error;
  } finally {
    subscription.dispose();
    if (browser) browser.disconnect();
    fs.writeFileSync(path.join(root, 'auto-save-endurance-result.json'), JSON.stringify(report, null, 2));
  }
};
