import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-list-layout-interaction-'));
const longText = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
const markdown = [
  `- bullet ${longText}`,
  `98. ordered-one ${longText}`,
  `99. ordered-two ${longText}`,
  `100. ordered-three ${longText}`,
  `- [ ] task ${longText}`,
  `  - nested ${longText}`
].join('\n');

type Alignment = { label: string; first: number; continuation: number; rectCount: number };

function assertAligned(entries: Alignment[], surface: string): void {
  assert.ok(entries.length >= 5, `${surface} did not expose the expected list bodies`);
  for (const entry of entries) {
    assert.ok(entry.rectCount >= 2, `${surface} ${entry.label} did not wrap`);
    assert.ok(
      Math.abs(entry.first - entry.continuation) <= 1,
      `${surface} ${entry.label} continuation moved from ${entry.first} to ${entry.continuation}`
    );
  }
}

function assertNoDirectionReversal(values: number[], label: string): void {
  let direction = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!;
    if (Math.abs(delta) <= 0.5) continue;
    const nextDirection = Math.sign(delta);
    if (direction !== 0) assert.equal(nextDirection, direction, `${label} reversed: ${JSON.stringify(values)}`);
    direction = nextDirection;
  }
}

async function assertListPrefixTyping(page: import('puppeteer-core').Page): Promise<void> {
  const settle = () => page.evaluate(async () => {
    for (let frame = 0; frame < 5; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  const scenarios = [
    ...['1.', '10.', '001.', '123456789.', '1)', '10)', '123456789)', '-', '+', '*']
      .map((marker) => ({ initial: '', marker })),
    { initial: '- parent\n  ', marker: '1.' },
    { initial: '> ', marker: '1)' },
    { initial: '> - ', marker: '1.' }
  ];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((dark) => {
      document.documentElement.style.setProperty('--meo-background', dark ? '#24292e' : '#fff');
      document.documentElement.style.setProperty('--meo-foreground', dark ? '#eee' : '#111');
    }, theme === 'dark');
    for (const scenario of scenarios) {
      const label = `${theme}: ${JSON.stringify(scenario)}`;
      await page.evaluate(({ initial }) => {
        const editor = (window as any).ListEditingHarness.createEditor({
          parent: document.getElementById('editor-host'), text: initial, initialMode: 'live', onApplyChanges() {}
        });
        (window as any).__listPrefixEditor = editor;
        (window as any).__readListPrefix = () => {
          const lineNumber = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
          const line = editor.view.contentDOM.querySelectorAll('.cm-line')[lineNumber - 1]!;
          const clip = editor.view.scrollDOM.getBoundingClientRect();
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let visible = '';
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const style = getComputedStyle(node.parentElement!);
            if (Number.parseFloat(style.fontSize) === 0 || style.visibility !== 'visible') continue;
            const marker = node.parentElement!.closest('.meo-md-list-marker');
            const markerLeft = marker?.getBoundingClientRect().left ?? clip.left;
            for (let offset = 0; offset < (node.textContent?.length ?? 0); offset += 1) {
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset + 1);
              if (Array.from(range.getClientRects()).some((rect) =>
                rect.width > 0.5 && rect.height > 0.5
                && rect.left >= Math.max(clip.left, markerLeft) - 0.5 && rect.right <= clip.right + 0.5
              )) visible += node.textContent![offset];
            }
          }
          const bullets = Array.from(line.querySelectorAll('.meo-md-list-marker-bullet-dot')).filter((dot) => {
            const rect = dot.getBoundingClientRect();
            return rect.width > 0.5 && rect.left >= clip.left - 0.5;
          }).length;
          return {
            text: editor.getText(), visible: visible.trimEnd(), bullets,
            ordered: line.querySelectorAll('.meo-md-list-marker-ordered').length, html: line.innerHTML
          };
        };
        (window as any).__armListPrefixFrames = () => {
          (window as any).__listPrefixFrames = new Promise((resolve) => {
            editor.view.contentDOM.addEventListener('beforeinput', () => {
              const samples: unknown[] = [];
              const sample = () => requestAnimationFrame(() => queueMicrotask(() => {
                samples.push((window as any).__readListPrefix());
                if (samples.length === 4) resolve(samples);
                else sample();
              }));
              sample();
            }, { capture: true, once: true });
          });
        };
        editor.view.dispatch({ selection: { anchor: initial.length } });
        editor.focus();
      }, scenario);
      const assertLiteral = (sample: { visible: string }, prefix: string) => {
        assert.ok(sample.visible.endsWith(prefix), `${label}: prefix ${prefix} was clipped: ${JSON.stringify(sample)}`);
      };
      try {
        let prefix = '';
        for (const character of scenario.marker) {
          prefix += character;
          await page.evaluate(() => (window as any).__armListPrefixFrames());
          await page.keyboard.type(character);
          const frames = await page.evaluate(() => (window as any).__listPrefixFrames);
          for (const frame of frames) assertLiteral(frame, prefix);
        }
        await page.keyboard.type(' ');
        await settle();
        const completed = await page.evaluate(() => (window as any).__readListPrefix());
        if (/^\d/.test(scenario.marker)) {
          assertLiteral(completed, String(Number.parseInt(scenario.marker, 10)) + scenario.marker.at(-1));
          assert.ok(completed.ordered > 0, `${label}: whitespace must complete the ordered marker`);
        } else {
          assert.ok(completed.bullets > 0, `${label}: whitespace must complete a visible bullet`);
        }
        // Delete only the separator; Backspace on an empty list normally exits it.
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.up('Shift');
        await page.keyboard.press('Backspace');
        await settle();
        const deleted = await page.evaluate(() => (window as any).__readListPrefix());
        assert.equal(deleted.text, scenario.initial + scenario.marker, `${label}: separator deletion`);
        assertLiteral(deleted, scenario.marker);
        await page.keyboard.type('word');
        await settle();
        const prose = await page.evaluate(() => (window as any).__readListPrefix());
        assert.equal(prose.text, scenario.initial + scenario.marker + 'word');
        assertLiteral(prose, scenario.marker + 'word');
      } finally {
        await page.evaluate(() => (window as any).__listPrefixEditor.destroy());
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--meo-background');
    document.documentElement.style.removeProperty('--meo-foreground');
  });
  console.log('list prefix typing and separator deletion frames passed in light/dark themes');
}

async function assertOrderedMarkerWidths(page: import('puppeteer-core').Page): Promise<void> {
  const fixtures = [
    { initial: '', prefix: '', start: 1, count: 12, suffix: '.', task: false, repeated: 1 },
    { initial: '', prefix: '> ', start: 98, count: 4, suffix: ')', task: false, repeated: 1 },
    { initial: '- parent\n\n', prefix: '  ', start: 98, count: 4, suffix: '.', task: false, repeated: 1 },
    { initial: 'paragraph\n', prefix: '', start: 9, count: 4, suffix: '.', task: false, repeated: 9 },
    { initial: '', prefix: '', start: 98, count: 4, suffix: '.', task: true, repeated: 1 }
  ];
  for (const fixture of fixtures) {
    const result = await page.evaluate(async ({ fixture, body }) => {
      const items = Array.from({ length: fixture.count }, (_, index) =>
        `${fixture.prefix}${index === 0 ? fixture.start : fixture.repeated}${fixture.suffix} ${fixture.task ? '[ ] ' : ''}item-${index} ${body}`
      );
      const text = fixture.initial + items.join('\n');
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('editor-host'), text, initialMode: 'live', onApplyChanges() {}
      });
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const markers = Array.from(editor.view.contentDOM.querySelectorAll('.meo-md-list-marker-ordered')).map((marker) => {
          const node = marker.firstChild!;
          const range = document.createRange();
          range.selectNode(node);
          const textBounds = range.getBoundingClientRect();
          return { text: node.textContent, left: textBounds.left, markerLeft: marker.getBoundingClientRect().left };
        });
        const alignment = [];
        const walker = document.createTreeWalker(editor.view.contentDOM, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.includes('item-')) continue;
          const range = document.createRange();
          range.selectNode(node);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5);
          alignment.push({ label: node.textContent, first: rects[0]?.left, continuation: rects[1]?.left, rectCount: rects.length });
        }
        return { markers, alignment, text: editor.getText(), original: text, checkboxes: editor.view.contentDOM.querySelectorAll('.meo-task-checkbox').length };
      } finally {
        editor.destroy();
      }
    }, { fixture, body: longText });
    assert.equal(result.text, result.original, 'display-width adjustment must preserve source numbers');
    assert.equal(result.markers.length, fixture.task ? 0 : fixture.count);
    assert.equal(result.checkboxes, fixture.task ? fixture.count : 0);
    for (const [index, marker] of result.markers.entries()) {
      assert.equal(marker.text, `${fixture.start + index}${fixture.suffix}`);
      assert.ok(marker.left >= marker.markerLeft - 0.5, `renumbered marker overflowed: ${JSON.stringify(marker)}`);
    }
    assert.equal(result.alignment.length, fixture.count);
    for (const body of result.alignment) {
      assert.ok(body.rectCount >= 2 && Math.abs(body.first! - body.continuation!) <= 1,
        `renumbered list body lost hanging alignment: ${JSON.stringify({ fixture, body })}`);
    }
  }
  console.log('ordered marker digit growth and hanging alignment checks passed');
}
async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const previewHtml = renderMarkdownToHtml({
      markdownText: markdown,
      markdownFilePath: 'list.md',
      target: 'html'
    }).html;
    const previewStyles = buildPreviewStyles({
      previewFontFamily: '',
      editorFontFamily: 'Arial, sans-serif',
      editorFontSizePx: 16
    }, 'light');
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 720, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body>
      <section id="editor-host"></section>
      <section id="preview-host"></section>
    </body>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: previewStyles });
    await page.addStyleTag({ content: `
      :root { --vscode-editor-font-family: Arial, sans-serif; --vscode-editor-font-size: 16px; }
      body { margin: 0; }
      #editor-host, #preview-host { box-sizing: border-box; width: 280px; height: 330px; overflow: auto; }
      #editor-host .cm-editor { height: 100%; }
      #editor-host .cm-gutters { display: none; }
      #preview-host { margin-left: 320px; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await assertListPrefixTyping(page);
    await assertOrderedMarkerWidths(page);

    const result = await page.evaluate(async ({ source, bodyText, previewHtml }) => {
      const harness = (window as any).ListEditingHarness;
      const host = document.getElementById('editor-host')!;
      const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const waitFrames = async (count = 3) => {
        for (let index = 0; index < count; index += 1) await waitFrame();
      };
      const bodyAlignment = (root: ParentNode, labels: string[]): Alignment[] => labels.map((label) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Text | null = walker.nextNode() as Text | null;
        while (node && !node.data.includes(label)) node = walker.nextNode() as Text | null;
        if (!node) throw new Error(`List body not found: ${label}`);
        const offset = node.data.indexOf(label);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, node.data.length);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5);
        return {
          label,
          first: rects[0]?.left ?? Number.NaN,
          continuation: rects[1]?.left ?? Number.NaN,
          rectCount: rects.length
        };
      });

      const applied: string[] = [];
      const editor = harness.createEditor({
        parent: host,
        text: source,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges(text: string) {
          applied.push(text);
        }
      });
      await waitFrames(4);
      const labels = [
        'bullet alpha',
        'ordered-one alpha',
        'ordered-two alpha',
        'ordered-three alpha',
        'task alpha',
        'nested alpha'
      ];
      const live = bodyAlignment(host, labels);

      editor.view.focus();
      const firstLine = editor.view.state.doc.line(1);
      editor.view.dispatch({ selection: { anchor: firstLine.to } });
      const focusBefore = editor.hasFocus();
      const scrollBefore = editor.getScrollElement().scrollTop;
      const samples: Array<{ x: number; y: number; scroll: number }> = [];
      const sample = () => {
        let line = editor.view.state.doc.line(1);
        for (let lineNumber = 1; lineNumber <= editor.view.state.doc.lines; lineNumber += 1) {
          const candidate = editor.view.state.doc.line(lineNumber);
          if (candidate.text.includes('ordered-one')) {
            line = candidate;
            break;
          }
        }
        const coords = editor.view.coordsAtPos(line.from + line.text.indexOf('ordered-one'));
        samples.push({
          x: coords?.left ?? Number.NaN,
          y: coords?.top ?? Number.NaN,
          scroll: editor.getScrollElement().scrollTop
        });
      };
      sample();
      editor.view.dispatch({
        changes: { from: firstLine.to, insert: '\n99. inserted list item' },
        selection: { anchor: firstLine.to + '\n99. inserted list item'.length },
        annotations: [
          harness.userEvent.of('input.paste'),
          harness.isolateHistory.of('full')
        ]
      });
      for (let frame = 0; frame < 8; frame += 1) {
        await waitFrame();
        sample();
      }
      const afterPaste = editor.getText();
      const selectionAfterPaste = editor.view.state.selection.main.head;
      const focusAfterPaste = editor.hasFocus();
      const scrollAfterPaste = editor.getScrollElement().scrollTop;

      await editor.undo();
      const afterUndo = editor.getText();
      await editor.redo();
      const afterRedo = editor.getText();

      editor.setMode('source');
      await waitFrames(2);
      const sourceLine = host.querySelector<HTMLElement>('.cm-line')!;
      const sourceStyle = getComputedStyle(sourceLine);
      const sourceLayout = {
        paddingLeft: sourceStyle.paddingLeft,
        textIndent: sourceStyle.textIndent,
        decoratedAsLiveList: sourceLine.classList.contains('meo-md-list-line')
      };

      editor.setMode('live');
      await waitFrames(3);
      const checkbox = host.querySelector<HTMLInputElement>('.meo-task-checkbox')!;
      const checkboxLabel = checkbox.getAttribute('aria-label');
      checkbox.click();
      await waitFrames(1);
      const afterCheckbox = editor.getText();
      const appliedAfterCheckbox = applied.at(-1) ?? '';

      for (let index = 0; index < 20; index += 1) {
        const at = editor.view.state.doc.length;
        editor.view.dispatch({
          changes: { from: at, insert: `\n${index + 1}. history-${index + 1}` },
          annotations: [
            harness.userEvent.of('input'),
            harness.isolateHistory.of('full')
          ]
        });
      }
      const afterTwenty = editor.getText();
      const undoResults: boolean[] = [];
      for (let index = 0; index < 20; index += 1) undoResults.push(await editor.undo());
      const afterTwentyUndo = editor.getText();
      const redoResults: boolean[] = [];
      for (let index = 0; index < 20; index += 1) redoResults.push(await editor.redo());
      const afterTwentyRedo = editor.getText();

      const previewHost = document.getElementById('preview-host')!;
      previewHost.innerHTML = previewHtml;
      await waitFrames(2);
      const previewAlignment = bodyAlignment(previewHost, labels);

      const output = {
        live,
        previewAlignment,
        sourceLayout,
        samples,
        focusBefore,
        focusAfterPaste,
        scrollBefore,
        scrollAfterPaste,
        afterPaste,
        selectionAfterPaste,
        afterUndo,
        afterRedo,
        afterCheckbox,
        checkboxLabel,
        appliedAfterCheckbox,
        afterTwenty,
        undoResults,
        afterTwentyUndo,
        redoResults,
        afterTwentyRedo,
        bodyText
      };
      editor.destroy();
      return output;
    }, { source: markdown, bodyText: longText, previewHtml });

    await page.evaluate(() => {
      const harness = (window as any).ListEditingHarness;
      const host = document.getElementById('editor-host')!;
      host.replaceChildren();
      const changes: string[] = [];
      const editor = harness.createEditor({
        parent: host,
        text: '3. alpha',
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges(text: string) {
          changes.push(text);
        }
      });
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
      (window as any).__listInteraction = { editor, changes };
    });
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const enterExit = await page.evaluate(() => {
      const { editor, changes } = (window as any).__listInteraction;
      return {
        text: editor.getText(),
        selection: editor.view.state.selection.main.head,
        focused: editor.hasFocus(),
        changes: [...changes]
      };
    });

    await page.evaluate(() => {
      const { editor } = (window as any).__listInteraction;
      editor.setText('- parent\n- child', true);
      const child = editor.view.state.doc.line(2);
      editor.view.dispatch({ selection: { anchor: child.from + 2 } });
      editor.view.focus();
    });
    await page.keyboard.press('Tab');
    const afterIndent = await page.evaluate(() => (window as any).__listInteraction.editor.getText());
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const afterOutdent = await page.evaluate(() => (window as any).__listInteraction.editor.getText());

    await page.evaluate(() => {
      const { editor } = (window as any).__listInteraction;
      editor.setText('3. first\n4. second\n5. third', true);
      const second = editor.view.state.doc.line(2);
      editor.view.dispatch({ selection: { anchor: second.from + 3 } });
      editor.view.focus();
    });
    await page.keyboard.press('Tab');
    const orderedAfterIndent = await page.evaluate(() => (window as any).__listInteraction.editor.getText());
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const orderedAfterOutdent = await page.evaluate(() => (window as any).__listInteraction.editor.getText());

    await page.evaluate(() => {
      const { editor } = (window as any).__listInteraction;
      editor.setText('- alpha\n- beta', true);
      const beta = editor.view.state.doc.line(2);
      editor.view.dispatch({ selection: { anchor: beta.from + 2 } });
      editor.view.focus();
    });
    await page.keyboard.press('Backspace');
    const afterMarkerDelete = await page.evaluate(() => (window as any).__listInteraction.editor.getText());
    await page.keyboard.press('Backspace');
    const afterMerge = await page.evaluate(() => {
      const { editor } = (window as any).__listInteraction;
      const output = {
        text: editor.getText(),
        selection: editor.view.state.selection.main.head,
        focused: editor.hasFocus()
      };
      editor.destroy();
      delete (window as any).__listInteraction;
      return output;
    });

    await page.setViewport({ width: 1500, height: 720, deviceScaleFactor: 1 });
    const maxWidthGutterClearance = await page.evaluate(async () => {
      const harness = (window as any).ListEditingHarness;
      const host = document.getElementById('editor-host')!;
      host.replaceChildren();
      host.style.width = '100%';
      host.classList.add('editor-host');
      document.documentElement.classList.add('meo-content-max-width-enabled');
      document.documentElement.style.setProperty('--meo-content-max-width', '800px');
      const baseline = [
        '### 2026-08-28 | heading',
        '- unordered one',
        '- unordered two',
        '- unordered three',
        '- unordered four',
        '- unordered five'
      ].join('\n');
      const editor = harness.createEditor({
        parent: host,
        text: `${baseline}\n1. 44`,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      editor.setGitBaseline({ available: true, tracked: true, mode: 'fixed', baseText: baseline });
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const gutters = host.querySelector<HTMLElement>('.cm-gutters')!;
      gutters.style.display = 'flex';
      for (let index = 0; index < 2; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const marker = host.querySelector<HTMLElement>('.meo-md-list-marker-bullet')!;
      const diffMarker = host.querySelector<HTMLElement>('.meo-git-gutter-marker:not(.meo-git-gutter-spacer)')!;
      const output = {
        gutterRight: gutters.getBoundingClientRect().right,
        gutterPointerEvents: getComputedStyle(gutters).pointerEvents,
        diffMarkerPointerEvents: getComputedStyle(diffMarker).pointerEvents,
        markerLeft: marker.getBoundingClientRect().left,
        diffMarkers: host.querySelectorAll('.meo-git-gutter-marker:not(.meo-git-gutter-spacer)').length
      };
      editor.destroy();
      document.documentElement.classList.remove('meo-content-max-width-enabled');
      document.documentElement.style.removeProperty('--meo-content-max-width');
      host.style.width = '';
      host.classList.remove('editor-host');
      return output;
    });

    const localizedNavigation = await page.evaluate(async () => {
      const harness = (window as any).ListEditingHarness;
      const host = document.getElementById('editor-host')!;
      host.replaceChildren();
      const longCode = Array.from({ length: 20 }, (_, index) => `const long${index + 1} = ${index + 1};`).join('\n');
      const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      const text = `[Open](https://example.com)\n\n<details>\n<summary>More</summary>\nBody\n</details>\n\nFootnote[^1]\n\n[^1]: note\n\n[![Pixel](${pixel})](https://example.com)\n\n\`\`\`ts\nconst value = 1;\n\`\`\`\n\n\`\`\`js\n${longCode}\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n\n$$\nx^2\n$$\n\n> [!NOTE]\n> note\n\nColor #ff0000\n\n<div>HTML</div>\n\n<<<<<<< Current\ncurrent\n=======\nincoming\n>>>>>>> Incoming\n\n| A | B |\n| - | - |\n| one | two |\n\nplain`;
      const editor = harness.createEditor({
        parent: host,
        text,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      const lastLine = editor.view.state.doc.line(editor.view.state.doc.lines);
      editor.view.dispatch({ selection: { anchor: lastLine.to } });
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const read = (selector: string) => document.querySelector<HTMLElement>(selector)?.getAttribute('aria-label');
      const baseOutput = {
        openLink: read('.meo-md-link-open-btn'),
        details: read('.meo-md-details-summary'),
        detailsSource: read('.meo-md-details-source-toggle'),
        footnote: read('.meo-md-footnote-ref'),
        footnoteBack: read('.meo-md-footnote-backref'),
        codeActions: Array.from(document.querySelectorAll('.meo-code-block-actions [aria-label]')).map((element) => element.getAttribute('aria-label')),
        longCode: {
          lineCountVisible: Boolean(document.querySelector(
            '.meo-md-long-code-placeholder .meo-long-code-line-count'
          )),
          action: read('.meo-md-long-code-placeholder .meo-long-code-action')
        },
        imageActions: Array.from(document.querySelectorAll<HTMLElement>(
          '.meo-md-image-controls [aria-label]'
        )).map((element) => element.getAttribute('aria-label'))
      };
      const revealText = async (needle: string) => {
        for (let lineNumber = 1; lineNumber <= editor.view.state.doc.lines; lineNumber += 1) {
          if (!editor.view.state.doc.line(lineNumber).text.includes(needle)) continue;
          // Keep the cursor outside the sampled rendered block. A regular line
          // jump intentionally enters that block's source-editing state.
          editor.restoreTopLine(lineNumber, 0, { syncCursor: false, force: true });
          for (let index = 0; index < 6; index += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          return;
        }
        throw new Error(`Localized control fixture text not found: ${needle}`);
      };
      await revealText('graph TD');
      const mermaidControl = document.querySelector<HTMLElement>(
        '.meo-mermaid-toolbar[role="group"]'
      )?.getAttribute('aria-label');
      const mermaidMode = read('.meo-mermaid-mode-btn');
      await revealText('x^2');
      const latexControl = document.querySelector<HTMLElement>(
        '.meo-latex-math-toolbar[role="group"]'
      )?.getAttribute('aria-label');
      const latexMode = read('.meo-latex-math-mode-btn');
      await revealText('> [!NOTE]');
      const alertLabel = document.querySelector('.meo-md-alert-label')?.textContent;
      await revealText('<div>HTML</div>');
      const htmlLabel = read('.meo-md-html-source-toggle');
      const output = {
        ...baseOutput,
        featureChrome: {
          alert: alertLabel,
          html: htmlLabel
        },
        renderedBlocks: {
          controls: [mermaidControl, latexControl],
          modes: [mermaidMode, latexMode]
        }
      };
      editor.destroy();
      return output;
    });

    assertAligned(result.live, 'Live');
    assertAligned(result.previewAlignment, 'Preview');
    assert.deepEqual(result.sourceLayout, {
      paddingLeft: '0px',
      textIndent: '0px',
      decoratedAsLiveList: false
    });
    assert.equal(result.focusBefore, true);
    assert.equal(result.focusAfterPaste, true);
    assert.ok(Math.abs(result.scrollAfterPaste - result.scrollBefore) <= 1);
    assert.ok(result.afterPaste.includes('99. inserted list item\n100. ordered-one'));
    assert.equal(result.selectionAfterPaste, markdown.indexOf('\n') + '\n99. inserted list item'.length);
    assert.equal(result.afterUndo, markdown);
    assert.equal(result.afterRedo, result.afterPaste);
    assert.ok(result.afterCheckbox.includes('- [x] task'));
    assert.equal(result.checkboxLabel, '标记任务为已完成');
    assert.deepEqual(localizedNavigation, {
      openLink: '打开链接',
      footnote: '跳转到脚注 1',
      footnoteBack: '跳转到脚注引用 1',
      codeActions: ['全选代码', '复制代码', '全选代码', '复制代码'],
      longCode: { lineCountVisible: false, action: '显示其余 10 行代码' },
      imageActions: ['打开链接', '刷新图片', '使用系统应用打开', '全屏查看图片'],
      featureChrome: {
        alert: '备注',
        html: '显示 HTML 源码'
      },
      renderedBlocks: {
        controls: ['第 41 行 Mermaid 块控件', '第 46 行公式块控件'],
        modes: ['以分栏视图编辑 Mermaid', '以分栏视图编辑公式']
      }
    });
    assert.equal(result.appliedAfterCheckbox, result.afterCheckbox, 'checkbox must publish exactly its accepted text');
    assert.ok(result.undoResults.every(Boolean), 'all 20 list edits must undo');
    assert.ok(result.redoResults.every(Boolean), 'all 20 list edits must redo');
    assert.equal(result.afterTwentyUndo, result.afterCheckbox);
    assert.equal(result.afterTwentyRedo, result.afterTwenty);
    assertNoDirectionReversal(result.samples.map((sample) => sample.x), 'list body x');
    assertNoDirectionReversal(result.samples.map((sample) => sample.y), 'list body y');
    assertNoDirectionReversal(result.samples.map((sample) => sample.scroll), 'list viewport');
    assert.equal(enterExit.text, '3. alpha\n4. beta\n');
    assert.equal(enterExit.selection, enterExit.text.length);
    assert.equal(enterExit.focused, true);
    assert.equal(enterExit.changes.at(-1), enterExit.text);
    assert.equal(afterIndent, '- parent\n  - child');
    assert.equal(afterOutdent, '- parent\n- child');
    assert.equal(orderedAfterIndent, '3. first\n  1. second\n4. third');
    assert.equal(orderedAfterOutdent, '3. first\n4. second\n5. third');
    assert.equal(afterMarkerDelete, '- alpha\nbeta');
    assert.deepEqual(afterMerge, {
      text: '- alphabeta',
      selection: '- alpha'.length,
      focused: true
    });
    assert.ok(maxWidthGutterClearance.diffMarkers > 0, 'wide Live fixture did not render the diff gutter marker');
    assert.ok(
      maxWidthGutterClearance.gutterPointerEvents === 'none' &&
      maxWidthGutterClearance.diffMarkerPointerEvents === 'none',
      `wide Live diff markers retained a pointer hit target: ${JSON.stringify(maxWidthGutterClearance)}`
    );

    console.log('list layout and interaction Chromium checks passed');
  } finally {
    await browser.close();
  }
}

await main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
