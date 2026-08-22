import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-list-editing-transaction-'));

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
