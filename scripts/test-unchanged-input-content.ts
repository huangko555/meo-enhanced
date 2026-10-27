import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames, assertStablePaint, observedPaints, captureResult } from './input-presentation-test-helpers';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const padding = 'Padding paragraph with **formatting** and enough source context to exercise the complete one MiB document while editing.\n\n'.repeat(10_000);
assert.ok(Buffer.byteLength(padding) > 1_048_576);
const prefix = ['Preserved opening paragraph.', '', '# Preserved heading', '', 'Preserved **strong** and $x^2$, reference[^one] and [link](https://example.com/).', '',
  '[^one]: Preserved footnote.', '', '<details open><summary>Preserved HTML</summary>Preserved body.</details>', '',
  '![Preserved image](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)', '',
  '| Stable | Table |', '| --- | --- |', '| Row | Value |', '', '```js', 'const preserved = 1;', '```', '',
  'Repeated witness $x^2$.', '', 'Repeated witness $x^2$.', ''].join('\n');
const cases = {
  prose: 'Typing target.', heading: '## Heading target', list: '- List target', quote: '> Quote target',
  footnote: 'Reference[^two].\n\n[^two]: Footnote target.', code: '```text\nCode target\n```',
  html: '<div>Html target</div>', math: '$$\nx+1\n$$', latex: '```latex\nx+1\n```',
  mermaid: '```mermaid\nflowchart TD\nA-->B\n```', table: '| Kind | Content |\n| --- | --- |\n| Row | Target |'
} as const;
type Scene = keyof typeof cases;

async function focus(page: Page, scene: Scene) {
  if (scene === 'table') {
    await page.evaluate(() => {
      const input = [...document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea')]
        .find(input => input.value === 'Target')!;
      input.focus({ preventScroll: true }); input.setSelectionRange(0, 0);
    });
  } else {
    await page.evaluate(scene => {
      const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
      const needle = scene === 'mermaid' ? 'A-->B' : scene === 'math' || scene === 'latex' ? 'x+1' : `${scene === 'prose' ? 'Typing' : scene[0]!.toUpperCase() + scene.slice(1)} target`;
      const at = view.state.doc.toString().indexOf(needle);
      if (at < 0) throw new Error(`Missing ${needle}`);
      view.dispatch({ selection: { anchor: at + needle.length } }); view.focus();
    }, scene);
  }
  await delay(600); await frames(page, 6);
}

async function observe(page: Page, preview: boolean) {
  return page.evaluate(preview => {
    const scope = window as any;
    const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
    const root = preview ? document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('main.meo-export-doc')!
      : view.contentDOM as HTMLElement;
    const signature = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      for (const node of [copy, ...copy.querySelectorAll('*')]) {
        for (const name of ['data-source-line', 'data-source-end-line', 'data-meo-preview-block']) node.removeAttribute(name);
        // Rebinding a hint can reorder attributes without changing its content.
        // Preserve their names, namespaces and values while comparing semantics.
        const attributes = [...node.attributes].sort((left, right) => left.name.localeCompare(right.name));
        for (const attribute of attributes) node.removeAttributeNode(attribute);
        for (const attribute of attributes) node.setAttributeNodeNS(attribute);
      }
      return copy.outerHTML;
    };
    const witnesses = [...root.querySelectorAll(preview ? ':scope > [data-source-line]:not([data-meo-preview-gap])' : ':scope > *')]
      .filter(element => {
        const r = element.getBoundingClientRect();
        if (!(element.textContent?.trim() || element.matches('img') || element.querySelector('img')) || r.top < 80 || r.bottom > 820) return false;
        // Live selection reveal belongs to the edited block. All earlier source
        // lines are unchanged; Preview additionally retains later reading roots.
        return preview ? !element.textContent.includes('Typing target') : view.posAtDOM(element) < view.state.doc.toString().indexOf('## Input section');
      }).map(element => {
        const nodes: Node[] = [];
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ALL);
        while (walker.nextNode()) nodes.push(walker.currentNode);
        return { element, nodes, html: signature(element), label: element.textContent!.slice(0, 40) };
      });
    const changes = new Set<string>(); let mutations = 0;
    const check = () => {
      for (const witness of witnesses) if (!witness.element.isConnected || witness.nodes.some(node => !node.isConnected)
        || signature(witness.element) !== witness.html) changes.add(witness.label);
    };
    const observer = new MutationObserver(records => { mutations += records.length; check(); });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    scope.__unchangedContent = { read() { check(); return { changes: [...changes], mutations, witnesses: witnesses.length }; }, stop() { observer.disconnect(); } };
    const last = witnesses.filter(witness => !preview || Number(witness.element.getAttribute('data-source-line')) < 16).at(-1)?.element;
    const end = last?.getBoundingClientRect().bottom ?? 0;
    const offset = preview ? document.querySelector('.preview-frame')!.getBoundingClientRect() : { left: 0, top: 0 };
    return { witnesses: witnesses.length, clip: { left: Math.ceil(offset.left + 80), top: Math.ceil(offset.top + 80), width: preview ? 400 : 900,
      height: Math.floor(Math.min(200, end - 80)) } };
  }, preview);
}

