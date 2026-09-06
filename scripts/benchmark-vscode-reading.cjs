// Read-only native mode transitions, with optional image decoding and CPU probes.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
  const file = process.env.MEO_PERF_DOCUMENT;
  const output = process.env.MEO_PERF_OUTPUT;
  const imageLine = Number(process.env.MEO_PERF_IMAGE_LINE || 0);
  if (!file || !path.isAbsolute(file) || !output || !path.isAbsolute(output)
    || !Number.isSafeInteger(imageLine) || imageLine < 0) {
    throw Error('Absolute document/output paths and a non-negative image line are required');
  }
  const original = fs.readFileSync(file);
  const result = {
    vscode: vscode.version,
    sha256: createHash('sha256').update(original).digest('hex'), bytes: original.length,
    visible: process.env.MEO_PERF_VISIBLE === '1',
    profiled: process.env.MEO_PERF_PROFILE === '1',
    traced: process.env.MEO_PERF_TRACE === '1', imageLine, runs: []
  };
  let browser;
  let traceSession;
  try {
    browser = await puppeteer.connect({ browserURL: process.env.MEO_PERF_BROWSER_URL, defaultViewport: null });
    if (result.traced) {
      // A browser session includes the webview renderer that does not exist yet.
      traceSession = await browser.target().createCDPSession();
      await traceSession.send('Tracing.start', {
        categories: 'devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-devtools.timeline',
        transferMode: 'ReturnAsStream'
      });
      await traceSession.send('Tracing.recordClockSyncMarker', {syncId: 'meo-open-with'});
    }
    const openedAt = performance.now();
    let openError;
    const opening = vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor').catch(error => { openError = error; });
    let frame;
    for (let attempt = 0; attempt < 200 && !frame; attempt++) {
      if (openError) throw openError;
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        if (await candidate.$('.cm-content').catch(() => null)) { frame = candidate; break; }
      }
      if (!frame) await wait(50);
    }
    if (!frame) throw Error('No editor');
    result.openToEditorMs = performance.now() - openedAt;
    if (traceSession) await frame.evaluate(() => performance.mark('meo-editor-detected'));
    const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
    result.extensionVersion = extension?.packageJSON.version;
    if (extension) {
      result.builds = Object.fromEntries(['webview/dist/index.js', 'dist/extension.js', 'dist/export-runtime.js']
        .map(relative => [relative, createHash('sha256').update(
          fs.readFileSync(path.join(extension.extensionPath, relative))).digest('hex')]));
    }
    if (result.visible) await frame.page().bringToFront();
    result.environment = await frame.evaluate(() => ({
      width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      font: getComputedStyle(document.querySelector('.cm-content')).font,
      foreground: document.hasFocus(), mode: document.getElementById('app').dataset.mode,
      userAgent: navigator.userAgent
    }));
    let firstPreview = true;
    for (const mode of ['preview','source','live','source','preview','live']) {
      const traceLabel = `meo-switch-${result.runs.length}-${mode}`;
      if (traceSession) await frame.evaluate(label => performance.mark(`${label}-start`), traceLabel);
      const profile = result.profiled;
      if (profile) { await frame.client.send('Profiler.enable'); await frame.client.send('Profiler.start'); }
      const start = performance.now();
      await frame.click(`button[data-mode="${mode}"]`);
      await frame.waitForFunction(mode => {
        if (document.getElementById('app').dataset.mode !== mode) return false;
        if (mode === 'preview') return !document.querySelector('.editor-host').hasAttribute('data-preview-cover') && !!document.querySelector('.preview-frame').contentDocument?.querySelector('.meo-export-doc');
        return !document.querySelector('.editor-host').hidden && !!document.querySelector('.cm-content');
      }, {timeout:30000}, mode);
      result.runs.push({ mode, readyMs: performance.now() - start,
        foreground: await frame.evaluate(() => document.hasFocus()) });
      if (traceSession) await frame.evaluate(label => {
        performance.mark(`${label}-ready`);
        performance.measure(label, `${label}-start`, `${label}-ready`);
      }, traceLabel);
      if (profile) {
        const {profile: cpu} = await frame.client.send('Profiler.stop');
        const name = firstPreview && mode === 'preview' ? 'first-preview' : `switch-${result.runs.length - 1}-${mode}`;
        fs.writeFileSync(path.join(output, `${name}.cpuprofile`), JSON.stringify(cpu));
      }
      if (mode === 'preview' && firstPreview) {
        firstPreview = false;
        result.images = await frame.evaluate(() => {
          const doc = document.querySelector('.preview-frame').contentDocument;
          return [...doc.images].map((img, index) => ({
            index, line: img.closest('[data-source-line]')?.getAttribute('data-source-line'),
            deferred: img.hasAttribute('data-meo-deferred-image-src'),
            srcLength: img.src.length, width: img.naturalWidth
          }));
        });
        if (!imageLine) continue;
        const frameBox = await (await frame.$('.preview-frame')).boundingBox();
        if (!frameBox) throw Error('Preview has no visible bounds');
        // A trusted interaction ends the previous mode's pending anchor restore.
        await frame.page().mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
        await frame.page().mouse.wheel({deltaY: 1});
        await wait(100);
        await frame.evaluate(line => {
          const doc = document.querySelector('.preview-frame').contentDocument;
          const img = [...doc.images].find(img =>
            img.closest('[data-source-line]')?.getAttribute('data-source-line') === String(line));
          if (!img) throw Error(`No image at source line ${line}`);
          img.setAttribute('data-reading-target', 'true');
          img.closest('[data-source-line]').scrollIntoView({block: 'start'});
        }, imageLine);
        const imageStart = performance.now();
        try {
          await frame.waitForFunction(() => {
            const img = document.querySelector('.preview-frame').contentDocument.querySelector('[data-reading-target]');
            return img.complete && img.naturalWidth > 0 && !img.hasAttribute('data-meo-deferred-image-src')
              && img.src !== 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
          }, {timeout: 20000});
          result.imageLoaded = true;
        } catch { result.imageLoaded = false; }
        result.imageWaitMs = performance.now() - imageStart;
        result.imageResult = await frame.evaluate(() => {
          const img = document.querySelector('.preview-frame').contentDocument.querySelector('[data-reading-target]');
          const b = img.getBoundingClientRect();
          return { srcLength: img.src.length, complete: img.complete,
            width: img.naturalWidth, height: img.naturalHeight,
            visible: b.bottom > 0 && b.top < img.ownerDocument.defaultView.innerHeight,
            box: {top: b.top, width: b.width, height: b.height} };
        });
      }
    }
    await opening;
    if(openError) throw openError;
    if (imageLine && !result.imageLoaded) throw Error('Selected Preview image did not decode');
  } catch(error) { result.error=String(error.stack||error); throw error; }
  finally {
    if (traceSession) {
      let timer;
      try {
        const complete = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Trace completion timed out')), 15000);
          traceSession.once('Tracing.tracingComplete', event => { clearTimeout(timer); resolve(event); });
        });
        const [{stream}] = await Promise.all([complete, traceSession.send('Tracing.end')]);
        const traceErrors = [];
        let descriptor;
        try {
          descriptor = fs.openSync(path.join(output, 'reading.trace.json'), 'w');
          while (true) {
            const chunk = await traceSession.send('IO.read', {handle: stream});
            fs.writeSync(descriptor, Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
            if (chunk.eof) break;
          }
        } catch (error) { traceErrors.push(error); }
        finally {
          if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (error) { traceErrors.push(error); }
          }
          try { await traceSession.send('IO.close', {handle: stream}); } catch (error) { traceErrors.push(error); }
        }
        if (traceErrors.length) throw new AggregateError(traceErrors, traceErrors.map(String).join('\n'));
      } catch (error) { result.traceError = String(error.stack || error); }
      finally { clearTimeout(timer); }
    }
    browser?.disconnect(); result.originalUnchanged=original.equals(fs.readFileSync(file));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
    if (!result.originalUnchanged) throw Error('The input document changed during the read-only probe');
    if (result.traceError && !result.error) throw Error(result.traceError);
  }
};
