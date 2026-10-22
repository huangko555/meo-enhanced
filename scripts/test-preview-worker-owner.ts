import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-owner-'));
try {
  const build = await Bun.build({ entrypoints: ['src/host/previewRenderWorker.ts'], target: 'node', format: 'cjs', minify: true });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  await Bun.write(path.join(root, 'owner.cjs'), build.outputs[0]!);
  for (const file of ['preview-render-worker.js', 'fallback-code-highlighter.js']) {
    fs.copyFileSync(path.join('dist', file), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, 'run.cjs'), `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const Module = require('node:module'), threads = require('node:worker_threads');
    const originalLoad = Module._load, originalTimer = global.setTimeout;
    const live = new Set(), readers = [], pause = ms => new Promise(resolve => originalTimer(resolve, ms));
    let creates = 0, shortTimeout = false;
    Module._load = function(name, ...rest) {
      if (name === 'node:worker_threads') return { ...threads, Worker: class extends threads.Worker {
        constructor(...args) { super(...args); creates++; live.add(this); this.once('exit', () => live.delete(this)); }
      } };
      return originalLoad.call(this, name, ...rest);
    };
    // Exercise the existing idle/timeout contracts without a 30-second sleep.
    global.setTimeout = (callback, ms, ...args) => originalTimer(callback,
      ms === 30000 ? 60 : shortTimeout && ms === 14000 ? 400 : ms, ...args);
    const { createBackgroundPreviewRenderer } = require('./owner.cjs');
    const workerFile = path.join(__dirname, 'preview-render-worker.js');
    const create = file => { const reader = createBackgroundPreviewRenderer(file || workerFile); readers.push(reader); return reader; };
    const options = { markdownText: '# Reader\\n\\nOrdinary **prose**.', sourceDocumentPath: 'C:/fixture.md', uiLanguage: 'en' };
    const waitStopped = async () => { for (let i=0;live.size && i<100;i++) await pause(20); assert.equal(live.size, 0, 'owned workers must stop'); };
    (async () => {
      try {
        const reader = create(); assert.equal(creates, 0, 'creating a panel must not launch Preview early');
        const [first, second] = await Promise.all([reader.render('panel-a', options), reader.render('panel-b', {
          ...options, markdownText: '| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n\\n$$\\nx^2\\n$$\\n\\n' + '\\x60\\x60\\x60js\\nconst n = 42;\\n\\x60\\x60\\x60'
        })]);
        assert.match(first.html, /<strong>prose<\\/strong>/); assert.match(second.html, /<table/);
        assert.match(second.html, /katex/); assert.match(second.html, /hljs-keyword/);
        assert.equal(creates, 1, 'full Preview panels share the existing renderer');
        await pause(120); assert.equal(live.size, 1, 'full Preview ownership survives the idle deadline');
        await reader.release('panel-a'); await pause(120); assert.equal(live.size, 1, 'releasing one panel preserves its peer');
        await reader.release('panel-b'); await waitStopped();

        const race = reader.render('closed-before-reply', options), release = reader.release('closed-before-reply');
        await Promise.all([race, release]); await waitStopped();
        assert.equal(creates, 2, 'late replies cannot retain a released panel');

        const jobs = Array.from({ length: 16 }, (_, index) => reader.render('queue', { ...options, markdownText: 'Queued ' + index }));
        await assert.rejects(reader.render('overflow', options), /queue is full/);
        assert.equal((await Promise.all(jobs)).length, 16);
        await reader.release('queue'); await waitStopped();

        await assert.rejects(reader.render('bad-preset', { ...options, preset: 'default', presetDefinition: { id: 'github-readme' } }), /preset/);
        await waitStopped();
        const window = await reader.open('window', 'revision-1', { ...options, markdownText: '# Start\\n\\n' + 'Paragraph.\\n\\n'.repeat(100) }, 1);
        assert.ok(window.document.blocks.length > 90);
        assert.ok((await reader.operate('window', 'revision-1', { kind: 'blocks', indices: [90] })).chunks.length);
        await pause(120); assert.equal(live.size, 1, 'logical and full readers retain the same lifetime policy');
        await reader.release('window'); await waitStopped();

        const pending = reader.render('disposed', options); reader.dispose();
        await assert.rejects(pending, /closed/); await waitStopped();
        await assert.rejects(reader.render('after-dispose', options), /closed/);

        const hungPath = path.join(__dirname, 'hung.cjs');
        fs.writeFileSync(hungPath, "require('node:worker_threads').parentPort.on('message', () => {});");
        const timed = create(hungPath); shortTimeout = true;
        await assert.rejects(timed.render('timeout', options), /timed out/); await waitStopped(); shortTimeout = false;
        fs.copyFileSync(workerFile, hungPath);
        assert.match((await timed.render('recovered', options)).html, /<strong>prose<\\/strong>/);
        timed.dispose(); await waitStopped();
        console.log('Preview owner: real Node rendering, shared leases, release races, bounded queue, logical reads, disposal, timeout and recovery passed');
      } finally {
        readers.forEach(reader => reader.dispose());
        await Promise.all([...live].map(worker => worker.terminate()));
        Module._load = originalLoad; global.setTimeout = originalTimer;
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  console.log(execFileSync('node', [path.join(root, 'run.cjs')], { encoding: 'utf8', timeout: 30_000 }).trim());
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
