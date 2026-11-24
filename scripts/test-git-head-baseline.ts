import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitBaselineMetadataForFile, getGitBaselinePayloadForFile, gitBaselineMaxBytes, hydrateGitBaselineText } from '../src/git/baseline';
import { compareDocuments } from '../src/shared/gitDiffCore';

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'meo-git-head-baseline-')));
const git = (...args: string[]): string => execFileSync('git', args, {
  cwd: repo,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'
  }
}).toString().trim();
const write = (name: string, text: string): string => {
  const filePath = path.join(repo, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  return filePath;
};
const removeObject = (oid: string): void => {
  fs.rmSync(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
};
const read = (filePath: string) => getGitBaselinePayloadForFile(filePath, repo);

try {
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const committed = write('committed.md', '# Committed\n\nbody\n');
  const bomText = '# Title\n\nbody\n';
  const withBom = write('bom.md', `\ufeff${bomText}`);
  const unreadable = write('unreadable.md', '# Unreadable\n');
  const large = write('large.md', 'x'.repeat(gitBaselineMaxBytes + 1));
  git('add', '--', '.');
  git('update-ref', 'HEAD', git('commit-tree', '-m', 'fixture', git('write-tree')));

  const committedBaseline = await read(committed);
  assert.equal(committedBaseline.reason, undefined);
  assert.equal(committedBaseline.baseText, '# Committed\n\nbody\n');

  const bomBaseline = await read(withBom);
  assert.equal(bomBaseline.baseText, bomText, 'the document text has no byte order mark, so its HEAD text must not either');
  assert.deepEqual(compareDocuments(bomBaseline.baseText!, bomText).lineChanges, [],
    'an unchanged UTF-8 BOM file must have no changes against HEAD');
  assert.deepEqual(compareDocuments(bomBaseline.baseText!, '# Edited\n\nbody\n').lineChanges.map(change => [change.line, change.kind]),
    [[1, 'modified']], 'a real edit of line 1 must remain visible');

  const untracked = write('untracked.md', '# Untracked\n');
  const untrackedBaseline = await read(untracked);
  assert.deepEqual(
    [untrackedBaseline.available, untrackedBaseline.tracked, untrackedBaseline.baseText, untrackedBaseline.reason],
    [true, false, null, undefined]
  );

  const newText = '# New\n\nbody\n';
  for (const [label, name] of [
    ['staged new file', 'staged.md'],
    ['staged new file in a new folder', 'new-folder/staged.md'],
    ['staged new file with pathspec characters', '[c]ommitted.md'],
    ['staged new file with a non-ASCII name', '新建.md']
  ] as const) {
    const filePath = write(name, newText);
    git('--literal-pathspecs', 'add', '--', name);
    const baseline = await read(filePath);
    assert.equal(baseline.reason, undefined, `${label}: absence from HEAD is not a Git failure`);
    assert.equal(baseline.tracked, true, label);
    assert.equal(baseline.baseText, '', `${label}: HEAD has no content for this path`);
    assert.deepEqual(compareDocuments(baseline.baseText!, newText).lineChanges, [
      { line: 1, kind: 'added' }, { line: 2, kind: 'added' }, { line: 3, kind: 'added' }
    ], `${label}: every line must be added against HEAD`);
  }

  const capturedBaseline = await getGitBaselineMetadataForFile(committed, repo);
  git('mv', 'committed.md', 'renamed.md');
  const renamedBaseline = await read(path.join(repo, 'renamed.md'));
  assert.equal(renamedBaseline.reason, undefined, 'staged rename: the new path is absent from HEAD');
  assert.equal(renamedBaseline.baseText, '');

  const largeBaseline = await read(large);
  assert.equal(largeBaseline.reason, 'too-large');
  assert.equal(largeBaseline.baseText, null);

  const capturedCommit = git('rev-parse', 'HEAD');
  git('update-ref', 'HEAD', git('commit-tree', '-m', 'fixture without the old path', git('write-tree')));
  try {
    const hydrated = await hydrateGitBaselineText(capturedBaseline);
    assert.equal(hydrated.headOid, capturedCommit);
    assert.equal(hydrated.baseText, '# Committed\n\nbody\n', 'hydration reads the captured commit after HEAD moves');
  } finally {
    git('update-ref', 'HEAD', capturedCommit);
  }

  removeObject(git('rev-parse', 'HEAD:unreadable.md'));
  const unreadableBaseline = await read(unreadable);
  assert.equal(unreadableBaseline.reason, 'error', 'a HEAD file whose content cannot be read must stay an error');
  assert.equal(unreadableBaseline.baseText, null);

  removeObject(git('rev-parse', 'HEAD^{tree}'));
  const unreadableTreeBaseline = await read(path.join(repo, 'staged.md'));
  assert.equal(unreadableTreeBaseline.reason, 'error', 'an unreadable HEAD tree must not look like an absent file');
  assert.equal(unreadableTreeBaseline.baseText, null);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log('Git HEAD baseline checks passed');
