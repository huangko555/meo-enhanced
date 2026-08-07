import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-block-inner-history-'));

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function pressShortcut(page: any, key: 'z' | 'y') {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await waitForFrames(page);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      (window as any).__blockHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```', '', '$$', 'x = 1', '$$'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      block.__meoMermaidEditingController.focusOffset(innerView.state.doc.length);
    });
    await page.keyboard.type('MERMAID_ONE');
    await new Promise((resolve) => setTimeout(resolve, 650));
    await page.keyboard.type('_TWO');
    await new Promise((resolve) => setTimeout(resolve, 650));
    await page.keyboard.type('_THREE');
    await waitForFrames(page);
    const mermaidEdited = await page.evaluate(() => (
      (window as any).__blockHistoryEditor.view.state.doc.toString()
    ));
    if (!mermaidEdited.includes('MERMAID_ONE_TWO_THREE')) {
      throw new Error(`Mermaid keyboard edit did not reach the outer document: ${mermaidEdited}`);
    }

    await pressShortcut(page, 'z');
    const mermaidFirstUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidFirstUndo.text.includes('_THREE') || !mermaidFirstUndo.text.includes('MERMAID_ONE_TWO') || !mermaidFirstUndo.focused) {
      throw new Error(`First Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mermaidFirstUndo)}`);
    }

    await pressShortcut(page, 'z');
    const mermaidSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidSecondUndo.text.includes('_TWO') || !mermaidSecondUndo.text.includes('MERMAID_ONE') || !mermaidSecondUndo.focused) {
      throw new Error(`Second Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify({ mermaidFirstUndo, mermaidSecondUndo })}`);
    }

    await pressShortcut(page, 'z');
    const mermaidThirdUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (mermaidThirdUndo.text.includes('MERMAID_ONE') || !mermaidThirdUndo.focused) {
      throw new Error(`Third Mermaid Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mermaidThirdUndo)}`);
    }

    for (let index = 0; index < 3; index += 1) {
      await pressShortcut(page, 'y');
    }
    const mermaidRedo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        focused: Boolean(innerView?.hasFocus),
        head: innerView?.state.selection.main.head ?? null
      };
    });
    if (!mermaidRedo.text.includes('MERMAID_ONE_TWO_THREE') || !mermaidRedo.focused) {
      throw new Error(`Mermaid Ctrl+Y was blocked inside its source editor: ${JSON.stringify(mermaidRedo)}`);
    }

    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')! as any;
      const innerView = block.__meoLatexMathEditingController.innerView;
      block.__meoLatexMathEditingController.focusOffset(innerView.state.doc.length);
    });
    await page.keyboard.type('MATH_ONE');
    await new Promise((resolve) => setTimeout(resolve, 650));
    await page.keyboard.type('_TWO');
    await waitForFrames(page);

    await pressShortcut(page, 'z');
    const mathFirstUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathFirstUndo.source !== 'x = 1MATH_ONE' || !mathFirstUndo.focused) {
      throw new Error(`First formula Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mathFirstUndo)}`);
    }

    await pressShortcut(page, 'z');
    const mathSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathSecondUndo.source !== 'x = 1' || !mathSecondUndo.focused) {
      throw new Error(`Second formula Ctrl+Z was blocked inside its source editor: ${JSON.stringify(mathSecondUndo)}`);
    }

    await pressShortcut(page, 'y');
    await pressShortcut(page, 'y');
    const mathRedo = await page.evaluate(() => {
      const editor = (window as any).__blockHistoryEditor;
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block');
      const innerView = (block as any)?.__meoLatexMathEditingController?.innerView;
      return {
        text: editor.view.state.doc.toString(),
        source: innerView?.state.doc.toString() ?? null,
        focused: Boolean(innerView?.hasFocus)
      };
    });
    if (mathRedo.source !== 'x = 1MATH_ONE_TWO' || !mathRedo.focused) {
      throw new Error(`Formula Ctrl+Y was blocked inside its source editor: ${JSON.stringify(mathRedo)}`);
    }

    console.log('block inner history checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
