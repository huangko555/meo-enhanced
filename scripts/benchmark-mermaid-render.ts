import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launchTestBrowser } from './browser-test-helpers';

// One diagram through the production editor and real Mermaid runtime. Optional
// arguments select an opening fence in a local document; its contents stay local.
const [documentPath, lineArgument] = process.argv.slice(2);
let source = ['flowchart TD', ...Array.from({ length: 40 }, (_, i) => `N${i}[Step ${i}] --> N${i + 1}`)].join('\n');
if (documentPath) {
  const lines = fs.readFileSync(documentPath, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const line = Number(lineArgument);
  assert.ok(Number.isInteger(line) && line > 0 && /^```mermaid\s*$/.test(lines[line - 1] ?? ''), 'Provide the Mermaid opening-fence line');
  const end = lines.findIndex((text, index) => index >= line && /^```\s*$/.test(text));
  assert.ok(end >= line, 'Missing closing fence');
  source = lines.slice(line, end).join('\n');
}
const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const result = await page.evaluate(async (source) => {
    const runtime = (window as any).mermaid;
    const render = runtime.render.bind(runtime);
    const renders: number[] = [];
    runtime.render = async (...args: unknown[]) => {
      const start = performance.now();
      try { return await render(...args); }
      finally { renders.push(performance.now() - start); }
    };
    const tasks: number[] = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    const start = performance.now();
    const harness = (window as any).MermaidEditingHarness;
    const editor = harness.createEditor({ parent: document.getElementById('app'), text: `\`\`\`mermaid\n${source}\n\`\`\`\n\nafter`, initialMode: 'live', onApplyChanges() {} });
    const ready = async (selector: string) => {
      const deadline = performance.now() + 15000;
      while (!document.querySelector(selector)) {
        if (performance.now() > deadline) throw Error(`No rendered diagram: ${selector}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };
    try {
      await ready('.meo-mermaid-svg-wrapper svg');
      const coldReadyMs = performance.now() - start;
      const coldRenderCalls = renders.length;
      const splitStart = performance.now();
      document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
      await ready('.meo-mermaid-editing-block svg');
      return { coldReadyMs, renderMs: renders, coldRenderCalls, splitReadyMs: performance.now() - splitStart, splitRenderCalls: renders.length - coldRenderCalls, longTasks: tasks, userAgent: navigator.userAgent };
    } finally { observer.disconnect(); editor.destroy(); }
  }, source);
  const output = path.resolve('.local/probes', `mermaid-render-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const report = { sourceSha256: createHash('sha256').update(source).digest('hex'), sourceLines: source.split('\n').length, viewport: { width: 1100, height: 720 }, ...result };
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally { await browser.close(); }
