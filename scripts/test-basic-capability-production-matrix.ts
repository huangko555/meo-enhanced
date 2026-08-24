import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-basic-capability-production-'));
const target = 'format target';

const formats = [
  ['bold', `**${target}**`],
  ['italic', `*${target}*`],
  ['lineover', `~~${target}~~`],
  ['highlight', `==${target}==`],
  ['inlineCode', `\`${target}\``],
  ['link', `[${target}]()`],
  ['wikiLink', `[[${target}]]`],
  ['kbd', `<kbd>${target}</kbd>`],
  ['underline', `<u>${target}</u>`]
] as const;

async function waitForMenu(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') === true);
}

async function selectVisibleTextWithMouse(page: Page): Promise<void> {
  const points = await page.evaluate((needle) => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent === needle);
    if (!line) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node?.textContent) return null;
    const first = document.createRange();
    first.setStart(node, 0);
    first.setEnd(node, 1);
    const last = document.createRange();
    last.setStart(node, node.textContent.length - 1);
    last.setEnd(node, node.textContent.length);
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    return {
      start: { x: firstRect.left + 1, y: firstRect.top + firstRect.height / 2 },
      end: { x: lastRect.right - 1, y: lastRect.top + lastRect.height / 2 }
    };
  }, target);
  assert.ok(points, `could not find public text target ${target}`);
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 4 });
  await page.mouse.up();
}

async function pointForVisibleLine(page: Page, text: string, atEnd = false): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(({ needle, end }) => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent === needle);
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { x: end ? rect.right - 2 : rect.left + 2, y: rect.top + rect.height / 2 };
  }, { needle: text, end: atEnd });
  assert.ok(point, `could not find visible line ${text}`);
  return point;
}

async function createCase(page: Page, mode: 'source' | 'live') {
  return page.evaluate(({ text, initialMode }) => {
    document.getElementById('app')!.replaceChildren();
    document.querySelectorAll('.selection-inline-menu').forEach((menu) => menu.remove());
    const changes: string[] = [];
    const harness = (window as any).BasicCapabilityProductionHarness;
    const candidate = harness.createBasicCapabilityEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode,
      onApplyChanges(next: string) { changes.push(next); }
    });
    (window as any).__basicCapabilityCase?.dispose();
    (window as any).__basicCapabilityCase = candidate;
    (window as any).__basicCapabilityChanges = changes;
    return candidate.editor.getText();
  }, { text: target, initialMode: mode });
}

async function assertSelectionAction(page: Page, mode: 'source' | 'live', action: string, expected: string): Promise<void> {
  assert.equal(await createCase(page, mode), target);
  await selectVisibleTextWithMouse(page);
  await waitForMenu(page);
  const menuState = await page.evaluate(() => ({
    visible: document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false,
    actions: Array.from(document.querySelectorAll<HTMLElement>('.selection-inline-button')).map((button) => button.dataset.action)
  }));
  assert.equal(menuState.visible, true, `${mode}/${action} must expose the public selection menu`);
  assert.deepEqual(menuState.actions, formats.map(([name]) => name));
  await page.click(`.selection-inline-button[data-action="${action}"]`);
  await page.waitForFunction((wanted) => (window as any).__basicCapabilityCase.editor.getText() === wanted, {}, expected);
  const applied = await page.evaluate(() => {
    const editor = (window as any).__basicCapabilityCase.editor;
    return {
      text: editor.getText(),
      history: editor.getHistoryDepth(),
      changes: (window as any).__basicCapabilityChanges.slice(),
      focused: editor.hasFocus()
    };
  });
  assert.equal(applied.text, expected);
  assert.deepEqual(applied.history, { undo: 1, redo: 0 }, `${mode}/${action} must create exactly one history entry`);
  assert.deepEqual(applied.changes, [expected], `${mode}/${action} must publish the accepted Document exactly once`);
  assert.equal(applied.focused, true, `${mode}/${action} must restore editor focus`);

  const afterUndo = await page.evaluate(async () => {
    const editor = (window as any).__basicCapabilityCase.editor;
    const applied = await editor.undo();
    return { applied, text: editor.getText(), history: editor.getHistoryDepth(), changes: (window as any).__basicCapabilityChanges.slice() };
  });
  assert.deepEqual(afterUndo, { applied: true, text: target, history: { undo: 0, redo: 1 }, changes: [expected, target] });
  const afterRedo = await page.evaluate(async () => {
    const editor = (window as any).__basicCapabilityCase.editor;
    const applied = await editor.redo();
    return { applied, text: editor.getText(), history: editor.getHistoryDepth(), changes: (window as any).__basicCapabilityChanges.slice() };
  });
  assert.deepEqual(afterRedo, { applied: true, text: expected, history: { undo: 1, redo: 0 }, changes: [expected, target, expected] });
}