async function assertObserverSemantics() {
  const page = await browser.newPage(), host = await open(page, 'Typing target.\n\n' + prefix + '\n\nTail witness.\n', true);
  try {
    await page.locator('.source-preview-button').click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('.footnote-backref')?.hasAttribute('data-tooltip'));
    await delay(700); await frames(page, 6);
    const baseline = await observe(page, true); assert.ok(baseline.witnesses >= 4);
    const reordered = await page.evaluate(() => {
      const link = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.footnote-backref')!;
      const before = link.outerHTML;
      const attributes = [...link.attributes].reverse();
      for (const attribute of attributes) link.removeAttributeNode(attribute);
      for (const attribute of attributes) link.setAttributeNodeNS(attribute);
      return { before, after: link.outerHTML };
    });
    assert.notEqual(reordered.after, reordered.before, 'The control must actually change raw attribute serialization order');
    await frames(page, 2);
    assert.deepEqual(await page.evaluate(() => (window as any).__unchangedContent.read().changes), [],
      'The observer accepts reordered attributes with identical names and values');
    await page.evaluate(() => {
      const link = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.footnote-backref')!;
      link.setAttribute('data-meo-preview-href', '#different-reference');
    });
    assert.ok((await page.evaluate(() => (window as any).__unchangedContent.read().changes)).length > 0,
      'The observer must still reject a changed link destination');
    await page.evaluate(() => {
      (window as any).__unchangedContent.stop();
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.footnote-backref')!
        .setAttribute('data-meo-preview-href', '#fnref-1');
    });
    await observe(page, true);
    await page.evaluate(() => {
      const link = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('.footnote-backref')!;
      link.replaceWith(link.cloneNode(true));
    });
    assert.ok((await page.evaluate(() => (window as any).__unchangedContent.read().changes)).length > 0,
      'The observer must still reject replacement by an identical cloned node');
    await page.evaluate(() => (window as any).__unchangedContent.stop());
    console.log('Unchanged-content observer controls passed: attribute order, changed destination and identical node replacement');
  } finally { host.dispose(); await page.close(); }
}

