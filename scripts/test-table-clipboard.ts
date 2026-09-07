import assert from 'node:assert/strict';
import {
  parseMeoTableClipboard,
  parseTsvTableClipboard,
  serializeMeoTableClipboard
} from '../webview/src/editor/tableClipboard';

const source = [['**bold**', 'a\\|b'], ['line<br>two', '']];
assert.deepEqual(parseMeoTableClipboard(serializeMeoTableClipboard(source)), {
  cells: source,
  source: 'meo'
});
assert.equal(parseMeoTableClipboard('{"version":2,"cells":[["x"]]}'), null);
assert.equal(parseMeoTableClipboard('{"version":1,"cells":"x"}'), null);
assert.equal(parseTsvTableClipboard('ordinary paragraph\nwith a line break'), null,
  'ordinary multiline text must remain a native single-cell paste');
assert.deepEqual(parseTsvTableClipboard('A\tB\r\n1\t2'), {
  cells: [['A', 'B'], ['1', '2']],
  source: 'external'
});
assert.deepEqual(parseTsvTableClipboard('"line 1\nline 2"\t"a""b"'), {
  cells: [['line 1\nline 2', 'a"b']],
  source: 'external'
});

console.log('table clipboard contracts passed');
