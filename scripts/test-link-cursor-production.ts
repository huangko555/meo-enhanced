import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-link-cursor-'));
const fixtures = [
  { label: 'external', source: '[external](https://example.com)', href: 'https://example.com' },
  { label: 'document', source: '[document](./guide.md)', href: './guide.md' },
  { label: 'fragment', source: '[fragment](#target)', href: '#target' },
  { label: 'wiki', source: '[[guide|wiki]]', href: 'meo-wiki:guide' },
  { label: 'reference', source: '[reference][ref]\n\n[ref]: https://example.com/ref', href: 'https://example.com/ref' },
  { label: 'autolink', source: '<https://example.com/auto>', href: 'https://example.com/auto' },
  { label: 'raw URL', source: 'https://example.com/raw', href: 'https://example.com/raw' },
  { label: 'inline HTML', source: 'Inline <a href="https://example.com/inline">inline HTML</a>.', href: 'https://example.com/inline' },
  { label: 'block HTML', source: '<div><a href="https://example.com/block">block HTML</a></div>', href: 'https://example.com/block' },
  { label: 'table', source: '| label |\n| --- |\n| [table](https://example.com/table) |', href: 'https://example.com/table' }
];

async function cursor(page: import('puppeteer-core').Page, point: { x: number; y: number }): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error(`Hovered target disappeared at ${x}, ${y}`);
    return getComputedStyle(target).cursor;
  }, point);
}

