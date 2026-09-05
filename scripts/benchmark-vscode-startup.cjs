// VS Code --extensionTestsPath entry. The input document is never edited.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const puppeteer = require('puppeteer-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
  const file = process.env.MEO_PERF_DOCUMENT;
  const output = process.env.MEO_PERF_OUTPUT;
  if (!file || !path.isAbsolute(file) || !output || !path.isAbsolute(output)) {
    throw Error('Absolute document and output paths are required');
  }
  const original = fs.readFileSync(file);
  const result = {
    vscode: vscode.version,
    bytes: original.length,
    sha256: createHash('sha256').update(original).digest('hex'),
    profiled: process.env.MEO_PERF_PROFILE === '1',
    visible: process.env.MEO_PERF_VISIBLE === '1',
    runs: []
  };
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: process.env.MEO_PERF_BROWSER_URL || 'http://127.0.0.1:9341',
      defaultViewport: null
    });
    const openedAt = performance.now();
    // Observe the webview while openWith is pending; waiting for the command
    // first can miss the initialization work this benchmark is meant to catch.
    let openError;
    const opening = vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor')
      .catch(error => { openError = error; });
    let frame;
    for (let attempt = 0; attempt < 150 && !frame; attempt++) {
      if (openError) throw openError;
      for (const candidate of (await browser.pages()).flatMap(page => page.frames())) {
        if (await candidate.$('.cm-content').catch(() => null)) { frame = candidate; break; }
      }
      if (!frame) await wait(50);
    }
    if (!frame) throw Error('No editor');
    result.openToEditorMs = performance.now() - openedAt;
    const extension = vscode.extensions.getExtension('huangko555.meo-enhanced');
    result.extensionVersion = extension?.packageJSON.version;
    if (extension) {
      result.webviewEntrySha256 = createHash('sha256').update(
        fs.readFileSync(path.join(extension.extensionPath, 'webview', 'dist', 'index.js'))
      ).digest('hex');
    }
    if (result.visible) {
      await frame.page().bringToFront();
      await frame.click('.cm-content');
    }
    result.environment = await frame.evaluate(() => ({
      width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      font: getComputedStyle(document.querySelector('.cm-content')).font,
      userAgent: navigator.userAgent
    }));
    for (const phase of ['cold', 'warm']) {
      if (phase === 'warm') {
        await frame.$eval('.cm-scroller', element => { element.scrollTop = 0; });
        await wait(5000);
      }
      const client = frame.client;
      if (result.profiled) {
        await client.send('Profiler.enable');
        await client.send('Profiler.start');
      }
      await frame.evaluate(() => {
        const probe = window.__scrollProbe = { frames: [], long: [], start: performance.now(), done: false };
        let last = probe.start;
        const observer = new PerformanceObserver(list => {
          probe.long.push(...list.getEntries().map(entry => ({ at: entry.startTime - probe.start, ms: entry.duration })));
        });
        observer.observe({ type: 'longtask' });
        const tick = () => {
          const now = performance.now();
          probe.frames.push({ at: now - probe.start, ms: now - last,
            focused: document.hasFocus(), visibility: document.visibilityState,
            top: document.querySelector('.cm-scroller').scrollTop });
          last = now;
          if (!probe.done) requestAnimationFrame(tick);
          else observer.disconnect();
        };
        requestAnimationFrame(tick);
      });
      const box = await (await frame.$('.cm-scroller')).boundingBox();
      if (!box) throw Error('Editor has no visible bounds');
      await frame.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 30; step++) {
        await frame.page().mouse.wheel({ deltaY: 60 });
        await wait(100);
      }
      await frame.evaluate(() => { window.__scrollProbe.done = true; });
      await wait(100);
      const data = await frame.evaluate(() => window.__scrollProbe);
      if (result.profiled) {
        const { profile } = await client.send('Profiler.stop');
        fs.writeFileSync(path.join(output, phase + '.cpuprofile'), JSON.stringify(profile));
      }
      const gaps = data.frames.map(frame => frame.ms).sort((a, b) => a - b);
      result.runs.push({
        phase, max: Math.max(...gaps), p95: gaps[Math.floor(gaps.length * .95)],
        foreground: data.frames.every(frame => frame.focused && frame.visibility === 'visible'),
        over50: gaps.filter(ms => ms > 50).length,
        longMs: data.long.reduce((total, task) => total + task.ms, 0), ...data
      });
    }
    await opening;
    if (openError) throw openError;
    if (!original.equals(fs.readFileSync(file))) throw Error('Original document changed');
  } catch (error) {
    result.error = String(error.stack || error);
    throw error;
  } finally {
    browser?.disconnect();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
};
