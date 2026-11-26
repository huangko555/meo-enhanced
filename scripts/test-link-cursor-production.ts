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
  { label: 'absolute path', source: '[absolute](<D:/notes/guide.md>)', href: 'file:///D:/notes/guide.md' },
  { label: 'absolute backslash path', source: '[absolute](<D:\\notes\\guide.md>)', href: 'file:///D:/notes/guide.md' },
  { label: 'fragment', source: '[fragment](#target)', href: '#target' },
  { label: 'wiki', source: '[[guide|wiki]]', href: 'meo-wiki:guide' },
  { label: 'reference', source: '[reference][ref]\n\n[ref]: https://example.com/ref', href: 'https://example.com/ref' },
  { label: 'autolink', source: '<https://example.com/auto>', href: 'https://example.com/auto' },
  { label: 'raw URL', source: 'https://example.com/raw', href: 'https://example.com/raw' },
  { label: 'inline HTML', source: 'Inline <a href="https://example.com/inline">inline HTML</a>.', href: 'https://example.com/inline' },
  { label: 'block HTML', source: '<div><a href="https://example.com/block">block HTML</a></div>', href: 'https://example.com/block' },
  { label: 'relative HTML', source: 'Inline <a href="./guide.md">relative HTML</a>.', href: './guide.md' },
  { label: 'table', source: '| label |\n| --- |\n| [table](https://example.com/table) |', href: 'https://example.com/table' }
];

async function cursor(page: import('puppeteer-core').Page, point: { x: number; y: number }): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error(`Hovered target disappeared at ${x}, ${y}`);
    return getComputedStyle(target).cursor;
  }, point);
}