let primary: unknown, stage = 'startup';
try {
  await assertObserverSemantics();
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
  const sceneOnly = process.argv.find(arg => arg.startsWith('--scene='))?.slice(8);
  for (const large of process.argv.includes('--small-only') ? [false] : process.argv.includes('--large-only') ? [true] : [false, true]) {
    if (!only || only === 'live') for (const scene of Object.keys(cases) as Scene[]) {
      if (sceneOnly && sceneOnly !== scene) continue;
      stage = `Live ${scene}, large ${large}`;
      const text = prefix + '\n\n## Input section\n\n' + cases[scene] + '\n\nTail witness.\n\n' + (large ? padding : '');
      const page = await browser.newPage(), host = await open(page, text);
      page.on('pageerror', error => console.error(`${stage}:`, error.stack));
      try {
        await page.locator('.mode-group [data-mode="live"]').click();
        await page.waitForFunction(() => document.querySelector('.cm-editor.meo-mode-live') && !document.querySelector('.mode-group [aria-busy="true"]'));
        await focus(page, scene);
        const baseline = await observe(page, false); assert.ok(baseline.witnesses >= 4);
        await assertStablePaint(page, baseline.clip, async () => {
          await page.keyboard.type('7'); await delay(650);
          await page.keyboard.press('Backspace'); await delay(650);
        }, stage);
        const result = await page.evaluate(() => { const probe = (window as any).__unchangedContent; probe.stop(); return probe.read(); });
        assert.deepEqual(result.changes, [], `${stage}: unchanged DOM or rendered presentation was replaced`);
        assert.equal(host.readHost(), text, `${stage}: exact input and deletion`); assert.deepEqual(host.errors, []);
        console.log(stage, JSON.stringify(result)); await captureResult(page, stage);
      } finally { host.dispose(); await page.close(); }
    }
    if (!only || only === 'preview') for (const mode of ['source', 'preview'] as const) {
      stage = `${mode === 'source' ? 'Source split' : 'Standalone'} Preview, large ${large}`;
      const text = 'Typing target.\n\n' + prefix + '\n\nTail witness.\n\n' + (large ? padding : '');
      const page = await browser.newPage(), host = await open(page, text, true);
      try {
        await page.locator('.source-preview-button').click();
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('table'));
        await page.evaluate(() => {
          const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
          view.dispatch({ selection: { anchor: 'Typing target.'.length } }); view.focus();
        });
        if (mode === 'preview') {
          await page.locator('.mode-group [data-mode="preview"]').click();
          await page.waitForFunction(() => !document.querySelector('.mode-group [aria-busy="true"]'));
        }
        await delay(700); await frames(page, 6);
        const baseline = await observe(page, true); assert.ok(baseline.witnesses >= 4);
        for (const insert of ['7', '\n\nNew paragraph.']) {
          if (mode === 'source') await page.keyboard.sendCharacter(insert);
          // Standalone Preview is read-only. Exercise actual host revisions,
          // rather than sending keyboard input into its hidden editor.
          else {
            const before = host.readHost(), at = before.indexOf('\n\n');
            await host.replaceHostText(before.slice(0, at) + insert + before.slice(at));
          }
          await delay(900);
          await page.waitForFunction(needle => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
            .querySelector('main.meo-export-doc')!.textContent!.includes(needle), {}, insert === '7' ? 'Typing target.7' : 'New paragraph.');
          const result = await page.evaluate(() => (window as any).__unchangedContent.read());
          assert.deepEqual(result.changes, [], `${stage}: unchanged Preview roots were rebuilt after ${JSON.stringify(insert)}`);
        }
        const expected = 'Typing target.7\n\n' + text.slice('Typing target.\n\n'.length);
        if (mode === 'preview') await host.replaceHostText(expected);
        else {
          await page.evaluate(() => (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view.focus());
          await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
        }
        await delay(900);
        await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector('main.meo-export-doc')!.textContent!.includes('New paragraph.'));
        assert.equal(host.readHost(), expected); assert.deepEqual(host.errors, []);
        // Insert immediately before a retained paragraph, then remove the whole
        // inserted block. Its original first line sits exactly on the edit end.
        const at = expected.indexOf('Preserved opening paragraph.'), lead = 'New lead with $x^2$.\n\n';
        if (mode === 'preview') await host.replaceHostText(expected.slice(0, at) + lead + expected.slice(at));
        else {
          await page.evaluate(at => {
            const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
            view.dispatch({ selection: { anchor: at } }); view.focus();
          }, at);
          await page.keyboard.sendCharacter(lead);
        }
        await delay(900);
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector('main.meo-export-doc')!.textContent!.includes('New lead with'));
        if (mode === 'preview') await host.replaceHostText(expected);
        else { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); }
        await delay(900);
        await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector('main.meo-export-doc')!.textContent!.includes('New lead with'));
        const result = await page.evaluate(() => { const probe = (window as any).__unchangedContent; probe.stop(); return probe.read(); });
        assert.deepEqual(result.changes, [], `${stage}: block insertion/removal rebuilt unchanged Preview roots`);
        // Keeping source-identical roots must not freeze rendered dependencies.
        // A new first reference renumbers the earlier, unchanged source paragraph.
        await host.replaceHostText(host.readHost().replace('Typing target.7', 'Typing target.7[^new]') + '\n[^new]: Added definition.\n');
        await page.waitForFunction(() => {
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
          const paragraph = [...doc.querySelectorAll('p')].find(element => element.textContent?.startsWith('Preserved strong'));
          return paragraph?.textContent?.includes('reference2 and link.');
        });
        console.log(stage, JSON.stringify(result)); await captureResult(page, stage);
      } catch (error) {
        console.error('Preview state', JSON.stringify({ sourceHead: host.readHost().slice(0, 200), renders: host.renders.length, errors: host.errors,
          dom: await page.evaluate(() => {
            const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
            return { head: doc?.querySelector('main')?.textContent?.slice(0, 350), references: [...doc?.querySelectorAll('.footnote-ref') ?? []].map(element => element.textContent) };
          }) }));
        throw error;
      } finally { host.dispose(); await page.close(); }
    }
  }
  if (!only || only === 'dependencies') for (const large of [false, true]) {
    stage = `Native table reference dependencies, large ${large}`;
    const text = '| A | B |\n| --- | --- |\n| Row | Native target |\n\nExisting reference[^existing].\n\n[^new]: New definition.\n\n[^existing]: Existing definition.\n\n' + (large ? padding : '');
    const page = await browser.newPage(), host = await open(page, text);
    try {
      await page.locator('.mode-group [data-mode="live"]').click();
      await page.waitForFunction(() => document.querySelector('.cm-editor.meo-mode-live') && !document.querySelector('.mode-group [aria-busy="true"]'));
      await page.evaluate(() => {
        const input = [...document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea')].find(input => input.value === 'Native target')!;
        input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length);
      });
      await page.keyboard.sendCharacter('[^new]');
      await page.waitForFunction(() => [...document.querySelectorAll('.editor-host .cm-line')].find(line => line.textContent?.startsWith('Existing reference'))
        ?.querySelector('.meo-md-footnote-ref')?.textContent === '2');
      assert.ok(host.readHost().includes('Native target[^new]'));
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
      await page.waitForFunction(() => [...document.querySelectorAll('.editor-host .cm-line')].find(line => line.textContent?.startsWith('Existing reference'))
        ?.querySelector('.meo-md-footnote-ref')?.textContent === '1');
      assert.equal(host.readHost(), text); assert.deepEqual(host.errors, []); console.log(stage, 'passed');
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Unchanged input content passed (${observedPaints} compositor paints)`);
} catch (error) { primary = error; console.error('Unchanged content failed during:', stage); throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
