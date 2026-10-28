import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames, assertStablePaint, observedPaints } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

async function checkNeighborLayouts(): Promise<void> {
  let painted = 0;
  for (const large of [false, true]) {
    const label = `neighbor/${large ? 'large' : 'ordinary'}`;
    const prefix = 'Before paragraph.\n\n'.repeat(35);
    const graph = '```mermaid\nflowchart TD\n A[Start] --> B{Long code test}\n B -->|yes| C[Live mode]\n B -->|no| D[Other mode]\n```';
    const text = prefix + graph + '\n\nAfter diagram.\n\n$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n\n$$\n\n'
      + 'Following paragraph.\n\n'.repeat(large ? 12000 : 40);
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, label + ': production size policy');
    const outside = prefix.length + graph.length + 1, mathFrom = text.indexOf('$$', outside);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const w = window as any, send = Worker.prototype.postMessage; w.neighborWorkerContexts = 0;
      Worker.prototype.postMessage = function(message: any, ...rest: any[]) {
        if (message?.blocks === true && typeof message.id === 'number') w.neighborWorkerContexts++;
        return send.call(this, message, ...rest);
      };
    });
    const host = await open(page, text, false, 'live');
    try {
      await page.setViewport({ width: 800, height: 900, deviceScaleFactor: 1 });
      await page.addStyleTag({ content: `.meo-md-math-fenced-display[data-meo-math-anchor="${mathFrom}"]{background:#ff00ff!important}` });
      await page.evaluate(outside => {
        const w = window as any, v = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        w.neighborView = v;
        v.dispatch({ selection: { anchor: outside }, effects: v.constructor.scrollIntoView(outside, { y: 'center' }) }); v.focus();
      }, outside);
      await frames(page, 16); await page.waitForSelector('.meo-mermaid-svg-wrapper > svg');
      await page.evaluate(({ outside, mathFrom }) => {
        const w = window as any, v = w.neighborView;
        const r = v.coordsAtPos(outside)!; v.scrollDOM.scrollTop += r.top - 80;
        w.neighborMath = document.querySelector(`.meo-md-math-fenced-display[data-meo-math-anchor="${mathFrom}"]`);
      }, { outside, mathFrom });
      await frames(page, 12);
      for (const direction of ['enter', 'exit']) {
        if (direction === 'exit') {
          await page.mouse.move(750, 450); await page.mouse.wheel({ deltaY: 1 }); await frames(page, 6);
          await page.evaluate(pos => { const v = (window as any).neighborView;
            v.dispatch({ effects: v.constructor.scrollIntoView(pos, { y: 'center' }) }); }, text.indexOf('After diagram.'));
          await frames(page, 12);
        }
        const baseline = await page.evaluate(({ direction, from }) => {
          const w = window as any, v = w.neighborView, expectedMode = direction === 'enter' ? 'edit' : 'preview';
          const read = () => {
            const r = w.neighborMath.getBoundingClientRect();
            return { top: r.top, height: r.height, connected: w.neighborMath.isConnected,
              mode: document.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${from}"]`)?.getAttribute('data-meo-mermaid-mode') };
          };
          const epoch = document.createElement('div'); epoch.id = 'neighbor-paint-epoch';
          epoch.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none';
          document.body.append(epoch);
          const mark = () => { epoch.style.backgroundColor = read().mode === expectedMode ? 'rgb(20,180,80)' : 'rgb(20,60,180)'; };
          w.neighborObserver = new MutationObserver(mark);
          w.neighborObserver.observe(v.contentDOM, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-meo-mermaid-mode'] });
          mark(); w.neighborSamples = []; w.neighborSampling = true;
          const sample = () => requestAnimationFrame(() => setTimeout(() => {
            if (!w.neighborSampling) return; w.neighborSamples.push(read()); sample();
          }, 0)); sample();
          return read();
        }, { direction, from: prefix.length });
        assert.ok(baseline.top >= 40 && baseline.top + baseline.height < 900, label + ': visible formula positive control');
        await frames(page, 3);
        const client = await page.createCDPSession(), paints: string[] = [];
        client.on('Page.screencastFrame', event => { paints.push(event.data); void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }); });
        await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
        try {
          await frames(page, 2);
          if (direction === 'enter') await page.keyboard.press('ArrowUp');
          else {
            const point = await page.evaluate(pos => { const r = (window as any).neighborView.coordsAtPos(pos)!;
              return { x: Math.ceil(r.left + 2), y: Math.floor((r.top + r.bottom) / 2) }; }, text.indexOf('After diagram.'));
            await page.mouse.click(point.x, point.y);
          }
          await frames(page, 40);
          await client.send('Page.stopScreencast');
          const samples = await page.evaluate(() => { const w = window as any; w.neighborSampling = false;
            w.neighborObserver.disconnect(); document.getElementById('neighbor-paint-epoch')?.remove(); return w.neighborSamples; });
          const last = samples.at(-1), expectedMode = direction === 'enter' ? 'edit' : 'preview';
          assert.equal(last.mode, expectedMode, label + '/' + direction + ': actual mode transition');
          assert.ok(samples.every((s: any) => s.connected && s.height === baseline.height), label + ': unchanged formula identity/size');
          assert.ok(samples.filter((s: any) => s.mode === expectedMode).every((s: any) => Math.abs(s.top - last.top) <= 1),
            label + '/' + direction + ': second layout moved the neighboring formula ' + JSON.stringify(samples));
          if (direction === 'exit') assert.ok(Math.abs(last.top - baseline.top) <= 1, label + ': collapse only permits pixel rounding');
          let oldPaint = false, acceptedPaints = 0;
          const observed: Array<{ targetMode: boolean; top: number }> = [];
          for (const encoded of paints) {
            const { data, info } = await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            const marker = (4 * info.width + 4) * info.channels;
            const targetMode = data[marker] === 20 && data[marker + 1] === 180 && data[marker + 2] === 80;
            oldPaint ||= data[marker] === 20 && data[marker + 1] === 60 && data[marker + 2] === 180;
            let top = -1;
            for (let y = 0; y < info.height && top < 0; y++) {
              let count = 0;
              for (let x = 0; x < info.width; x++) { const p = (y * info.width + x) * info.channels;
                if (data[p]! > 240 && data[p + 1]! < 20 && data[p + 2]! > 240) count++; }
              if (count > 100) top = y;
            }
            observed.push({ targetMode, top });
            if (targetMode) { assert.ok(top >= 0 && Math.abs(top - Math.round(last.top)) <= 2,
              label + '/' + direction + ': painted formula moved ' + JSON.stringify(observed)); acceptedPaints++; }
          }
          assert.ok(oldPaint && acceptedPaints > 0, label + ': painted controls for both presentation states');
          painted += acceptedPaints;
        } finally { await client.detach(); }
      }
      assert.equal(host.readHost(), text, label + ': navigation preserves text');
      if (large) assert.ok(await page.evaluate(() => (window as any).neighborWorkerContexts > 0
        && (window as any).neighborView.contentDOM.querySelectorAll('.cm-line').length < 250), label + ': actual bounded Worker path');
      assert.deepEqual(host.errors, []);
      console.log(label + ': keyboard entry and pointer exit passed');
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Neighbor block layout passed: ordinary/large documents, ${painted} compositor frames`);
}

let failure: unknown;
try {
  const neighborOnly = process.argv.includes('--neighbor-only');
  if (!neighborOnly) for (const large of [false, true]) for (const layout of ['stacked', 'side']) {
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
  if (!neighborOnly) console.log(`Late block layout handoffs passed: 4 ordinary/large cases, both layouts and ${observedPaints} compositor frames`);
  await checkNeighborLayouts();
} catch (error) { failure = error; }
server.stop(true);
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