async function mount(page: import('puppeteer-core').Page, source: string, active = false, { documentStart = false } = {}): Promise<void> {
  await page.evaluate(({ source, active, documentStart }) => {
    (window as any).__linkEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__openedLinks = [];
    const editor = (window as any).HtmlContentHarness.createEditor({
      parent: document.getElementById('app'), text: `${documentStart ? '' : 'caret\n\n'}${source}\n\n# target`, initialMode: 'live',
      onApplyChanges() {}, onOpenLink(href: string) { (window as any).__openedLinks.push(href); }
    });
    (window as any).__linkEditor = editor;
    if (active) editor.view.dispatch({ selection: { anchor: 9 } });
    editor.view.focus();
  }, { source, active, documentStart });
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

async function checkInlineActionAlignment(page: import('puppeteer-core').Page): Promise<void> {
  const href = 'https://example.com/alignment';
  const clear = '.meo-md-link-clear-btn';
  const control = `.meo-md-link-open-btn[data-tooltip="${href}"]`;
  const link = `.meo-md-link[data-meo-link-href="${href}"]`;
  const tall = '![Tall](fixture-tall.svg) ';
  const measurements: Array<{ fixture: string; large: boolean; tall: boolean; delta: number; height: number }> = [];
  await page.evaluate(() => {
    const harness = (window as any).HtmlContentHarness;
    document.body.className = 'vscode-light';
    document.documentElement.dataset.editorAppearance = 'light';
    harness.setImageSrcResolver(() => 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="46" height="120"><rect width="46" height="120" fill="teal"/></svg>'
    ));
  });
  try {
    for (const large of [false, true]) for (const image of ['', tall]) {
      const markdownLink = `[Alignment](${href})`;
      for (const [fixture, sample] of [
        ['prose list', `- *start ${image}${markdownLink} end*`],
        ['table', `| Link |\n| --- |\n| start ${image}[链接文字](${href}) end |`],
        ['inline HTML', `start ${image}<a href="${href}">Alignment</a> end`],
        ['frontmatter', `---\nsite: ${href}\n---`]
      ]) {
        if (fixture === 'frontmatter' && image) continue;
        const source = sample + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
        await page.evaluate(large => {
          const style = document.documentElement.style;
          style.setProperty('--meo-font-live', large ? 'Consolas, monospace' : 'Arial');
          style.setProperty('--meo-font-live-size', large ? '24px' : '16px');
        }, large);
        await mount(page, source, false, { documentStart: fixture === 'frontmatter' });
        await page.waitForFunction(({ large, hasImage, control }) => {
          const { HtmlContentHarness, __linkEditor } = window as any;
          const image = document.querySelector<HTMLImageElement>('.meo-md-image-img');
          return HtmlContentHarness.usesLargeDocumentDerivedWorkBudget(__linkEditor.view.state) === large
            && !!document.querySelector(control) && (!hasImage || image?.complete && image.naturalHeight === 120
              && image.getBoundingClientRect().height >= 110);
        }, {}, { large, hasImage: !!image, control });
        const metrics = await page.$eval(link, (label, control) => {
          const icon = document.querySelector(`${control} svg`)!.getBoundingClientRect();
          const wholeLine = label.closest('.meo-md-html-table-cell-line, .cm-line')!;
          const range = document.createRange();
          range.selectNodeContents(label);
          const ink = range.getBoundingClientRect();
          return { delta: (icon.top + icon.bottom - ink.top - ink.bottom) / 2,
            height: wholeLine.getBoundingClientRect().height };
        }, control);
        measurements.push({ fixture, large, tall: !!image, ...metrics });
        if (!large && image && process.env.MEO_TEST_SCREENSHOTS && (fixture === 'prose list' || fixture === 'table')) {
          fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `inline-action-${fixture.split(' ')[0]}.png`) });
        }
        if (fixture === 'table' && image) {
          await page.click(control);
          assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [href], 'the aligned table button opens its link');
        }
        if (fixture === 'prose list') {
          await page.evaluate(href => {
            const editor = (window as any).__linkEditor;
            editor.view.dispatch({ selection: { anchor: editor.getText().indexOf(href) + href.length - 1 } });
          }, href);
          await page.waitForSelector(clear, { visible: true });
          const metrics = await page.$eval(clear, button => {
            const view = (window as any).__linkEditor.view;
            const ink = view.coordsForChar(view.state.selection.main.head)!;
            const icon = button.querySelector('svg')!.getBoundingClientRect();
            return { delta: (icon.top + icon.bottom - ink.top - ink.bottom) / 2,
              height: button.closest('.cm-line')!.getBoundingClientRect().height };
          });
          measurements.push({ fixture: 'clear link', large, tall: !!image, ...metrics });
          if (!large && image) {
            await page.click(clear);
            assert.ok(await page.evaluate(href => !(window as any).__linkEditor.getText().includes(href), href),
              'the aligned clear button clears the URL');
          }
        }
      }
    }
  } finally {
    await page.evaluate(() => {
      const style = document.documentElement.style;
      style.removeProperty('--meo-font-live');
      style.removeProperty('--meo-font-live-size');
      (window as any).HtmlContentHarness.setImageSrcResolver(null);
    });
  }
  for (const sample of measurements.filter(sample => sample.tall)) {
    const plain = measurements.find(other => other.fixture === sample.fixture && other.large === sample.large && !other.tall)!;
    assert.ok(sample.height > plain.height + 60, `${sample.fixture} really contains a tall inline row`);
    assert.ok(Math.abs(sample.delta - plain.delta) <= 0.5, `${sample.fixture} keeps the same text alignment in the tall row`);
  }
  assert.ok(measurements.every(sample => Math.abs(sample.delta) <= 2),
    `Inline action centers must follow the text: ${JSON.stringify(measurements)}`);
  console.log('Live inline action alignment passed in ordinary and optimized documents');
}

