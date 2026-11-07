import assert from 'node:assert/strict';
import { inspectFeatureCoverage, parseFeatureCoverage, type FeatureCoverageEntry } from './feature-coverage';

const expectParseError = (markdown: string): void => {
  assert.throws(() => parseFeatureCoverage(markdown), 'malformed feature coverage must be rejected');
};

const errorsFor = (
  entries: readonly FeatureCoverageEntry[],
  manifestIds: readonly string[],
  availableFiles: ReadonlySet<string>,
  releaseTests: ReadonlySet<string>,
  separate: Readonly<Record<string, { kind: string; command: string; reason: string }>> = {},
): string[] => inspectFeatureCoverage(entries, manifestIds, availableFiles, releaseTests, separate);

const markdown = [
  '# 功能验收覆盖',
  '',
  '正文中的 `meoEnhanced.ignored` 不是能力登记。',
  '',
  '## 编辑与阅读',
  '| 能力 | 必须检查的结果 | 门禁证据 |',
  '| --- | --- | --- |',
  '| 中文能力 | 结果包含 `meoEnhanced.expected`，且保留 escaped \\| pipe | [TS](../scripts/test-feature.ts) [证据](../docs/evidence.md) `meoEnhanced.evidence` |',
  '| 多种脚本 | 结果 `meoEnhanced.scripts` | [TSX](../scripts/test-view.tsx) [JS](../scripts/test-node.js) [MJS](../scripts/test-module.mjs) [CJS](../scripts/test-child.cjs) [PS1](../scripts/test-native.ps1) [帮助](../scripts/helper.ts) [手册](../docs/manual.md) |',
  '| 手工验收 | 仅人工检查 `meoEnhanced.manual` | 人工 fixture，不把 Markdown 当成测试 |',
  '',
  '```markdown',
  '## 代码示例（不是能力）',
  '| 假能力 | `meoEnhanced.fake` | [假测试](../scripts/test-fake.ts) |',
  '| --- | --- | --- |',
  '```',
  '',
  '## 设置',
  '| 能力 | 预期与证据 |',
  '| --- | --- |',
  '| 中文能力 | 结果 `meoEnhanced.settings`；[设置脚本](../scripts/test-settings.ts) |',
].join('\r\n');

const entries = parseFeatureCoverage(markdown);
assert.equal(entries.length, 4, 'only real tables outside fenced code are capabilities');
assert.deepEqual(entries.map(entry => entry.section), [
  '编辑与阅读', '编辑与阅读', '编辑与阅读', '设置',
]);
assert.equal(entries[0]?.label, '中文能力');
assert.ok(entries[0]?.expected.includes('meoEnhanced.expected'));
assert.ok(entries[0]?.expected.includes('escaped \\| pipe'), 'escaped pipes remain part of a cell');
assert.ok(entries[0]?.evidence.includes('TS'));
assert.ok(entries[0]?.evidence.includes('证据'));
assert.deepEqual(entries[0]?.publicIds, [
  'meoEnhanced.expected', 'meoEnhanced.evidence',
]);
assert.deepEqual(entries[0]?.tests, ['scripts/test-feature.ts']);
assert.ok(entries[0]?.links.includes('scripts/test-feature.ts'));
assert.ok(entries[0]?.links.includes('docs/evidence.md'));
assert.equal(entries[0]?.line, 8, 'line numbers are one-based and survive CRLF input');
assert.deepEqual(entries[1]?.tests, [
  'scripts/test-view.tsx', 'scripts/test-node.js', 'scripts/test-module.mjs',
  'scripts/test-child.cjs', 'scripts/test-native.ps1',
]);
assert.ok(entries[1]?.links.includes('scripts/helper.ts'));
assert.ok(entries[1]?.links.includes('docs/manual.md'));
assert.deepEqual(entries[2]?.tests, [], 'manual-only capabilities may have no test links');
assert.deepEqual(entries[3]?.expected, entries[3]?.evidence, 'two-column rows use the second column for both fields');
assert.ok(entries[3]?.publicIds.includes('meoEnhanced.settings'), 'IDs in the expected column are collected');
assert.ok(!entries.flatMap(entry => entry.publicIds).includes('meoEnhanced.fake'),
  'fenced examples do not contribute capability IDs');

const allLocalFiles = new Set([
  'scripts/test-feature.ts', 'scripts/test-view.tsx', 'scripts/test-node.js',
  'scripts/test-module.mjs', 'scripts/test-child.cjs', 'scripts/test-native.ps1',
  'scripts/helper.ts', 'docs/evidence.md', 'docs/manual.md', 'scripts/test-settings.ts',
]);
const allReleaseTests = new Set(entries.flatMap(entry => entry.tests));
const allManifestIds = entries.flatMap(entry => entry.publicIds);
assert.deepEqual(
  errorsFor(entries, allManifestIds, allLocalFiles, allReleaseTests),
  [],
  'a complete manifest, links and release test set is accepted',
);

