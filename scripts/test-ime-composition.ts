import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-ime-composition-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-ime-composition-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = [
      '# 斜体的删除线',
      '',
      '## 标题组合：***粗斜体***、**粗体中的 `代码`**、~~删除线中的 *斜体*~~',
      '### 标题边界：**粗体中的 `代码`**后续',
      '### 错配组合：***粗斜体***、**粗体中的 ~~删除线~~**、~~删除线中的 *斜体*~~12',
      '### 左边界：12~~*斜体* 中的删除线~~',
      '### 左边界组合：12**`代码`中的粗体**、12*`代码`中的斜体*',
      '',
      '正文组合：***粗斜体***、**粗体中的 `代码`**、~~删除线中的 *斜体*~~',
      '',
      '正文边界：~~删除线中的 *斜体*~~后续',
      '',
      '正文双边界：12~~*斜体*~~34',
      '',
      '删除线输入：~~删除线~~',
      '',
      '| 内容 |',
      '| --- |',
      '| ***粗斜体***、**粗体中的 `代码`**、~~删除线中的 *斜体*~~后续、12~~*斜体* 中的删除线~~、12**`代码`中的粗体**、12*`代码`中的斜体* |'
    ].join('\n');
    await page.evaluate(({ text, theme }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text, version: 1, diagnostics: [], mode: 'live',
        lineNumbers: true, gitChangesGutter: false, gitDiffLineHighlights: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: true, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null
      }}));
    }, { text: initialText, theme: defaultThemeSettings });
    await page.waitForSelector('.editor-host > .cm-editor');
    const initialStrikePairing = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('错配组合'));
      return Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-strike') ?? [])
        .map((strike) => strike.textContent ?? '');
    });
    if (
      initialStrikePairing.length !== 2 ||
      initialStrikePairing[0] !== '删除线' ||
      initialStrikePairing[1] !== '删除线中的 *斜体*'
    ) {
      throw new Error(`Nested strike markers were paired across adjacent spans: ${JSON.stringify(initialStrikePairing)}`);
    }
    const boundaryRendering = await page.evaluate(() => {
      const strikeTexts = (label: string) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(label));
        return Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-strike') ?? [])
          .map((strike) => strike.textContent ?? '');
      };
      const outlineHeading = Array.from(document.querySelectorAll<HTMLElement>('.outline-item'))
        .find((item) => item.textContent?.includes('左边界'));
      const outlineCombined = Array.from(document.querySelectorAll<HTMLElement>('.outline-item'))
        .find((item) => item.textContent?.includes('左边界组合'));
      const combinedLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('左边界组合'));
      const tableStrikeTexts = Array.from(
        document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview .meo-md-strike')
      ).map((strike) => strike.textContent ?? '');
      const tableStrongTexts = Array.from(
        document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview .meo-md-strong')
      ).map((strong) => strong.textContent ?? '');
      const tableEmphasisTexts = Array.from(
        document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview .meo-md-em')
      ).map((emphasis) => emphasis.textContent ?? '');
      return {
        headingLeft: strikeTexts('左边界'),
        bodyBoth: strikeTexts('正文双边界'),
        combinedStrong: combinedLine?.querySelector<HTMLElement>('.meo-md-strong')?.textContent ?? '',
        combinedEmphasis: combinedLine?.querySelector<HTMLElement>('.meo-md-em')?.textContent ?? '',
        outlineHasStrike: Boolean(outlineHeading?.querySelector('del')),
        outlineHasStrong: Boolean(outlineCombined?.querySelector('strong')),
        outlineHasEmphasis: Boolean(outlineCombined?.querySelector('em')),
        tableStrikeTexts,
        tableStrongTexts,
        tableEmphasisTexts
      };
    });
    if (
      JSON.stringify(boundaryRendering.headingLeft) !== JSON.stringify(['*斜体* 中的删除线']) ||
      JSON.stringify(boundaryRendering.bodyBoth) !== JSON.stringify(['*斜体*']) ||
      !boundaryRendering.combinedStrong.includes('代码') ||
      !boundaryRendering.combinedStrong.includes('中的粗体') ||
      !boundaryRendering.combinedEmphasis.includes('代码') ||
      !boundaryRendering.combinedEmphasis.includes('中的斜体') ||
      !boundaryRendering.outlineHasStrike ||
      !boundaryRendering.outlineHasStrong ||
      !boundaryRendering.outlineHasEmphasis ||
      !boundaryRendering.tableStrikeTexts.some((text) => text.includes('斜体') && text.includes('中的删除线')) ||
      !boundaryRendering.tableStrongTexts.some((text) => text.includes('代码') && text.includes('中的粗体')) ||
      !boundaryRendering.tableEmphasisTexts.some((text) => text.includes('代码') && text.includes('中的斜体'))
    ) {
      throw new Error(`Inline style boundary rendering diverged: ${JSON.stringify(boundaryRendering)}`);
    }
    await page.click('.cm-line');
    await page.keyboard.press('End');

    const session = await page.createCDPSession();
    await session.send('Input.imeSetComposition', {
      text: 'hai',
      selectionStart: 3,
      selectionEnd: 3
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const preeditApplyCount = await page.evaluate(() => (
      (window as any).__hostMessages.filter((message: any) => message.type === 'applyChanges').length
    ));
    if (preeditApplyCount !== 0) {
      throw new Error(`IME preedit text was sent to the host ${preeditApplyCount} time(s)`);
    }
    await session.send('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0
    });
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
        data: '还',
        bubbles: true
      }));
    });
    await page.click('.cm-line');
    await page.keyboard.press('End');
    await session.send('Input.insertText', { text: '还' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const committedApply = await page.evaluate(() => (
      (window as any).__hostMessages.find((message: any) => message.type === 'applyChanges')
    ));
    if (!committedApply) {
      const stalledState = await page.evaluate(() => ({
        lineText: document.querySelector<HTMLElement>('.cm-line')?.textContent ?? '',
        messages: (window as any).__hostMessages
      }));
      throw new Error(`IME commit was not sent to the host: ${JSON.stringify(stalledState)}`);
    }
    const committedText = committedApply.changes[0].insert as string;

    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'applied', version: 2 } }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 2 } }));
    }, committedText);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const state = await page.evaluate(() => ({
      lineText: document.querySelector<HTMLElement>('.cm-line')?.textContent ?? '',
      applyTexts: (window as any).__hostMessages
        .filter((message: any) => message.type === 'applyChanges')
        .map((message: any) => message.changes[0].insert)
    }));
    if (!state.lineText.includes('还') || state.lineText.includes('hai')) {
      throw new Error(`IME sync retained or restored composition text: ${JSON.stringify(state)}`);
    }

    const clickLineEnd = async (label: string) => {
      const activationPoint = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Line not found: ${lineLabel}`);
        const rect = line.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      }, label);
      await page.mouse.click(activationPoint.x, activationPoint.y);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const point = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Active line not found: ${lineLabel}`);
        const range = document.createRange();
        range.selectNodeContents(line);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
        const rect = rects.at(-1) ?? line.getBoundingClientRect();
        return { x: rect.right + 2, y: rect.top + rect.height / 2 };
      }, label);
      await page.mouse.click(point.x, point.y);
    };

    const assertPreeditUsesLineColor = async (label: string) => {
      await clickLineEnd(label);
      await session.send('Input.imeSetComposition', {
        text: 'pinyin',
        selectionStart: 6,
        selectionEnd: 6
      });
      const colors = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Line not found after composition: ${lineLabel}`);
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node && !node.textContent?.includes('pinyin')) node = walker.nextNode();
        if (!node?.parentElement) throw new Error(`IME preedit node not found: ${lineLabel}`);
        const labelWalker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let labelNode: Node | null = labelWalker.nextNode();
        while (labelNode && !labelNode.textContent?.includes(lineLabel)) labelNode = labelWalker.nextNode();
        if (!labelNode?.parentElement) throw new Error(`Reference text node not found: ${lineLabel}`);
        return {
          line: getComputedStyle(labelNode.parentElement).color,
          preedit: getComputedStyle(node.parentElement).color,
          text: line.textContent
        };
      }, label);
      if (colors.preedit !== colors.line) {
        throw new Error(`IME preedit inherited syntax color: ${JSON.stringify({ label, ...colors })}`);
      }
      await session.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0
      });
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('.cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
          data: '',
          bubbles: true
        }));
      });
    };

    await assertPreeditUsesLineColor('标题组合');
    await assertPreeditUsesLineColor('正文组合');

    const assertPreeditAfterMarker = async (label: string, markerText: string) => {
      const activationPoint = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Boundary line not found: ${lineLabel}`);
        const rect = line.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      }, label);
      await page.mouse.click(activationPoint.x, activationPoint.y);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const markerPoint = await page.evaluate(({ lineLabel, text }) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Closing marker line not found: ${lineLabel}`);
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const matches: Array<{ node: Node; offset: number }> = [];
        let node: Node | null = walker.nextNode();
        while (node) {
          const offset = node.textContent?.lastIndexOf(text) ?? -1;
          if (offset >= 0) matches.push({ node, offset });
          node = walker.nextNode();
        }
        const marker = matches.at(-1);
        if (!marker) throw new Error(`Closing marker not found: ${lineLabel} ${text}`);
        const range = document.createRange();
        range.setStart(marker.node, marker.offset);
        range.setEnd(marker.node, marker.offset + text.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.right + 1, y: rect.top + rect.height / 2 };
      }, { lineLabel: label, text: markerText });
      await page.mouse.click(markerPoint.x, markerPoint.y);
      await session.send('Input.imeSetComposition', {
        text: 'pinyin',
        selectionStart: 6,
        selectionEnd: 6
      });
      const state = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        if (!line) throw new Error(`Boundary line disappeared: ${lineLabel}`);
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let labelNode: Node | null = walker.nextNode();
        while (labelNode && !labelNode.textContent?.includes(lineLabel)) labelNode = walker.nextNode();
        const preeditWalker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let preeditNode: Node | null = preeditWalker.nextNode();
        while (preeditNode && !preeditNode.textContent?.includes('pinyin')) preeditNode = preeditWalker.nextNode();
        if (!labelNode?.parentElement || !preeditNode?.parentElement) {
          throw new Error(`Boundary preedit text not found: ${lineLabel}`);
        }
        return {
          text: line.textContent ?? '',
          expectedColor: getComputedStyle(labelNode.parentElement).color,
          actualColor: getComputedStyle(preeditNode.parentElement).color
        };
      }, label);
      if (!state.text.includes('pinyin后续') || state.actualColor !== state.expectedColor) {
        throw new Error(`IME preedit failed at a nested-marker boundary: ${JSON.stringify({ label, ...state })}`);
      }
      await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('.cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
          data: '',
          bubbles: true
        }));
      });
    };

    await assertPreeditAfterMarker('标题边界', '**');
    await assertPreeditAfterMarker('正文边界', '~~');

    for (const [index, label] of ['正文组合', '标题组合'].entries()) {
      const messageCountBefore = await page.evaluate(() => (window as any).__hostMessages.length);
      await clickLineEnd(label);
      const before = await page.evaluate((lineLabel) => (
        Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent?.includes(lineLabel))?.textContent ?? ''
      ), label);
      await session.send('Input.insertText', { text: '12' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterState = await page.evaluate((lineLabel) => {
        const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((candidate) => candidate.textContent?.includes(lineLabel));
        return {
          text: line?.textContent ?? '',
          hasStrike: Boolean(line?.querySelector('.meo-md-strike'))
        };
      }, label);
      const after = afterState.text;
      if (after === before || !after.endsWith('12') || !afterState.hasStrike) {
        const focus = await page.evaluate(() => ({
          active: document.activeElement?.className ?? '',
          selection: document.getSelection()?.anchorNode?.parentElement?.className ?? ''
        }));
        throw new Error(`Text insertion after nested markers was lost: ${JSON.stringify({ label, before, after, hasStrike: afterState.hasStrike, focus })}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const appliedText = await page.evaluate((fromIndex) => (
        (window as any).__hostMessages.slice(fromIndex)
          .find((message: any) => message.type === 'applyChanges')?.changes[0].insert ?? null
      ), messageCountBefore);
      if (typeof appliedText !== 'string') {
        throw new Error(`Nested-marker insertion was not sent to the host: ${label}`);
      }
      await page.evaluate(({ text, version }) => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'applied', version } }));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version } }));
      }, { text: appliedText, version: 3 + index });
    }

    const strikeActivation = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('删除线输入'))!;
      const rect = line.getBoundingClientRect();
      return { x: rect.left + 8, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(strikeActivation.x, strikeActivation.y);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const strikeEnd = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('删除线输入'))!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const matches: Array<{ node: Node; offset: number }> = [];
      let node: Node | null = walker.nextNode();
      while (node) {
        const offset = node.textContent?.lastIndexOf('~~') ?? -1;
        if (offset >= 0) matches.push({ node, offset });
        node = walker.nextNode();
      }
      const marker = matches.at(-1)!;
      const range = document.createRange();
      range.setStart(marker.node, marker.offset);
      range.setEnd(marker.node, marker.offset + 2);
      const rect = range.getBoundingClientRect();
      return { x: rect.right + 1, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(strikeEnd.x, strikeEnd.y);
    await session.send('Input.insertText', { text: '123' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const strikeAfterInsert = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('删除线输入'))!;
      return {
        text: line.textContent ?? '',
        strikeText: line.querySelector<HTMLElement>('.meo-md-strike')?.textContent ?? ''
      };
    });
    if (!strikeAfterInsert.text.includes('~~123') || !strikeAfterInsert.strikeText.includes('删除线')) {
      throw new Error(`Typing after a closing strike marker removed the strike: ${JSON.stringify(strikeAfterInsert)}`);
    }

    const outlineState = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('.outline-item'));
      const heading = items.find((item) => item.textContent?.includes('标题组合'));
      return {
        text: items.map((item) => item.textContent ?? '').join('\n'),
        headingText: heading?.textContent ?? '',
        hasStrike: Boolean(heading?.querySelector('del'))
      };
    });
    if (
      !outlineState.text.includes('标题组合') ||
      !outlineState.text.includes('12') ||
      outlineState.headingText.includes('~~') ||
      !outlineState.hasStrike
    ) {
      throw new Error(`Outline did not preserve nested heading styles after typing: ${JSON.stringify(outlineState)}`);
    }

    const tableInput = await page.$('tbody textarea');
    if (!tableInput) throw new Error('Table input not found');
    await tableInput.focus();
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const boundary = input.value.lastIndexOf('~~后续') + 2;
      input.setSelectionRange(boundary, boundary);
    });
    await session.send('Input.imeSetComposition', {
      text: 'pinyin',
      selectionStart: 6,
      selectionEnd: 6
    });
    const tablePreedit = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      return { value: input.value, color: getComputedStyle(input).color };
    });
    if (!tablePreedit.value.includes('~~pinyin后续')) {
      throw new Error(`Table rejected IME preedit after nested markers: ${JSON.stringify(tablePreedit)}`);
    }
    await session.send('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0
    });
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>('tbody textarea')?.dispatchEvent(new CompositionEvent('compositionend', {
        data: '',
        bubbles: true
      }));
    });
    await session.send('Input.insertText', { text: '12' });
    const tableInserted = await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')!.value);
    const tableStrikeText = await page.evaluate(() => (
      document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview .meo-md-strike')?.textContent ?? ''
    ));
    if (!tableInserted.includes('~~12后续') || !tableStrikeText.includes('删除线')) {
      throw new Error(`Table lost nested styles after marker-boundary input: ${JSON.stringify({ tableInserted, tableStrikeText })}`);
    }

    const tableImeState = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const rowsBefore = document.querySelectorAll('tbody tr').length;
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true
      });
      input.dispatchEvent(event);
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const trailingEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(trailingEnter);
      return {
        rowsBefore,
        rowsAfter: document.querySelectorAll('tbody tr').length,
        sameInputFocused: document.activeElement === input,
        prevented: event.defaultPrevented || trailingEnter.defaultPrevented
      };
    });
    if (
      tableImeState.rowsAfter !== tableImeState.rowsBefore ||
      !tableImeState.sameInputFocused ||
      tableImeState.prevented
    ) {
      throw new Error(`Table handled an IME candidate key as an editor command: ${JSON.stringify(tableImeState)}`);
    }
    console.log('IME composition checks passed');
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
