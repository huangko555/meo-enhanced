import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-list-editing-transaction-'));

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
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
    const page = await browser.newPage();
    await page.setContent('<!doctype html><main><div id="first"></div><div id="second"></div><div id="third"></div></main>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).ListEditingHarness;
      const firstChanges: string[] = [];
      const first = harness.createEditor({
        parent: document.getElementById('first')!,
        text: '7. alpha\n8. beta',
        initialMode: 'live',
        onApplyChanges(text: string) {
          firstChanges.push(text);
        }
      });
      const secondChanges: string[] = [];
      const second = harness.createEditor({
        parent: document.getElementById('second')!,
        text: '4. other\n5. editor',
        initialMode: 'source',
        onApplyChanges(text: string) {
          secondChanges.push(text);
        }
      });
      const compositionChanges: string[] = [];
      const third = harness.createEditor({
        parent: document.getElementById('third')!,
        text: '3. ime\n4. tail',
        initialMode: 'live',
        onApplyChanges(text: string) {
          compositionChanges.push(text);
        }
      });

      const inputAnnotation = harness.userEvent.of('input.paste');
      const firstLineEnd = first.view.state.doc.line(1).to;
      first.view.dispatch({
        changes: { from: firstLineEnd, insert: '\n99. pasted' },
        selection: { anchor: firstLineEnd + '\n99. pasted'.length },
        annotations: inputAnnotation
      });
      const afterPaste = first.getText();
      const firstChangeCountAfterPaste = firstChanges.length;
      const afterPasteHistory = first.getHistoryDepth();
      const afterPasteSelection = first.view.state.selection.main.head;
      const undoApplied = await first.undo();
      const afterUndo = first.getText();
      const afterUndoHistory = first.getHistoryDepth();
      const redoApplied = await first.redo();
      const afterRedo = first.getText();
      const afterRedoHistory = first.getHistoryDepth();

      const secondLineEnd = second.view.state.doc.line(2).to;
      second.view.dispatch({
        changes: { from: secondLineEnd, insert: '\n6. already normalized' },
        annotations: inputAnnotation
      });
      const zeroFollowUpText = second.getText();
      const zeroFollowUpPublishCount = secondChanges.length;
      await second.undo();
      const beforeOneFollowUpPublishCount = secondChanges.length;
      second.view.dispatch({
        changes: { from: second.view.state.doc.length, insert: '\n99. normalize once' },
        annotations: inputAnnotation
      });
      const oneFollowUpText = second.getText();
      const oneFollowUpPublishCount = secondChanges.length - beforeOneFollowUpPublishCount;
      await second.undo();

      second.setText('12. external\n48. stays explicit', true);
      const afterExternal = second.getText();
      const externalUndoApplied = await second.undo();

      const tableSource = '1. a\n99. b\n\n| H |\n| --- |\n| - |';
      second.setText(tableSource, true);
      const tableProvenance = harness.getTableTransactionProvenance(second.view.state);
      const previousTableRow = second.view.state.doc.line(6);
      second.view.dispatch({
        changes: { from: previousTableRow.to, insert: '\n| new |' },
        effects: tableProvenance.effect({
          type: 'insertedRow',
          at: previousTableRow.to,
          assoc: -1,
          offset: 1
        }),
        annotations: [
          harness.userEvent.of('input.table.insert-row'),
          harness.isolateHistory.of('full')
        ]
      });
      const tableAfterInsert = second.getText();
      const insertedRowSnapshot = tableProvenance.snapshot().insertedRows[0] ?? null;
      const insertedRowText = insertedRowSnapshot
        ? second.view.state.doc.sliceString(insertedRowSnapshot.from, insertedRowSnapshot.to)
        : null;
      const tableHistoryAfterInsert = second.getHistoryDepth();
      const tableUndoApplied = await second.undo();
      const tableAfterUndo = second.getText();
      const insertedRowsAfterUndo = tableProvenance.snapshot().insertedRows;
      const tableRedoApplied = await second.redo();
      const tableAfterRedo = second.getText();
      const insertedRowsAfterRedo = tableProvenance.snapshot().insertedRows;

      second.setText('1. a\n99. b\n\n| H |\n| --- |\n| first |\n| second |', true);
      const firstTableRow = second.view.state.doc.line(6);
      second.view.dispatch({
        changes: { from: firstTableRow.from, to: second.view.state.doc.line(7).from },
        effects: tableProvenance.effect({
          type: 'deletedRows',
          at: firstTableRow.from,
          assoc: 1,
          baselineRanges: [[3, 3]],
          deletionAtEnd: false
        }),
        annotations: [
          harness.userEvent.of('delete.table.rows'),
          harness.isolateHistory.of('full')
        ]
      });
      const tableAfterDelete = second.getText();
      const deletedRowSnapshot = tableProvenance.snapshot().deletedRows[0] ?? null;
      const deletedRowAnchorText = deletedRowSnapshot
        ? second.view.state.doc.lineAt(deletedRowSnapshot.at).text
        : null;

      second.setText('1. a\n99. b\n\n| H |\n| --- |\n| tracked |', true);
      const trackedTableRow = second.view.state.doc.line(6);
      second.view.dispatch({
        effects: tableProvenance.effect({ type: 'insertedRow', at: trackedTableRow.from, assoc: -1 }),
        annotations: harness.addToHistory.of(false)
      });
      const trackedRow = tableProvenance.snapshot().insertedRows[0]!;
      const tableFrom = second.view.state.doc.line(4).from;
      second.view.dispatch({
        changes: {
          from: tableFrom,
          to: trackedTableRow.to,
          insert: '| H |\n| --- |\n| remapped |'
        },
        effects: tableProvenance.effect({
          type: 'remapInsertedRows',
          tableFrom,
          rows: [{ id: trackedRow.id, oldOffset: 14, newOffset: 14 }]
        }),
        annotations: [
          harness.userEvent.of('input.table.remap'),
          harness.isolateHistory.of('full')
        ]
      });
      const tableAfterRemap = second.getText();
      const remappedRowSnapshot = tableProvenance.snapshot().insertedRows[0] ?? null;
      const remappedRowText = remappedRowSnapshot
        ? second.view.state.doc.sliceString(remappedRowSnapshot.from, remappedRowSnapshot.to)
        : null;
      second.setText('12. external\n48. stays explicit', true);

      const nested = '7. top\n  4. nested explicit\n  5. nested next\n8. tail';
      first.setText(nested, true);
      const nestedLineEnd = first.view.state.doc.line(2).to;
      first.view.dispatch({
        changes: { from: nestedLineEnd, insert: '\n  99. nested pasted' },
        annotations: inputAnnotation
      });
      const nestedAfterPaste = first.getText();
      const nestedUndoApplied = await first.undo();
      const nestedAfterUndo = first.getText();

      third.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const imeLineEnd = third.view.state.doc.line(1).to;
      third.view.dispatch({
        changes: { from: imeLineEnd, insert: '\n99. composed' },
        annotations: harness.userEvent.of('input.type.compose')
      });
      const imePreeditPublishCount = compositionChanges.length;
      third.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      const imeText = third.getText();
      const imePublishTexts = [...compositionChanges];

      const secondBefore = second.getText();
      const secondChangeCountBeforeDestroyWait = secondChanges.length;
      first.destroy();
      third.destroy();
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const secondAfter = second.getText();
      const secondChangeCountAfterDestroyWait = secondChanges.length;
      second.destroy();

      return {
        afterPaste,
        afterPasteHistory,
        afterPasteSelection,
        firstChangeCountAfterPaste,
        undoApplied,
        afterUndo,
        afterUndoHistory,
        redoApplied,
        afterRedo,
        afterRedoHistory,
        zeroFollowUpText,
        zeroFollowUpPublishCount,
        oneFollowUpText,
        oneFollowUpPublishCount,
        afterExternal,
        externalUndoApplied,
        tableAfterInsert,
        insertedRowSnapshot,
        insertedRowText,
        tableHistoryAfterInsert,
        tableUndoApplied,
        tableAfterUndo,
        insertedRowsAfterUndo,
        tableRedoApplied,
        tableAfterRedo,
        insertedRowsAfterRedo,
        tableAfterDelete,
        deletedRowSnapshot,
        deletedRowAnchorText,
        tableAfterRemap,
        remappedRowSnapshot,
        remappedRowText,
        nestedAfterPaste,
        nestedUndoApplied,
        nestedAfterUndo,
        imePreeditPublishCount,
        imeText,
        imePublishTexts,
        secondBefore,
        secondAfter,
        secondChangeCountBeforeDestroyWait,
        secondChangeCountAfterDestroyWait
      };
    });

    assert.equal(result.afterPaste, '7. alpha\n8. pasted\n9. beta');
    assert.deepEqual(result.afterPasteHistory, { undo: 1, redo: 0 });
    assert.equal(result.afterPasteSelection, '7. alpha\n8. pasted'.length);
    assert.equal(result.firstChangeCountAfterPaste, 1, 'one user action must publish one Document change');
    assert.equal(result.undoApplied, true);
    assert.equal(result.afterUndo, '7. alpha\n8. beta');
    assert.deepEqual(result.afterUndoHistory, { undo: 0, redo: 1 });
    assert.equal(result.redoApplied, true);
    assert.equal(result.afterRedo, '7. alpha\n8. pasted\n9. beta');
    assert.deepEqual(result.afterRedoHistory, { undo: 1, redo: 0 });
    assert.equal(result.zeroFollowUpText, '4. other\n5. editor\n6. already normalized');
    assert.equal(result.zeroFollowUpPublishCount, 1);
    assert.equal(result.oneFollowUpText, '4. other\n5. editor\n6. normalize once');
    assert.equal(result.oneFollowUpPublishCount, 1);
    assert.equal(result.afterExternal, '12. external\n48. stays explicit');
    assert.equal(result.externalUndoApplied, false, 'external reload on a fresh Editor must not enter history');
    assert.equal(result.tableAfterInsert, '1. a\n2. b\n\n| H |\n| --- |\n| - |\n| new |');
    assert.deepEqual(result.insertedRowSnapshot, { id: 'row-1', from: 31, to: 38 });
    assert.equal(result.insertedRowText, '| new |');
    assert.deepEqual(result.tableHistoryAfterInsert, { undo: 1, redo: 0 });
    assert.equal(result.tableUndoApplied, true);
    assert.equal(result.tableAfterUndo, '1. a\n99. b\n\n| H |\n| --- |\n| - |');
    assert.deepEqual(result.insertedRowsAfterUndo, []);
    assert.equal(result.tableRedoApplied, true);
    assert.equal(result.tableAfterRedo, result.tableAfterInsert);
    assert.deepEqual(result.insertedRowsAfterRedo, [result.insertedRowSnapshot]);
    assert.equal(result.tableAfterDelete, '1. a\n2. b\n\n| H |\n| --- |\n| second |');
    assert.deepEqual(
      result.deletedRowSnapshot && {
        at: result.deletedRowSnapshot.at,
        baselineRanges: result.deletedRowSnapshot.baselineRanges,
        deletionAtEnd: result.deletedRowSnapshot.deletionAtEnd
      },
      { at: 25, baselineRanges: [[3, 3]], deletionAtEnd: false }
    );
    assert.equal(result.deletedRowAnchorText, '| second |');
    assert.equal(result.tableAfterRemap, '1. a\n2. b\n\n| H |\n| --- |\n| remapped |');
    assert.deepEqual(
      result.remappedRowSnapshot && {
        from: result.remappedRowSnapshot.from,
        to: result.remappedRowSnapshot.to
      },
      { from: 25, to: 37 }
    );
    assert.equal(result.remappedRowText, '| remapped |');
    assert.equal(
      result.nestedAfterPaste,
      '7. top\n  4. nested explicit\n  5. nested pasted\n  6. nested next\n8. tail'
    );
    assert.equal(result.nestedUndoApplied, true);
    assert.equal(result.nestedAfterUndo, '7. top\n  4. nested explicit\n  5. nested next\n8. tail');
    assert.equal(result.imePreeditPublishCount, 0, 'IME preedit must not publish a partial Document');
    assert.equal(result.imeText, '3. ime\n4. composed\n5. tail');
    assert.deepEqual(result.imePublishTexts, [result.imeText]);
    assert.equal(result.secondBefore, '12. external\n48. stays explicit');
    assert.equal(result.secondAfter, result.secondBefore, 'destroyed Editor work must not cross into another Editor');
    assert.equal(result.secondChangeCountAfterDestroyWait, result.secondChangeCountBeforeDestroyWait);

    const nestedDocument = [
      '```mermaid',
      'graph TD',
      'A --> B',
      '```',
      '',
      '1. a',
      '99. b',
      'tail'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          return { svg: `<svg viewBox="0 0 120 40"><text>${source.length}</text></svg>` };
        }
      };
      const host = document.createElement('div');
      host.id = 'nested-rich-list';
      document.body.append(host);
      (window as any).__nestedRichListEditor = (window as any).ListEditingHarness.createEditor({
        parent: host,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, nestedDocument);
    await page.waitForSelector('#nested-rich-list .meo-mermaid-mode-btn');
    await page.click('#nested-rich-list .meo-mermaid-mode-btn');
    await page.waitForSelector('#nested-rich-list .meo-mermaid-editing-block.is-split');
    await page.click('#nested-rich-list .meo-mermaid-source-editor .cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await waitForFrames(page, 8);

    const nestedBefore = await page.evaluate(() => {
      const editor = (window as any).__nestedRichListEditor;
      const block = document.querySelector<HTMLElement>('#nested-rich-list .meo-mermaid-editing-block')!;
      const innerContent = block.querySelector<HTMLElement>('.meo-mermaid-source-editor .cm-content')!;
      const outerSelectionLine = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
      const frames: Array<Record<string, unknown>> = [];
      (window as any).__nestedRichListFrames = frames;
      let removedBlocks = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node === block || (node instanceof Element && node.contains(block))) removedBlocks += 1;
          }
        }
      });
      observer.observe(editor.view.contentDOM, { childList: true, subtree: true });
      const recordFrame = () => {
        const currentBlock = document.querySelector<HTMLElement>(
          '#nested-rich-list .meo-mermaid-editing-block'
        );
        const visibleOuterSource = Array.from(editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
          .filter((line) => !line.closest('.meo-mermaid-editing-block'))
          .filter((line) => {
            const text = line.textContent ?? '';
            const rect = line.getBoundingClientRect();
            return (text.includes('graph TD') || text.includes('A --> B'))
              && getComputedStyle(line).display !== 'none'
              && rect.height > 0;
          })
          .map((line) => line.textContent ?? '');
        frames.push({
          text: editor.getText(),
          sameBlock: currentBlock === block,
          visibleOuterSource,
          innerFocused: innerContent.contains(document.activeElement),
          outerSelectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
          scrollTop: editor.view.scrollDOM.scrollTop,
          blockTop: currentBlock?.getBoundingClientRect().top ?? null
        });
        if (frames.length < 8) requestAnimationFrame(recordFrame);
        else {
          observer.disconnect();
          (window as any).__nestedRichListRemovedBlocks = removedBlocks;
        }
      };
      requestAnimationFrame(recordFrame);
      return {
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        outerSelectionLine,
        scrollTop: editor.view.scrollDOM.scrollTop,
        blockTop: block.getBoundingClientRect().top
      };
    });
    await page.keyboard.type('X');
    await waitForFrames(page, 10);
    const nestedAfter = await page.evaluate(() => {
      const editor = (window as any).__nestedRichListEditor;
      return {
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        frames: (window as any).__nestedRichListFrames ?? null,
        removedBlocks: (window as any).__nestedRichListRemovedBlocks ?? 0,
        focused: document.querySelector<HTMLElement>(
          '#nested-rich-list .meo-mermaid-source-editor .cm-content'
        )?.contains(document.activeElement) ?? false
      };
    });
    const nestedExpected = nestedDocument.replace('99. b', '2. b').replace('A --> B', 'A --> BX');
    assert.equal(nestedAfter.text, nestedExpected);
    assert.deepEqual(nestedAfter.history, { undo: 1, redo: 0 });
    assert.equal(
      nestedAfter.removedBlocks,
      0,
      `nested normalization must not unload the rich block: ${JSON.stringify(nestedAfter.frames)}`
    );
    assert.equal(nestedAfter.focused, true, 'nested normalization must keep focus in the rich editor');
    assert.equal(nestedAfter.frames.length, 8);
    for (const frame of nestedAfter.frames) {
      assert.equal(frame.sameBlock, true, 'the rendered block must remain mounted on every frame');
      assert.deepEqual(frame.visibleOuterSource, [], 'outer Markdown source must remain hidden on every frame');
      assert.equal(frame.innerFocused, true, 'nested focus must not move during normalization');
      assert.equal(frame.outerSelectionLine, nestedBefore.outerSelectionLine);
      assert.ok(Math.abs(Number(frame.scrollTop) - nestedBefore.scrollTop) <= 1);
      assert.ok(Math.abs(Number(frame.blockTop) - nestedBefore.blockTop) <= 1);
      assert.ok(frame.text === nestedDocument || frame.text === nestedExpected, 'a frame observed a partial edit');
    }
    assert.equal(await page.evaluate(() => (window as any).__nestedRichListEditor.undo()), true);
    await waitForFrames(page, 4);
    assert.equal(
      await page.evaluate(() => (window as any).__nestedRichListEditor.getText()),
      nestedDocument,
      'one undo must revert both nested input and numbering'
    );
    assert.equal(await page.evaluate(() => (window as any).__nestedRichListEditor.redo()), true);
    await waitForFrames(page, 4);
    assert.equal(await page.evaluate(() => (window as any).__nestedRichListEditor.getText()), nestedExpected);
    await page.evaluate(() => (window as any).__nestedRichListEditor.destroy());

    const crossDocument = [
      '```mermaid',
      'graph TD',
      'A --> B',
      '```',
      '',
      '1. a',
      '99. b',
      '',
      '| H |',
      '| --- |',
      '| - |'
    ].join('\n');
    const crossExpected = crossDocument
      .replace('A --> B', 'A --> BX')
      .replace('99. b', '2. b')
      .concat('\n| new |');
    const cross = await page.evaluate((text) => {
      const harness = (window as any).ListEditingHarness;
      const host = document.createElement('div');
      document.body.append(host);
      const changes: string[] = [];
      const editor = harness.createEditor({
        parent: host,
        text,
        initialMode: 'live',
        onApplyChanges(next: string) { changes.push(next); }
      });
      const provenance = harness.getTableTransactionProvenance(editor.view.state);
      const mermaidInsert = text.indexOf('A --> B') + 'A --> B'.length;
      const tableEnd = editor.view.state.doc.length;
      const transactionChanges = [
        { from: mermaidInsert, insert: 'X' },
        { from: tableEnd, insert: '\n| new |' }
      ];
      const ownChanges = editor.view.state.changes(transactionChanges);
      const insertedRowFrom = ownChanges.mapPos(tableEnd, -1) + 1;
      editor.view.dispatch({
        changes: transactionChanges,
        effects: provenance.effect({ type: 'insertedRow', at: insertedRowFrom, assoc: -1 }),
        annotations: harness.userEvent.of('input.type')
      });
      const result = {
        text: editor.getText(),
        callbackCount: changes.length,
        history: editor.getHistoryDepth(),
        snapshot: provenance.snapshot()
      };
      editor.destroy();
      host.remove();
      return result;
    }, crossDocument);
    assert.equal(cross.text, crossExpected);
    assert.equal(cross.callbackCount, 1, 'Mermaid+Table normalization must publish one Document callback');
    assert.deepEqual(cross.history, { undo: 1, redo: 0 });
    assert.deepEqual(cross.snapshot.insertedRows, [{ id: 'row-1', from: 65, to: 72 }]);

    console.log('list editing production transaction checks passed');
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