const missingManifestId = [...allManifestIds, 'meoEnhanced.notRegistered'];
assert.ok(errorsFor(entries, missingManifestId, allLocalFiles, allReleaseTests).length > 0,
  'manifest IDs missing from the document are rejected');
assert.ok(errorsFor(entries, allManifestIds.filter(id => id !== 'meoEnhanced.settings'), allLocalFiles, allReleaseTests).length > 0,
  'IDs present in the document but absent from the manifest are rejected');

const brokenLinkEntries = entries.map((entry, index) => index === 0
  ? { ...entry, links: [...entry.links, '../docs/missing-evidence.md'] }
  : entry);
assert.ok(errorsFor(brokenLinkEntries, allManifestIds, allLocalFiles, allReleaseTests).length > 0,
  'local links must point to existing files');

const targetedTestEntries = entries.map((entry, index) => index === 0
  ? { ...entry, tests: ['scripts/test-targeted.ts'] }
  : entry);
assert.ok(errorsFor(targetedTestEntries, allManifestIds, allLocalFiles, new Set()).length > 0,
  'targeted or otherwise non-release tests cannot satisfy the release gate');
assert.ok(errorsFor(entries, allManifestIds, allLocalFiles, new Set(['scripts/test-feature.ts'])).length > 0,
  'every runnable test extension is subject to the release gate');

const nativeOnly = entries.map((entry, index) => index === 1
  ? { ...entry, tests: ['scripts/test-native.ps1'] }
  : entry).filter((_, index) => index !== 0 && index !== 2 && index !== 3 && index !== 4);
const nativeFiles = new Set([...allLocalFiles, 'scripts/test-native.ps1']);
assert.deepEqual(
  errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
    'scripts/test-native.ps1': {
      kind: 'native', command: 'pwsh -File scripts/test-native.ps1', reason: 'Requires an installed VS Code host.',
    },
  }),
  [],
  'a documented native exception may cover a non-release test',
);
assert.ok(errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
  'scripts/test-native.ps1': { kind: 'native', command: '', reason: 'Requires an installed VS Code host.' },
}).length > 0, 'native exceptions require a command containing the test path');
assert.ok(errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
  'scripts/test-native.ps1': { kind: 'native', command: 'pwsh -File scripts/test-native.ps1', reason: '  ' },
}).length > 0, 'native exceptions require a non-empty reason');
assert.ok(errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
  'scripts/test-native.ps1': { kind: 'targeted', command: 'pwsh -File scripts/test-native.ps1', reason: 'A targeted run is enough.' },
}).length > 0, 'targeted is not a release exception kind');
for (const command of [
  'pwsh ./scripts/test-native.ps1 -CodePath <Code.exe>',
  'VS Code --extensionTestsPath="scripts/test-native.ps1"',
  'scripts/test-native.ps1 is loaded by another registered native driver'
]) {
  assert.deepEqual(errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
    'scripts/test-native.ps1': { kind: 'native', command, reason: 'Requires an installed host.' }
  }), [], 'current native registration formats reference the exact script path');
}
for (const command of [
  'pwsh scripts/test-native.ps1.disabled', 'pwsh scripts/test-native.ps1-old',
  'pwsh archive/scripts/test-native.ps1'
]) {
  assert.ok(errorsFor(nativeOnly, nativeOnly.flatMap(entry => entry.publicIds), nativeFiles, new Set(), {
    'scripts/test-native.ps1': { kind: 'native', command, reason: 'Requires an installed host.' }
  }).length > 0, 'a filename substring is not an exact native test reference');
}

expectParseError([
  '## Bad', '| 能力 | 预期 |', '| --- | --- |', '| 只有一列 |',
].join('\n'));
expectParseError([
  '## Bad', '| 能力 | 预期 | 证据 |', '| --- | --- | --- |', '| 太多 | 单元格 | 额外 | 第四列 |',
].join('\n'));
expectParseError([
  '## Bad', '| 能力 | 预期 | 证据 |', '| --- | --- | --- |', '|  | 有内容 | 证据 |',
].join('\n'));
expectParseError([
  '## Bad', '| 能力 | 预期 | 证据 |', '| --- | --- | --- |', '| 重复 | a | b |', '| 重复 | c | d |',
].join('\n'));
assert.equal(parseFeatureCoverage([
  '## One', '| 能力 | 预期 |', '| --- | --- |', '| 相同 | a |',
  '## Two', '| 能力 | 预期 |', '| --- | --- |', '| 相同 | b |',
].join('\n')).length, 2, 'same labels are allowed in different sections');
const sharedIdEntries = parseFeatureCoverage([
  '## One', '| 能力 | 预期 |', '| --- | --- |', '| 第一项 | `meoEnhanced.shared` |',
  '## Two', '| 能力 | 预期 |', '| --- | --- |', '| 第二项 | `meoEnhanced.shared` |',
].join('\n'));
assert.deepEqual(errorsFor(sharedIdEntries, ['meoEnhanced.shared'], new Set(), new Set()), [],
  'a public ID may be referenced by multiple related capabilities');

console.log('PASS feature coverage contracts: Markdown parsing, IDs, links, runnable tests, release gates and native exceptions.');
