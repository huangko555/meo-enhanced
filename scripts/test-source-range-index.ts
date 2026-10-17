import assert from 'node:assert/strict';
import { indexSourceRanges } from '../webview/src/helpers/sourceRangeIndex';

let seed = 42;
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
for (let run = 0; run < 100; run += 1) {
  const ranges = Array.from({ length: run }, () => {
    const from = next() % 1000;
    return { from, to: from + next() % 300 };
  });
  const contains = indexSourceRanges(ranges);
  const overlaps = indexSourceRanges(ranges, 'overlaps');
  for (let query = 0; query < 100; query += 1) {
    const from = next() % 1300;
    const to = from + next() % 100;
    assert.equal(contains(from, to), ranges.some(range => range.from <= from && range.to >= to),
      'indexed containment must retain overlapping, nested and empty range semantics');
    assert.equal(overlaps(from, to), ranges.some(range => from < range.to && to > range.from));
  }
}
const boundaries = indexSourceRanges([{ from: 10, to: 20 }, { from: 12, to: 15 }]);
assert.equal(boundaries(10, 20), true);
assert.equal(boundaries(12, 19), true, 'an inner range must not hide its enclosing range');
assert.equal(boundaries(20, 20), true);
assert.equal(boundaries(20, 21), false);
assert.equal(boundaries(9, 11), false);
console.log('Source range index: 10,000 differential containment checks passed');
