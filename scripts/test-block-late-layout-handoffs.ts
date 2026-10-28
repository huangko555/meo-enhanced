import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames, assertStablePaint, observedPaints } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

let failure: unknown;
try {
  for (const large of [false, true]) for (const layout of ['stacked', 'side']) {
    const label = `late-mermaid/${large ? 'large' : 'ordinary'}/${layout}`;
    const prefix = 'Prefix paragraph.\n\n'.repeat(40);
    const block = '```mermaid\nflowchart TD\nN0[Stage 0] --> N1[Stage 1]\n```';
    const text = prefix + block + '\n\nAFTER TARGET\n\n' + 'Tail paragraph.\n\n'.repeat(large ? 12000 : 50);
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, label + ': production size policy');
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const w = window as any, send = Worker.prototype.postMessage;
      w.pointerLayoutWorkerContexts = 0;
      Worker.prototype.postMessage = function(message: any, ...rest: any[]) {
        if (message?.blocks === true && typeof message.id === 'number') w.pointerLayoutWorkerContexts++;
        return send.call(this, message, ...rest);
      };
    });
    const host = await open(page, text, false, 'live');
    try {
      // A normal caret/active-line appearance change is not a layout failure.
      await page.addStyleTag({ content: '.cm-cursor{visibility:hidden!important}.cm-editor .cm-activeLine{background:transparent!important;box-shadow:none!important}' });
      await page.evaluate(pos => {
        const w = window as any, v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        w.pointerLayoutView = v; v.scrollDOM.scrollTop = v.lineBlockAt(pos).top - 150;
      }, prefix.length);
      await frames(page, 12);
      await page.waitForSelector('.meo-mermaid-svg-wrapper > svg');
      await page.click('.meo-mermaid-mode-btn'); await frames(page, 12);
      if ((await page.$('.meo-mermaid-inline-preview') !== null) !== (layout === 'side')) {
        await page.click('.meo-mermaid-layout-btn'); await frames(page, 12);
      }
      assert.equal(await page.$('.meo-mermaid-inline-preview') !== null, layout === 'side', label + ': actual editing layout');
      const insertAt = prefix.length + block.lastIndexOf('\n```');
      await page.evaluate(pos => {
        const w = window as any, render = w.mermaid.render.bind(w.mermaid);
        w.pointerLayoutReleases = []; w.pointerLayoutHold = true;
        // Keep the real Mermaid render; only its completion is held. The old
        // chart stays visible until the user has exited the source block.
        w.mermaid.render = async (...args: any[]) => {
          const result = await render(...args);
          if (w.pointerLayoutHold) await new Promise(resolve => w.pointerLayoutReleases.push(resolve));
          return result;
        };
        const v = w.pointerLayoutView;
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); v.focus();
      }, insertAt);
      const inserted = '\nN1 --> N2[Added node]\nN2 --> N3[Added node]';
      await page.keyboard.type(inserted);
      await page.waitForFunction(() => (window as any).pointerLayoutReleases.length > 0);
      const expected = text.slice(0, insertAt) + inserted + text.slice(insertAt);
      assert.equal(host.readHost(), expected, label + ': native source edit');
      // Deliberately outlive the finite input/layout settlement window while
      // the real render is still held, then establish a fresh pointer target.
      await frames(page, 40);
      assert.equal(await page.$('.meo-mermaid-inline-preview') !== null, layout === 'side', label + ': pending render retains editing layout');
      await page.mouse.move(1200, 600); await page.mouse.wheel({ deltaY: 1 }); await frames(page, 8);
      const after = expected.indexOf('AFTER TARGET');
      await page.evaluate(pos => { const v = (window as any).pointerLayoutView;
        v.dispatch({ effects: v.constructor.scrollIntoView(pos, { y: 'center' }) }); }, after);
      await frames(page, 12);
      const point = await page.evaluate(pos => {
        const w = window as any, v = w.pointerLayoutView, r = v.coordsAtPos(pos)!;
        const line = [...v.contentDOM.querySelectorAll('.cm-line')].find((e: any) => e.textContent === 'AFTER TARGET');
        w.pointerLayoutPhase = 'held'; w.__presentationFrames = []; w.pointerLayoutSampling = true;
        const sample = () => requestAnimationFrame(() => setTimeout(() => {
          if (!w.pointerLayoutSampling) return;
          const current = [...v.contentDOM.querySelectorAll('.cm-line')].find((e: any) => e.textContent === 'AFTER TARGET');
          w.__presentationFrames.push({ phase: w.pointerLayoutPhase, top: current?.getBoundingClientRect().top,
            scroll: v.scrollDOM.scrollTop, mode: document.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') });
          sample();
        }, 0)); sample();
        return { x: Math.ceil(r.left + 2), y: Math.floor((r.top + r.bottom) / 2), top: line?.getBoundingClientRect().top };
      }, after);
      assert.ok(point.top > 150 && point.top < 700, label + ': visible painted target before native input');
      await assertStablePaint(page, { left: point.x, top: point.y - 10, width: 100, height: 20 }, async () => {
        await page.mouse.move(point.x, point.y); await page.mouse.down(); await frames(page, 4);
        assert.equal(await page.$eval('.meo-mermaid-toolbar', e => e.getAttribute('data-meo-mermaid-mode')), 'edit', label + ': held source');
        await page.mouse.up(); await frames(page, 30);
        assert.equal(await page.$eval('.meo-mermaid-toolbar', e => e.getAttribute('data-meo-mermaid-mode')), 'preview', label + ': source retired');
        await page.evaluate(() => { const w = window as any; w.pointerLayoutPhase = 'late'; w.pointerLayoutHold = false;
          w.pointerLayoutReleases.splice(0).forEach((resolve: any) => resolve()); });
        await page.waitForFunction(() => document.querySelector('.meo-mermaid-svg-wrapper > svg')?.textContent?.includes('Added node'));
        await frames(page, 30);
      }, label);
      const final = await page.evaluate(() => {
        const w = window as any, v = w.pointerLayoutView; w.pointerLayoutSampling = false;
        return { head: v.state.selection.main.head, focus: v.hasFocus, workerContexts: w.pointerLayoutWorkerContexts,
          mounted: v.contentDOM.querySelectorAll('.cm-line').length };
      });
      assert.ok(final.focus && final.head >= after && final.head < after + 12, label + ': clicked text owns input');
      assert.equal(host.readHost(), expected, label + ': collapse/render never edits text');
      if (large) { assert.ok(final.workerContexts > 0, label + ': actual Worker context path');
        assert.ok(final.mounted < 250, label + ': bounded mounted document'); }
      fs.mkdirSync('.local/live-pointer-layout', { recursive: true });
      await page.screenshot({ path: `.local/live-pointer-layout/${label.replaceAll('/', '-')}.png` });
      // The retained layout destination must yield to an actual newer wheel.
      const beforeWheel = await page.evaluate(() => (window as any).pointerLayoutView.scrollDOM.scrollTop);
      await page.mouse.move(1200, 650); await page.mouse.wheel({ deltaY: 160 }); await frames(page, 30);
      assert.ok(await page.evaluate(before => (window as any).pointerLayoutView.scrollDOM.scrollTop > before + 80, beforeWheel),
        label + ': new user scrolling retires the clicked destination');
      assert.deepEqual(host.errors, []);
      console.log(label + ' passed');
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Late block layout handoffs passed: 4 ordinary/large cases, both layouts and ${observedPaints} compositor frames`);
} catch (error) { failure = error; }
server.stop(true);
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
