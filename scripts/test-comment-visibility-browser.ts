import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-comment-visibility-'));
const repoRoot = path.resolve(import.meta.dir, '..');

try {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-html-content-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 850 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).__commentEditor = (window as any).HtmlContentHarness.createEditor({
        parent: document.getElementById('app'),
        text: 'Intro\n\nInline <!-- secret --> text\n\nInline <strong>before<!-- inline html note -->after</strong>.\n\n<!-- block\nsecret -->\n\n<div>before<!-- nested -->after</div>\n\n<div>\n<p>First paragraph</p>\n<!-- nested multiline\ncomment -->\n<p>Second paragraph</p>\n<!-- second <script>window.__commentInjected=true</script> note -->\n</div>\n\n<table>\n<tbody>\n<!-- table note -->\n<tr><td>Cell</td></tr>\n</tbody>\n</table>\n\n<ul>\n<!-- list note -->\n<li>Item</li>\n</ul>\n\n<div><p>Adjacent</p></div>\n<!-- trailing note -->\n\n<section><!-- unsafe note --><p>Unsupported</p></section>\n\n```html\n<!-- example -->\n```',
        initialMode: 'live',
        uiLanguage: 'en',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
      .some(block => block.textContent?.includes('First paragraph')));
    const rendered = await page.evaluate(() => {
      const block = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find(element => element.textContent?.includes('First paragraph'))!;
      return {
        paragraphs: block.querySelectorAll('p').length,
        notes: Array.from(block.querySelectorAll<HTMLElement>('.meo-md-html-comment')).map(note => note.textContent),
        sourceVisible: block.textContent?.includes('<p>') ?? false,
        injectedScript: Boolean(block.querySelector('script')) || Boolean((window as any).__commentInjected)
      };
    });
    assert.equal(rendered.paragraphs, 2);
    assert.deepEqual(rendered.notes, [
      'Comment · nested multiline\ncomment',
      'Comment · second <script>window.__commentInjected=true</script> note'
    ]);
    assert.equal(rendered.sourceVisible, false);
    assert.equal(rendered.injectedScript, false);
    const inlineHtml = await page.$eval('.meo-md-html-strong', element => ({
      text: element.textContent,
      note: element.querySelector('.meo-md-html-comment')?.textContent
    }));
    assert.equal(inlineHtml.text, 'beforeComment · inline html noteafter');
    assert.equal(inlineHtml.note, 'Comment · inline html note');
    const standaloneNotes = await page.$$eval('.meo-md-comment-note', notes => notes.map(note => note.textContent));
    assert.deepEqual(standaloneNotes, ['Comment · secret', 'Comment · block\nsecret', 'Comment · trailing note']);
    const structured = await page.evaluate(() => {
      const table = document.querySelector('.meo-md-html-block table');
      const list = document.querySelector('.meo-md-html-block ul');
      const tableNote = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-comment'))
        .find(note => note.textContent?.includes('table note'));
      const listNote = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-comment'))
        .find(note => note.textContent?.includes('list note'));
      return {
        cell: table?.querySelector('td')?.textContent,
        item: list?.querySelector('li')?.textContent,
        tableNoteVisible: Boolean(tableNote),
        listNoteVisible: Boolean(listNote),
        tableContainsNote: Boolean(table && tableNote && table.contains(tableNote)),
        listContainsNote: Boolean(list && listNote && list.contains(listNote))
      };
    });
    assert.deepEqual(structured, {
      cell: 'Cell', item: 'Item', tableNoteVisible: true, listNoteVisible: true,
      tableContainsNote: false, listContainsNote: false
    });
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
      .some(block => block.textContent?.includes('Unsupported'))), false);
    assert.match(await page.$eval('.cm-content', element => element.textContent ?? ''), /<section>/);
    assert.equal((await page.$$('.meo-md-html-warning')).length, 1);
    await page.click('.meo-md-html-strong .meo-md-html-comment');
    assert.equal(await page.evaluate(() => {
      const editor = (window as any).__commentEditor;
      return editor.view.state.selection.main.head === editor.view.state.doc.toString().indexOf('<!-- inline html note');
    }), true);
    await page.evaluate(() => {
      const block = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find(element => element.textContent?.includes('First paragraph'))!;
      block.querySelector<HTMLElement>('.meo-md-html-comment')!.click();
    });
    assert.equal(await page.evaluate(() => {
      const editor = (window as any).__commentEditor;
      return editor.view.state.selection.main.head === editor.view.state.doc.toString().indexOf('<!-- nested multiline');
    }), true);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-source-range'))
      .some(line => line.textContent?.includes('nested multiline')));
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-comment'))
      .find(note => note.textContent?.includes('table note'))!.click());
    assert.equal(await page.evaluate(() => {
      const editor = (window as any).__commentEditor;
      return editor.view.state.selection.main.head === editor.view.state.doc.toString().indexOf('<!-- table note');
    }), true);
    await page.evaluate(() => (window as any).__commentEditor.destroy());
    await page.close();
  } finally {
    await browser.close();
  }
  console.log('Comment visibility browser test passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