async function checkLinkCursor(page: import('puppeteer-core').Page): Promise<void> {
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
        const selectionBeforeClick = await page.evaluate(() => (window as any).__linkEditor.view.state.selection.main.toJSON());
        await page.keyboard.down('Control');
        await page.mouse.move(clickPoint.x, clickPoint.y);
        await page.mouse.down();
        if (fixture.label.endsWith('HTML')) {
          // Native selection can replace inline HTML between down and up. A
          // navigation gesture must retain its target for the eventual click.
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('[data-meo-link-href]')?.getAttribute('data-meo-link-href'), clickPoint),
            fixture.href, `${fixture.label}: modifier pointerdown retains the rendered link`);
          assert.deepEqual(await page.evaluate(() => (window as any).__linkEditor.view.state.selection.main.toJSON()),
            selectionBeforeClick, `${fixture.label}: modifier pointerdown retains the selection`);
        }
        await page.mouse.up();
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
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.body.className = `vscode-${theme}`; }, theme);
    for (const fixture of [
      { source: '[label](./guide.md)', hit: 'label', href: './guide.md' },
      { source: '[label][ref]\n\n[ref]: ./guide.md', hit: 'label', href: './guide.md' },
      { source: '[![label](./picture.png)](./guide.md)', hit: 'label', href: './guide.md' },
      { source: '[![label](./picture.png)][ref]\n\n[ref]: ./guide.md', hit: 'label', href: './guide.md' },
      { source: '[[guide|label]]', hit: 'label', href: 'meo-wiki:guide' },
      { source: 'Inline <a href="./guide.md">label</a>.', hit: 'label', href: './guide.md' },
      { source: 'Inline <a href="./guide.md">label</a>.', hit: './guide.md', href: './guide.md' },
      { source: '<div><a href="../guide.md#target"><strong>label</strong></a></div>', hit: 'label', href: '../guide.md#target' },
      { source: '<a\n href="./guide.md">label</a>', hit: 'label', href: './guide.md' },
      { source: '<a href=./guide.md>label</a>', hit: 'label', href: './guide.md' },
      { source: '<a href="./a&amp;b.md">label</a>', hit: 'label', href: './a&b.md' },
      { source: '# <a href="./guide.md">label</a>', hit: 'label', href: './guide.md' },
      { source: '| link |\n| --- |\n| <a href="./guide.md">label</a> |', hit: 'label', href: './guide.md' },
      { source: '`<a href="./guide.md">label</a>`', hit: 'label', href: '' },
      { source: '<!-- <a href="./guide.md">label</a> -->', hit: 'label', href: '' },
      { source: '<a href="javascript:alert(1)">label</a>', hit: 'label', href: '' },
      { source: '<a href="./guide.md">label</a> unrelated', hit: 'unrelated', href: '' },
      { source: '<a href="./guide.md"><code>label</code></a>', hit: 'label', href: '' }
    ]) {
      await mount(page, fixture.source);
      await page.evaluate(() => (window as any).__linkEditor.setMode('source'));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const point = await page.evaluate(fixture => {
        const rect = (window as any).__linkEditor.view.coordsAtPos(7 + fixture.source.indexOf(fixture.hit) + 2);
        return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
      }, fixture);
      await page.mouse.move(point.x, point.y);
      assert.equal(await cursor(page, point), 'text');
      await page.keyboard.down('Control');
      assert.equal(await cursor(page, point), fixture.href ? 'pointer' : 'text', `${theme}: ${fixture.source}`);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up('Control');
      assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), fixture.href ? [fixture.href] : [],
        `Source Ctrl click: ${fixture.source}`);
    }
  }
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
}

async function checkLinkDestinations(page: import('puppeteer-core').Page): Promise<void> {
  const cases = [
    ['[Read](https://example.com/path!)', 'https://example.com/path!'],
    ['<https://example.com/path!>', 'https://example.com/path!'],
    ['[ref]: https://example.com/path!', 'https://example.com/path!'],
    ['Visit https://example.com/path!', 'https://example.com/path']
  ];
  for (const large of [false, true]) for (const [markdown, href] of cases) {
    const source = markdown + (large ? '\n\n' + 'Plain paragraph.\n\n'.repeat(5000) : '');
    await mount(page, source);
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return scope.HtmlContentHarness.usesLargeDocumentDerivedWorkBudget(scope.__linkEditor.view.state);
    }), large);
    const decorated = '.meo-md-link[data-meo-link-href]';
    await page.waitForSelector(decorated);
    assert.equal(await page.$eval(decorated, link => link.getAttribute('data-meo-link-href')), href, markdown);
    const point = await linkPoint(page);
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [href], markdown);
    await mount(page, source);
    const openButton = await page.waitForSelector('.meo-md-link-open-btn');
    await openButton!.click();
    assert.deepEqual(await page.evaluate(() => (window as any).__openedLinks), [href], markdown);
  }
  console.log('Live link destinations preserve explicit punctuation for both activation paths and document scales');
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
  if (!process.argv.includes('--destination-only')) await checkInlineActionAlignment(page);
  if (!process.argv.includes('--alignment-only')) {
    await checkLinkDestinations(page);
    if (!process.argv.includes('--destination-only')) await checkLinkCursor(page);
  }
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
