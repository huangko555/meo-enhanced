import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-html-content-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const image = 'https://assets.example.test/picture.svg';
const href = 'https://example.com/%E5%9B%BE%E7%89%87#details';
const expected = 'Go to: https://example.com/图片#details';
const fixtures = [
  { name: 'HTML link title', source: `<div><a href="${href}" title="打开本地图片"><img src="${image}" alt="picture"></a></div>` },
  { name: 'reference link', source: `[![picture](${image})][target]\n\n[target]: ${href}` },
  { name: 'direct', source: `[![picture](${image})](${href})` },
  { name: 'formatted prose', source: `[**![picture](${image})**](${href})` },
  { name: 'reference image', source: `[![picture][asset]](${href})\n\n[asset]: ${image}` },
  { name: 'both references', source: '[![picture][asset]][target]\n\n[asset]: ' + image + '\n[target]: ' + href },
  { name: 'table', source: `| Picture |\n| --- |\n| [![picture](${image})](${href}) |` },
  { name: 'formatted table', source: `| Picture |\n| --- |\n| [**![picture](${image})**](${href}) |` },
  { name: 'HTML', source: `<div><a href="${href}"><img src="${image}" alt="picture"></a></div>` },
  { name: 'inline HTML', source: `before <a href="${href}"><img src="${image}" alt="picture"></a> after` },
  { name: 'mixed HTML', source: `<div><a href="${href}">before <strong><img src="${image}" alt="picture"></strong> after</a></div>` }
];
const browser = await launchTestBrowser();
try {
  for (const large of [false, true]) {
    for (const fixture of fixtures.filter(fixture => !large || ['HTML link title', 'reference link', 'table', 'mixed HTML'].includes(fixture.name))) {
      const page = await browser.newPage();
      await page.bringToFront();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.setViewport({ width: 1000, height: 700 });
      await page.setRequestInterception(true);
      page.on('request', request => void request.respond({ status: 200, contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="gray"/></svg>' }));
      await page.setContent('<!doctype html><html lang="en"><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div></html>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addScriptTag({ content: await build.outputs[0]!.text() });
      await page.evaluate(() => (window as any).HtmlContentHarness.bindTooltips(document.body));
      console.log(`${large ? 'large' : 'ordinary'} ${fixture.name}`);
      const text = 'caret\n\n' + fixture.source + (large ? '\n\n' + 'ordinary tail paragraph\n\n'.repeat(15000) : '');
      assert.equal(assessLargeDocument(text).boundedEditorWork, large);
      await page.mouse.move(0, 0);
      await page.evaluate(text => {
        const g = window as any;
        g.linkedImageEditor?.destroy();
        document.getElementById('app')!.replaceChildren();
        g.opened = [];
        g.linkedImageEditor = g.HtmlContentHarness.createEditor({ parent: document.getElementById('app'), text,
          initialMode: 'live', onApplyChanges() {}, onOpenLink(href: string) { g.opened.push(href); } });
        g.linkedImageEditor.view.focus();
      }, text);
      await page.waitForSelector('img[alt="picture"]', { visible: true, timeout: 5000 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.evaluate(() => (window as any).HtmlContentHarness.usesLargeDocumentDerivedWorkBudget(
        (window as any).linkedImageEditor.view.state)), large, 'the actual editor must use the intended work budget');
      await page.hover('img[alt="picture"]');
      assert.deepEqual(await page.$eval('img[alt="picture"]', element => {
        const titles: string[] = [];
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          const title = parent.getAttribute('title');
          if (title) titles.push(title);
        }
        return titles;
      }), [], 'image hover must not inherit a native rectangular title tooltip');
      try {
        await page.waitForFunction(expected => document.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === expected,
          { timeout: 1500 }, expected);
      } catch (error) {
        throw new Error(`${large ? 'large' : 'ordinary'} ${fixture.name}: linked image hover must show the outer destination`, { cause: error });
      }
      assert.equal(await page.$$eval('.meo-tooltip.is-visible', elements => elements.length), 1, 'linked images show one destination hint');
      if (fixture.name === 'HTML link title' && !large) {
        mkdirSync('.local/probes/linked-image-hover', { recursive: true });
        await page.screenshot({ path: '.local/probes/linked-image-hover/html-link-title.png' });
      }
      assert.equal(await page.$eval('img[alt="picture"]', element => getComputedStyle(element).cursor), 'pointer');
      await page.keyboard.down('Control');
      await page.keyboard.up('Control');
      await page.waitForFunction(expected => document.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === expected,
        { timeout: 1500 }, expected);
      assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', element => element.textContent), expected,
        'direct image hover keeps its hint across modifier changes');
      await page.keyboard.press('Escape');
      assert.equal(await page.$('.meo-tooltip.is-visible'), null);
      await page.keyboard.down('Control');
      await page.click('img[alt="picture"]');
      await page.keyboard.up('Control');
      assert.deepEqual(await page.evaluate(() => (window as any).opened), [href], 'Ctrl click opens the outer target exactly once');
      assert.equal(await page.evaluate(() => (window as any).linkedImageEditor.getText()), text, 'hover and navigation preserve source');
      if (fixture.name === 'reference link') {
        const changedHref = 'https://example.com/changed';
        await page.mouse.move(0, 0);
        await page.evaluate(({ href, changedHref }) => {
          const editor = (window as any).linkedImageEditor;
          const from = editor.getText().lastIndexOf(href);
          editor.view.dispatch({ changes: { from, to: from + href.length, insert: changedHref } });
        }, { href, changedHref });
        await page.waitForFunction(changedHref => document.querySelector('.meo-md-image-linked')?.getAttribute('data-meo-link-href') === changedHref,
          { timeout: 5000 }, changedHref);
        await page.hover('img[alt="picture"]');
        await page.waitForFunction(changedHref => document.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === 'Go to: ' + changedHref,
          { timeout: 1500 }, changedHref);
        await page.mouse.move(0, 0);
        await page.evaluate(() => (window as any).linkedImageEditor.undo());
        await page.waitForFunction(href => document.querySelector('.meo-md-image-linked')?.getAttribute('data-meo-link-href') === href,
          { timeout: 5000 }, href);
        assert.equal(await page.evaluate(() => (window as any).linkedImageEditor.getText()), text, 'reference undo restores source and image destination');
      }
      if (fixture.name === 'table' && !large) {
        await page.mouse.move(0, 0);
        await page.hover('img[alt="picture"]');
        await page.waitForSelector('.meo-tooltip.is-visible');
        mkdirSync('.local/probes/linked-image-hover', { recursive: true });
        await page.screenshot({ path: '.local/probes/linked-image-hover/table.png' });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log('Linked image destinations passed: direct/reference, table/formatting and HTML; ordinary and bounded editor paths.');
} finally { await browser.close(); }
