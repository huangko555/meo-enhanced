import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { createCodeMirrorTableTransactionProvenanceAdapter } from '../webview/src/adapters/codeMirrorTableTransactionProvenanceAdapter';
import { createTableTransactionProvenance } from '../webview/src/application/tableTransactionProvenance';
import {
  getGitDiffLineCounts,
  getGitDiffSummary,
  getGitDiffOriginalBlocks,
  gitDiffGutterBaselineExtensions,
  setGitBaselineEffect
} from '../webview/src/helpers/gitDiffGutter';

function stateWithBaseline(current: string, baseline: string): EditorState {
  const provenance = createCodeMirrorTableTransactionProvenanceAdapter(
    createTableTransactionProvenance()
  );
  const initial = EditorState.create({
    doc: current,
    extensions: [provenance.extension, ...gitDiffGutterBaselineExtensions()]
  });
  return initial.update({
    effects: setGitBaselineEffect.of({
      available: true,
      tracked: true,
      baseText: baseline,
      mode: 'current-edit'
    })
  }).state;
}

const modified = stateWithBaseline('first\nnew value\nlast', 'first\nold value\nlast');
assert.deepEqual(
  getGitDiffSummary(modified),
  { status: 'ready', added: 1, deleted: 1 },
  'a computed diff must report ready together with its counts'
);
assert.deepEqual(
  getGitDiffLineCounts(modified),
  { added: 1, deleted: 1 },
  'a modified source line must count as one addition and one deletion'
);
assert.deepEqual(getGitDiffOriginalBlocks(modified), [{
  at: modified.doc.line(2).from,
  side: -1,
  lines: [{ number: 2, text: 'old value' }]
}]);

const added = stateWithBaseline('first\ninserted\nlast', 'first\nlast');
assert.deepEqual(getGitDiffLineCounts(added), { added: 1, deleted: 0 });
assert.deepEqual(getGitDiffOriginalBlocks(added), []);

const deleted = stateWithBaseline('first\nlast', 'first\nremoved one\nremoved two\nlast');
assert.deepEqual(getGitDiffLineCounts(deleted), { added: 0, deleted: 2 });
assert.deepEqual(getGitDiffOriginalBlocks(deleted)[0]?.lines, [
  { number: 2, text: 'removed one' },
  { number: 3, text: 'removed two' }
]);

const oversizedCurrent = `${'a'.repeat(1024 * 1024)}\nnew`;
const oversizedBaseline = `${'a'.repeat(1024 * 1024)}\nold`;
assert.deepEqual(
  getGitDiffSummary(stateWithBaseline(oversizedCurrent, oversizedBaseline)),
  { status: 'unavailable', reason: 'too-large', added: 0, deleted: 0 },
  'an oversized diff must not be reported as no changes'
);

console.log('changes review checks passed');
