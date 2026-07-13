import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-break-rendering-'));

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

async function waitForFrames(page: puppeteer.Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-html-break-rendering-entry.ts')],
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
    await page.setViewport({ width: 900, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:"Courier New"; --meo-font-source-weight:500; --meo-font-source-size:14px; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const source = [
      '---',
      'title: "<br>"',
      '---',
      'alpha<br>beta<br/>gamma<br />delta',
      'tail<br>',
      'next',
      '`inline<br>code`',
      '```html',
      'block<br>code',
      '```'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__htmlBreakSource = text;
      (window as any).__htmlBreakEditor = (window as any).HtmlBreakRenderingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await waitForFrames(page);

    const collectState = () => page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const firstLine = Array.from(content.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('alpha'))!;
      const textTop = (label: string): number | null => {
        const walker = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.indexOf(label) ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + label.length);
          return range.getBoundingClientRect().top;
        }
        return null;
      };
      return {
        firstLineText: firstLine.textContent ?? '',
        breakCount: firstLine.querySelectorAll('.meo-md-html-break').length,
        tops: ['alpha', 'beta', 'gamma', 'delta'].map(textTop),
        documentText: (window as any).__htmlBreakEditor.view.state.doc.toString(),
        documentLines: (window as any).__htmlBreakEditor.view.state.doc.lines,
        clickPoint: (() => {
          const top = textTop('beta');
          if (top === null) return null;
          const rect = firstLine.getBoundingClientRect();
          return { x: rect.left + 24, y: top + 6 };
        })()
      };
    });

    const initial = await collectState();
    if (initial.firstLineText.includes('<br') || initial.breakCount !== 3) {
      throw new Error(`HTML break tags were not hidden correctly: ${JSON.stringify(initial)}`);
    }
    if (
      initial.tops.some((top) => top === null) ||
      !initial.tops.every((top, index, tops) => index === 0 || Number(top) > Number(tops[index - 1]))
    ) {
      throw new Error(`HTML break widgets did not create visual lines: ${JSON.stringify(initial.tops)}`);
    }
    if (initial.documentText !== source || initial.documentLines !== source.split('\n').length) {
      throw new Error('HTML break rendering changed the Markdown document or its logical line count');
    }
    if (!initial.clickPoint) {
      throw new Error('Could not locate a rendered HTML break line for interaction testing');
    }

    await page.mouse.click(initial.clickPoint.x, initial.clickPoint.y);
    await waitForFrames(page);
    const active = await collectState();
    if (
      !active.firstLineText.includes('alpha<br>beta<br/>gamma<br />delta') ||
      active.breakCount !== 3
    ) {
      throw new Error(`Active HTML break line did not keep tags and visual breaks: ${JSON.stringify(active)}`);
    }
    if (
      active.tops.some((top) => top === null) ||
      !active.tops.every((top, index, tops) => index === 0 || Number(top) > Number(tops[index - 1]))
    ) {
      throw new Error(`Visual breaks disappeared after revealing source tags: ${JSON.stringify(active.tops)}`);
    }
    if (active.documentText !== source || active.documentLines !== source.split('\n').length) {
      throw new Error('Interacting with HTML breaks changed the Markdown source');
    }

    console.log('HTML break rendering browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
