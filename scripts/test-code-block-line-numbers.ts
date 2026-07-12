import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-code-line-numbers-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

async function waitForFrames(page: puppeteer.Page, count = 6): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-code-block-line-numbers-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const text = [
        '```ts',
        'const first = 1;',
        '',
        'const third = "a long logical line that wraps without gaining another number";',
        '```',
        '',
        '```',
        'plain text',
        '```',
        '',
        '```mermaid',
        'graph TD',
        'A-->B',
        '```',
        '',
        '    indented one',
        '    indented two',
        '',
        '```js',
        'tail one',
        'tail two'
      ].join('\n');
      (window as any).CodeBlockLineNumbersHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    const result = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'));
      return {
        numbers: lines.map((line) => line.dataset.meoCodeLineNumber ?? ''),
        text: lines.map((line) => line.textContent ?? ''),
        pseudoContent: lines.map((line) => getComputedStyle(line, '::before').content),
        mermaidNumbered: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'))
          .some((line) => line.textContent?.includes('graph TD') || line.textContent?.includes('A-->B'))
      };
    });

    const expectedNumbers = ['1', '2', '3', '1', '1', '2', '1', '2'];
    if (JSON.stringify(result.numbers) !== JSON.stringify(expectedNumbers)) {
      throw new Error(`Unexpected code line numbers: ${JSON.stringify(result.numbers)}`);
    }
    if (result.text[1] !== '') {
      throw new Error(`Empty code line was not preserved: ${JSON.stringify(result.text)}`);
    }
    if (result.pseudoContent.some((content) => content === 'none' || content === 'normal')) {
      throw new Error(`Code line number pseudo-elements were not rendered: ${JSON.stringify(result.pseudoContent)}`);
    }
    if (result.mermaidNumbered) {
      throw new Error('Rendered Mermaid source received code line numbers');
    }
    console.log('code block line number checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