async function assertAlerts(page: Page): Promise<void> {
  const alertLines = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].flatMap((type) => [`> [!${type}]`, `> ${type} body`, '']);
  const text = [...alertLines, '> [!UNKNOWN]', '> unknown body'].join('\n');
  await page.evaluate((documentText) => {
    document.getElementById('app')!.replaceChildren();
    (window as any).__basicCapabilityCase?.dispose();
    const harness = (window as any).BasicCapabilityProductionHarness;
    (window as any).__basicCapabilityCase = harness.createBasicCapabilityEditor({
      parent: document.getElementById('app')!, text: documentText, initialMode: 'live', onApplyChanges() {}
    });
  }, text);
  const ordinaryQuotePoint = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes('unknown body'));
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
  });
  assert.ok(ordinaryQuotePoint, 'unknown alert body must remain a public blockquote line');
  await page.mouse.click(ordinaryQuotePoint.x, ordinaryQuotePoint.y);
  try {
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-alert-icon').length === 5);
  } catch (error) {
    const snapshot = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => ({
      text: line.textContent,
      classes: Array.from(line.classList),
      html: line.innerHTML
    })));
    throw new Error(`Live alert semantic DOM did not settle: ${JSON.stringify(snapshot)}`, { cause: error });
  }
  const result = await page.evaluate(() => ({
    source: (window as any).__basicCapabilityCase.editor.getText(),
    alerts: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-alert-icon')).map((icon) => {
      const line = icon.closest<HTMLElement>('.meo-md-alert')!;
      return ({
      classes: Array.from(line.classList),
      icon: Boolean(icon.querySelector('svg')),
      label: icon.querySelector('.meo-md-alert-label')?.textContent ?? '',
      body: line.nextElementSibling?.textContent ?? ''
      });
    }),
    unknownAlert: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .filter((line) => line.textContent?.includes('unknown body'))
      .some((line) => line.classList.contains('meo-md-alert')),
    menuVisible: document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false
  }));
  assert.equal(result.source, text, 'Live alerts must preserve the Markdown Document');
  assert.equal(result.alerts.length, 5);
  for (const [index, type] of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].entries()) {
    const alert = result.alerts[index]!;
    assert.equal(alert.classes.includes(`meo-md-alert-${type.toLowerCase()}`), true);
    assert.equal(alert.icon, true, `${type} must expose an icon`);
    assert.equal(alert.label, type, `${type} must expose its current-locale label`);
    assert.equal(alert.body.includes(`${type} body`), true, `${type} body must remain visible`);
  }
  assert.equal(result.unknownAlert, false, 'unknown alert types must remain ordinary blockquotes');
  assert.equal(result.menuVisible, false, 'Alerts must not create a Live-only formatting menu');
}

async function assertPreviewHidesMenu(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const candidate = (window as any).__basicCapabilityCase;
    candidate.editor.setMode('preview');
    return {
      menuVisible: document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false
    };
  });
  assert.equal(result.menuVisible, false);
}

async function assertMenuSafetyMatrix(page: Page): Promise<void> {
  await createCase(page, 'live');
  const collapsedPoint = await pointForVisibleLine(page, target);
  await page.mouse.click(collapsedPoint.x, collapsedPoint.y);
  assert.equal(
    await page.evaluate(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false),
    false,
    'collapsed text selection must not open the menu'
  );

  await page.evaluate(() => {
    (window as any).__basicCapabilityCase?.dispose();
    document.getElementById('app')!.replaceChildren();
    const harness = (window as any).BasicCapabilityProductionHarness;
    (window as any).__basicCapabilityCase = harness.createBasicCapabilityEditor({
      parent: document.getElementById('app')!, text: 'first line\nsecond line', initialMode: 'live', onApplyChanges() {}
    });
  });
  const start = await pointForVisibleLine(page, 'first line');
  const end = await pointForVisibleLine(page, 'second line', true);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => (window.getSelection()?.toString() ?? '').includes('first line'));
  assert.equal(
    await page.evaluate(() => document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false),
    false,
    'cross-line selection must safely decline inline formatting'
  );

  const modeState = await page.evaluate(() => {
    const editor = (window as any).__basicCapabilityCase.editor;
    const before = { text: editor.getText(), history: editor.getHistoryDepth() };
    editor.setMode('source');
    editor.setMode('live');
    editor.setMode('source');
    editor.setMode('live');
    return { before, after: { text: editor.getText(), history: editor.getHistoryDepth(), focused: editor.hasFocus() } };
  });
  assert.deepEqual(modeState.after.text, modeState.before.text, 'rapid editable-mode switches must not alter the Document');
  assert.deepEqual(modeState.after.history, modeState.before.history, 'rapid editable-mode switches must not enter History');

  const tableEntry = await page.evaluate(() => {
    (window as any).__basicCapabilityCase?.dispose();
    document.getElementById('app')!.replaceChildren();
    const harness = (window as any).BasicCapabilityProductionHarness;
    (window as any).__basicCapabilityCase = harness.createBasicCapabilityEditor({
      parent: document.getElementById('app')!, text: '| A | B |\n| --- | --- |\n| one | two |', initialMode: 'live', onApplyChanges() {}
    });
    return true;
  });
  assert.equal(tableEntry, true);
  await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell') !== null);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.meo-md-html-table-shell'))), true, 'table selection retains its existing Live entry');

  const late = await page.evaluate(() => {
    const old = (window as any).__basicCapabilityCase;
    const staleButton = old.menu.querySelector<HTMLElement>('[data-action="bold"]')!;
    old.dispose();
    document.getElementById('app')!.replaceChildren();
    const harness = (window as any).BasicCapabilityProductionHarness;
    const next = harness.createBasicCapabilityEditor({
      parent: document.getElementById('app')!, text: 'next session', initialMode: 'live', onApplyChanges() {}
    });
    (window as any).__basicCapabilityCase = next;
    staleButton.click();
    return { text: next.editor.getText(), history: next.editor.getHistoryDepth() };
  });
  assert.deepEqual(late, { text: 'next session', history: { undo: 0, redo: 0 } }, 'late menu actions must not write a replacement session');
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-basic-capability-production-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await assertAlerts(page);
    for (const mode of ['source', 'live'] as const) {
      for (const [action, expected] of formats) await assertSelectionAction(page, mode, action, expected);
    }
    await assertPreviewHidesMenu(page);
    await assertMenuSafetyMatrix(page);
    await page.evaluate(() => (window as any).__basicCapabilityCase?.dispose());
  } finally {
    await browser.close();
  }
  console.log('Basic capability production matrix passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
