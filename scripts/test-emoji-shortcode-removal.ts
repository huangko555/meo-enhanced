import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-emoji-shortcode-removal-'));
const ordinaryText = ':smile: :not_real: 😄';

async function main(): Promise<void> {
  const rendered = renderMarkdownToHtml({
    markdownText: ordinaryText,
    markdownFilePath: 'C:/tmp/emoji-shortcodes.md',
    target: 'html'
  });
  assert.match(
    rendered.html,
    />:smile: :not_real: 😄<\/p>/,
    'Preview/export must preserve known and unknown shortcodes plus Unicode emoji as ordinary text'
  );

  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const snapshot = await page.evaluate(async (text) => {
      const app = document.getElementById('app')!;
      const harness = (window as any).TableStabilityHarness;
      const waitFrames = async () => {
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const create = async (documentText: string, initialMode: 'live' | 'source') => {
        app.replaceChildren();
        const editor = harness.createEditor({
          parent: app,
          text: documentText,
          initialMode,
          onApplyChanges() {}
        });
        await waitFrames();
        return editor;
      };

      const liveEditor = await create(`lead\n${text}`, 'live');
      const live = {
        text: document.querySelector<HTMLElement>('.cm-content')?.textContent ?? '',
        emojiWidgets: document.querySelectorAll('.meo-md-emoji').length
      };
      liveEditor.setMode('source');
      await waitFrames();
      const source = {
        text: document.querySelector<HTMLElement>('.cm-content')?.textContent ?? '',
        emojiWidgets: document.querySelectorAll('.meo-md-emoji').length
      };
      liveEditor.destroy();

      const tableEditor = await create(`| Value |\n| --- |\n| ${text} |`, 'live');
      const tablePreview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview');
      const table = {
        text: tablePreview?.textContent ?? '',
        emojiWidgets: tablePreview?.querySelectorAll('.meo-md-emoji').length ?? 0
      };
      tableEditor.destroy();

      return { live, source, table };
    }, ordinaryText);

    assert.equal(snapshot.live.text.includes(ordinaryText), true, 'Live must display shortcode source text');
    assert.equal(snapshot.live.emojiWidgets, 0, 'Live must not create Emoji-specific widgets');
    assert.equal(snapshot.source.text.includes(ordinaryText), true, 'Source must preserve shortcode and Unicode text');
    assert.equal(snapshot.source.emojiWidgets, 0, 'Source must not create Emoji-specific widgets');
    assert.equal(snapshot.table.text, ordinaryText, 'Table inline preview must preserve shortcode and Unicode text');
    assert.equal(snapshot.table.emojiWidgets, 0, 'Table inline preview must not create Emoji-specific widgets');
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('Emoji shortcode removal checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