async function mount(page: import('puppeteer-core').Page, source: string, active = false): Promise<void> {
  await page.evaluate(({ source, active }) => {
    (window as any).__linkEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__openedLinks = [];
    const editor = (window as any).HtmlContentHarness.createEditor({
      parent: document.getElementById('app'), text: `caret\n\n${source}\n\n# target`, initialMode: 'live',
      onApplyChanges() {}, onOpenLink(href: string) { (window as any).__openedLinks.push(href); }
    });
    (window as any).__linkEditor = editor;
    if (active) editor.view.dispatch({ selection: { anchor: 9 } });
    editor.view.focus();
  }, { source, active });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function linkPoint(page: import('puppeteer-core').Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const link = document.querySelector<HTMLElement>('.meo-md-link[data-meo-link-href]');
    if (!link) throw new Error('Expected rendered link');
    const rect = link.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

const browser = await launchTestBrowser();
try {
  const build = await Bun.build({ entrypoints: [path.join(repoRoot, 'scripts/test-html-content-entry.ts')],
    outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js' });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 700 });
  await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}#app{height:600px}</style><div id="app"></div><input id="outside">');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#222;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-live-weight:400;--meo-font-source:monospace;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}' });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.body.className = `vscode-${theme}`; document.documentElement.dataset.editorAppearance = theme; }, theme);
    for (const fixture of fixtures) {
      for (const active of fixture.label === 'external' ? [false, true] : [false]) {
        await mount(page, fixture.source, active);
        const point = await linkPoint(page);
        await page.mouse.move(point.x, point.y);
        assert.equal(await cursor(page, point), 'text', `${theme} ${fixture.label}: plain hover`);
        for (const modifier of ['Control', 'Meta'] as const) {
          await page.keyboard.down(modifier);
          assert.equal(await cursor(page, point), 'pointer', `${fixture.label}: stationary ${modifier} hover`);
          for (const excluded of ['Shift', 'Alt'] as const) {
            await page.keyboard.down(excluded);
            assert.equal(await cursor(page, point), 'text', `${fixture.label}: ${modifier}+${excluded} hover`);
            await page.keyboard.up(excluded);
            assert.equal(await cursor(page, point), 'pointer', `${fixture.label}: released ${excluded}`);
          }
          await page.keyboard.up(modifier);
          assert.equal(await cursor(page, point), 'text', `${fixture.label}: released ${modifier}`);
        }
        await page.evaluate(() => document.getElementById('outside')!.focus());
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const outsidePoint = await linkPoint(page);
        await page.mouse.move(outsidePoint.x, outsidePoint.y);
        await page.keyboard.down('Control');
        assert.equal(await cursor(page, outsidePoint), 'pointer', `${fixture.label}: modifier with focus outside editor`);
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        assert.equal(await cursor(page, outsidePoint), 'text', `${fixture.label}: window blur clears modifier cursor`);
        await page.keyboard.up('Control');
        await mount(page, fixture.source, active);
        const plainPoint = await linkPoint(page);
        await page.mouse.click(plainPoint.x, plainPoint.y);
        assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [], `${fixture.label}: ordinary click must not open link`);
        if (fixture.href.startsWith('#')) {
          assert.notEqual(await page.evaluate(() => (window as any).__linkEditor.view.state.selection.main.head),
            `caret\n\n${fixture.source}\n\n`.length, 'ordinary fragment click must not jump to its heading');
        }
        await mount(page, fixture.source, active);
        const clickPoint = await linkPoint(page);
        await page.keyboard.down('Control');
        await page.mouse.click(clickPoint.x, clickPoint.y);
        await page.keyboard.up('Control');
        if (fixture.href.startsWith('#')) {
          assert.equal(await page.evaluate(() => (window as any).__linkEditor.view.state.selection.main.head),
            `caret\n\n${fixture.source}\n\n`.length, 'fragment click must jump to its heading');
        } else {
          assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [fixture.href], `${fixture.label}: Ctrl click must open exactly once`);
        }
      }
    }
  }
  // Extra modifiers must agree with the hover affordance in rendered HTML too.
  for (const fixture of fixtures.filter((fixture) => fixture.label.endsWith('HTML'))) {
    for (const extra of ['Shift', 'Alt'] as const) {
      await mount(page, fixture.source);
      const point = await linkPoint(page);
      await page.keyboard.down('Control');
      await page.keyboard.down(extra);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up(extra);
      await page.keyboard.up('Control');
      assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [], `${fixture.label}: Ctrl+${extra} must not open`);
    }
  }
  await mount(page, '[external](https://example.com) plain prose');
  const point = await linkPoint(page);
  const plainPoint = await page.evaluate(() => {
    const rect = (window as any).__linkEditor.view.coordsAtPos((window as any).__linkEditor.getText().indexOf('plain prose') + 2);
    return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.move(plainPoint.x, plainPoint.y);
  assert.equal(await cursor(page, plainPoint), 'text', 'Ctrl over ordinary prose must remain text');
  await page.mouse.move(point.x, point.y);
  assert.equal(await cursor(page, point), 'pointer', 'Entering a link with Ctrl already held');
  await page.mouse.move(790, 690);
  assert.equal(await cursor(page, point), 'text', 'Leaving editor clears modifier cursor');
  await page.keyboard.up('Control');
  await page.evaluate(() => (window as any).__linkEditor.setMode('source'));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const sourcePoint = await page.evaluate(() => {
    const rect = (window as any).__linkEditor.view.coordsAtPos(10);
    return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
  });
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  assert.equal(await cursor(page, sourcePoint), 'text', 'Source link plain hover');
  await page.keyboard.down('Control');
  assert.equal(await cursor(page, sourcePoint), 'pointer', 'Source link modifier hover');
  await page.keyboard.up('Control');
  assert.equal(await cursor(page, sourcePoint), 'text', 'Source link modifier release');
  await mount(page, '<div><a href="https://example.com/button">button link</a></div>');
  const openButton = await page.$('.meo-md-link-open-btn');
  assert.ok(openButton, 'Rendered HTML must retain its open button');
  assert.equal(await openButton.evaluate((button) => getComputedStyle(button).cursor), 'pointer');
  await openButton.click();
  assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), ['https://example.com/button']);
  const footnoteSource = 'note [^n]\n\n[^n]: footnote';
  await mount(page, footnoteSource);
  const reference = await page.$('.meo-md-footnote-ref');
  assert.ok(reference, 'Rendered footnote reference must remain directly clickable');
  assert.equal(await reference.evaluate((button) => getComputedStyle(button).cursor), 'pointer');
  await reference.click();
  assert.equal(await page.evaluate(() => (window as any).__linkEditor.view.state.selection.main.head), 7 + footnoteSource.indexOf('[^n]:'));
  console.log('Production link cursors and modifier activation passed in light/dark themes; Source, prose and direct-action buttons passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
