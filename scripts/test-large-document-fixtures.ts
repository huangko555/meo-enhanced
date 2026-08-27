import assert from 'node:assert/strict';
import {
  createLargeDocumentFixtures,
  describeLargeDocumentFixture
} from './large-document-fixtures';

const fixtures = createLargeDocumentFixtures();
assert.deepEqual(
  fixtures.map((fixture) => fixture.kind),
  ['ordinary', 'bytes-heavy', 'lines-heavy', 'rich-heavy', 'composite']
);

const descriptions = new Map(fixtures.map((fixture) => [
  fixture.kind,
  describeLargeDocumentFixture(fixture.text)
]));
const ordinary = descriptions.get('ordinary')!;
const bytesHeavy = descriptions.get('bytes-heavy')!;
const linesHeavy = descriptions.get('lines-heavy')!;
const richHeavy = descriptions.get('rich-heavy')!;
const composite = descriptions.get('composite')!;

assert.ok(bytesHeavy.bytes > linesHeavy.bytes * 2, 'bytes-heavy must isolate byte volume');
assert.ok(bytesHeavy.lines < linesHeavy.lines / 10, 'bytes-heavy must not also be line-heavy');
assert.equal(bytesHeavy.rich.total, 0, 'bytes-heavy must not also be rich-heavy');

assert.ok(linesHeavy.lines > bytesHeavy.lines * 20, 'lines-heavy must isolate line volume');
assert.equal(linesHeavy.rich.total, 0, 'lines-heavy must not also be rich-heavy');

assert.ok(richHeavy.rich.total >= 300, 'rich-heavy must contain a meaningful mixed-block population');
assert.ok(richHeavy.rich.tables > 0);
assert.ok(richHeavy.rich.mermaid > 0);
assert.ok(richHeavy.rich.images > 0);
assert.ok(richHeavy.rich.math > 0);
assert.ok(richHeavy.bytes < bytesHeavy.bytes, 'rich-heavy must not depend on the bytes-heavy dimension');
assert.ok(richHeavy.lines < linesHeavy.lines, 'rich-heavy must not depend on the lines-heavy dimension');

assert.ok(composite.bytes > ordinary.bytes * 4, 'composite must retain byte pressure');
assert.ok(composite.lines > ordinary.lines * 8, 'composite must retain line pressure');
assert.ok(composite.rich.total >= 120, 'composite must retain rich-block pressure');

for (const fixture of fixtures) {
  const description = descriptions.get(fixture.kind)!;
  assert.equal(description.bytes, new TextEncoder().encode(fixture.text).byteLength);
  assert.equal(description.lines, fixture.text.split('\n').length);
  assert.ok(fixture.text.includes(`fixture:${fixture.kind}:end`), `${fixture.kind} end marker is missing`);
}

console.log('Large document fixture dimension checks passed');
