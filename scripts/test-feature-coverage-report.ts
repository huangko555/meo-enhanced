import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createFeatureCoverageReport,
  parseFeatureCoverageReportArguments,
  validateWorkflowReport
} from './feature-coverage-report';

const root = resolve(import.meta.dir, '..');
mkdirSync(join(root, '.local'), { recursive: true });
const temporaryRoot = mkdtempSync(join(root, '.local', 'feature-coverage-report-'));
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function write(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
}

function report(tasks: unknown[], status: 'running' | 'passed' | 'failed' | 'invalidated' = 'passed', fingerprint = ''): object {
  return {
    schemaVersion: 1,
    pid: 1234,
    title: 'fixture report',
    fingerprint,
    candidate: 'fixture-candidate',
    planHash: 'fixture-plan',
    status,
    startedAt: '2026-11-07T00:00:00.000Z',
    tasks,
    stages: []
  };
}

try {
  const directoryOnly = createFeatureCoverageReport({ root });
  assert.equal(directoryOnly.schemaVersion, 1);
  assert.equal(directoryOnly.scope, 'historical-command-execution-summary-only');
  assert.equal(directoryOnly.reports.length, 0, 'no --report input only emits the current capability directory');
  assert.ok(directoryOnly.notes.some(note => /does not determine current capability pass status/i.test(note)));
  assert.ok(directoryOnly.source.currentHead.length >= 7, 'the current HEAD is an annotation, not a validity decision');
  assert.ok(directoryOnly.entries.some(entry => entry.observationStatus === 'manual-boundary' && entry.tests.length === 0),
    'manual-only catalog entries retain an explicit manual boundary');
  const documented = directoryOnly.entries.find(entry => entry.tests.length > 0 && entry.expected !== entry.evidence);
  assert.ok(documented, 'the directory retains both expected-result and evidence columns');

  const entry = directoryOnly.entries.find(item => item.tests.includes('scripts/test-mode-transition-matrix.ts'));
  assert.ok(entry, 'fixture must target a linked runnable test');
  const [target] = entry.tests;
  assert.ok(target);
  const stdout = join(temporaryRoot, 'stdout.log');
  const stderr = join(temporaryRoot, 'stderr.log');
  const stableStdout = join(temporaryRoot, 'stable-stdout.log');
  const stableStderr = join(temporaryRoot, 'stable-stderr.log');
  write(stdout, 'historical stdout\n');
  write(stderr, 'historical stderr\n');
  write(stableStdout, 'stable stdout\n');
  write(stableStderr, 'stable stderr\n');
  const command = { args: [target, '--partial', '--exact=fixture'], env: { MEO_FIXTURE: 'kept', Z_LAST: 'also-kept' } };
  const primaryPath = join(temporaryRoot, 'primary.json');
  const primary = report([
    { id: 'passed-extra-args', command, status: 'passed', exitCode: 0, stdout, stderr, stdoutHash: hash('historical stdout\n'), stderrHash: hash('historical stderr\n'), evidence: 'fixture-evidence' },
    { id: 'failed', command, status: 'failed', exitCode: 7, stdout: stableStdout, stderr: stableStderr, stdoutHash: hash('stable stdout\n'), stderrHash: hash('stable stderr\n') },
    { id: 'reused', command, status: 'reused', exitCode: 0, stdout, stderr, stdoutHash: hash('historical stdout\n'), stderrHash: hash('historical stderr\n') }
  ], 'failed');
  write(primaryPath, JSON.stringify(primary, null, 2));
  const originalPrimary = readFileSync(primaryPath, 'utf8');

  const invalidatedPath = join(temporaryRoot, 'invalidated.json');
  write(invalidatedPath, JSON.stringify(report([
    { id: 'invalidated', command, status: 'passed', exitCode: 0, stdout, stderr, stdoutHash: hash('historical stdout\n'), stderrHash: hash('historical stderr\n') }
  ], 'invalidated', 'non-empty-fingerprint')));
  const runningPath = join(temporaryRoot, 'running.json');
  write(runningPath, JSON.stringify(report([{ id: 'still-running', command, status: 'running' }], 'running')));
  const changedPath = join(temporaryRoot, 'changed.json');
  write(changedPath, JSON.stringify(report([
    { id: 'changed-log', command, status: 'passed', exitCode: 0, stdout, stderr, stdoutHash: hash('historical stdout\n'), stderrHash: hash('historical stderr\n') }
  ])));
  write(stdout, 'changed after report\n');

  const summary = createFeatureCoverageReport({ root, reports: [primaryPath, invalidatedPath, runningPath, changedPath] });
  assert.equal(readFileSync(primaryPath, 'utf8'), originalPrimary, 'input reports are read-only and never rewritten');
  assert.ok(summary.reports.some(item => item.status === 'failed' && !item.fingerprintPresent), 'empty fingerprints stay visible rather than proving a clean tree');
  assert.ok(summary.reports.some(item => item.status === 'invalidated'), 'invalidated sources stay visible');
  assert.ok(summary.reports.some(item => item.status === 'running'), 'incomplete sources stay visible');
  assert.ok(!('currentCapabilityPassed' in summary), 'historical observations never create a current capability verdict');
  const linkedTests = summary.entries.find(item => item.label === entry.label && item.section === entry.section)?.observations ?? [];
  const observations = linkedTests.flatMap(item => item.observations);
  assert.equal(observations.length, 6, 'every supplied historical result remains separate rather than collapsing to one pass');
  assert.ok(linkedTests.some(item => item.status === 'not-observed'), 'each linked test without a supplied command is explicitly not-observed');
  const passed = observations.find(item => item.task.id === 'passed-extra-args');
  assert.deepEqual(passed?.command, command, 'the complete args and environment are preserved exactly');
  assert.equal(passed?.logs.integrity, 'missing-or-changed', 'changed evidence cannot make a historical command look fully verified');
  assert.ok(passed?.command.args.includes('--partial'), 'an argument-specific partial run is not promoted to the full script');
  assert.equal(observations.find(item => item.task.id === 'failed')?.recordedStatus, 'failed', 'failures are not ignored');
  assert.equal(observations.find(item => item.task.id === 'failed')?.logs.integrity, 'logs-match',
    'ordinary failed commands retain independently checkable log evidence without becoming a green result');
  assert.equal(observations.find(item => item.task.id === 'invalidated')?.reportStatus, 'invalidated');
  assert.equal(observations.find(item => item.task.id === 'still-running')?.reportStatus, 'running');
  assert.equal(observations.find(item => item.task.id === 'reused')?.applicability, 'requires-review', 'reused results do not invent a recursive reuse verdict');
  assert.equal(observations.find(item => item.task.id === 'reused')?.logs.integrity, 'requires-review');
  assert.ok(summary.entries.some(item => item.tests.length > 0 && item.observationStatus === 'not-observed'),
    'entries with no seen linked tests remain not-observed');

  assert.throws(() => validateWorkflowReport({ schemaVersion: 2 }, 'unknown.json'), /Unsupported workflow report schema/);
  assert.deepEqual(validateWorkflowReport(report([], 'running'), 'empty.json').tasks, [],
    'the runner writes an empty task list before starting its first command');
  assert.throws(() => validateWorkflowReport({ ...report([]), tasks: undefined }, 'missing-tasks.json'), /tasks must be an array/);
  assert.throws(() => validateWorkflowReport(report([{ id: 'bad', status: 'passed', command: { args: ['scripts/test-any.ts'], env: { BAD: 1 } } }]), 'malicious.json'),
    /command\.env must be a string map/);
  assert.throws(() => validateWorkflowReport(report([{ id: 'bad', status: 'other', command }]), 'invalid-task.json'), /tasks\[0\]\.status/);
  assert.throws(() => parseFeatureCoverageReportArguments(['--report']), /requires a report\.json path/);

  const help = Bun.spawnSync({ cmd: ['bun', 'scripts/feature-coverage-report.ts', '--help', '--report', join(tmpdir(), 'not-read.json')], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(help.exitCode, 0, 'help exits without reading a report');
  assert.match(new TextDecoder().decode(help.stdout), /Usage:/);
  const cli = Bun.spawnSync({ cmd: ['bun', 'scripts/feature-coverage-report.ts'], cwd: root, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(cli.exitCode, 0, 'the public CLI emits a directory without inputs');
  const cliDirectory = JSON.parse(new TextDecoder().decode(cli.stdout)) as { entries: unknown[]; reports: unknown[] };
  assert.ok(cliDirectory.entries.length > 0 && cliDirectory.reports.length === 0);
} finally {
  assert.ok(temporaryRoot.startsWith(resolve(root, '.local')), 'cleanup is limited to this test-owned .local directory');
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('PASS feature coverage report: read-only historical observations, evidence integrity, and manual boundaries.');
