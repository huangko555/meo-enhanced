import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { commandIdentity, digest } from './test-workflow-execution';
import { parseFeatureCoverage, type FeatureCoverageEntry } from './feature-coverage';

type JsonRecord = Record<string, unknown>;
type ReportStatus = 'running' | 'passed' | 'failed' | 'invalidated';
type TaskStatus = 'running' | 'passed' | 'failed' | 'reused';

export type FeatureCoverageObservation = {
  reportPath: string;
  candidate?: string;
  fingerprint: { present: boolean; value?: string };
  reportStatus: ReportStatus;
  task: { id: string };
  recordedStatus: TaskStatus;
  exitCode?: number;
  command: { args: string[]; env?: Record<string, string> };
  commandIdentity: string;
  evidence?: string;
  logs: {
    integrity: 'logs-match' | 'missing-or-changed' | 'requires-review';
    stdout?: string;
    stderr?: string;
    stdoutHash?: string;
    stderrHash?: string;
  };
  applicability: 'historical-command-execution-only' | 'requires-review';
};

export type FeatureCoverageDirectoryEntry = FeatureCoverageEntry & {
  observationStatus: 'not-observed' | 'manual-boundary' | 'historical-observations';
  observations: Array<{
    test: string;
    status: 'not-observed' | 'historical-observations';
    observations: FeatureCoverageObservation[];
  }>;
};

export type FeatureCoverageReport = {
  schemaVersion: 1;
  scope: 'historical-command-execution-summary-only';
  notes: string[];
  source: { coverageMarkdown: string; currentHead: string };
  reports: Array<{ path: string; candidate?: string; fingerprintPresent: boolean; status: ReportStatus }>;
  entries: FeatureCoverageDirectoryEntry[];
};

type ValidatedTask = {
  id: string;
  command: { args: string[]; env?: Record<string, string> };
  status: TaskStatus;
  exitCode?: number;
  evidence?: string;
  stdout?: string;
  stderr?: string;
  stdoutHash?: string;
  stderrHash?: string;
};

type ValidatedWorkflowReport = {
  candidate?: string;
  fingerprint: string;
  status: ReportStatus;
  tasks: ValidatedTask[];
};

const reportStatuses = new Set<ReportStatus>(['running', 'passed', 'failed', 'invalidated']);
const taskStatuses = new Set<TaskStatus>(['running', 'passed', 'failed', 'reused']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string when present`);
  return value;
}

function validateCommand(value: unknown, label: string): ValidatedTask['command'] {
  if (!isRecord(value)) throw new Error(`${label}.command must be an object`);
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some(arg => typeof arg !== 'string' || arg.length === 0)) {
    throw new Error(`${label}.command.args must be a non-empty string array`);
  }
  if (value.env === undefined) return { args: [...value.args] as string[] };
  if (!isRecord(value.env) || Object.values(value.env).some(env => typeof env !== 'string')) {
    throw new Error(`${label}.command.env must be a string map when present`);
  }
  return { args: [...value.args] as string[], env: { ...value.env } as Record<string, string> };
}

export function validateWorkflowReport(value: unknown, source: string): ValidatedWorkflowReport {
  if (!isRecord(value)) throw new Error(`Invalid workflow report ${source}: expected a JSON object`);
  if (value.schemaVersion !== 1) throw new Error(`Unsupported workflow report schema in ${source}: expected schemaVersion 1`);
  requiredString(value.title, `${source}.title`);
  if (typeof value.fingerprint !== 'string') throw new Error(`${source}.fingerprint must be a string`);
  requiredString(value.planHash, `${source}.planHash`);
  requiredString(value.startedAt, `${source}.startedAt`);
  if (typeof value.pid !== 'number' || !Number.isFinite(value.pid)) throw new Error(`${source}.pid must be a finite number`);
  if (typeof value.status !== 'string' || !reportStatuses.has(value.status as ReportStatus)) {
    throw new Error(`${source}.status must be running, passed, failed, or invalidated`);
  }
  if (!Array.isArray(value.tasks)) throw new Error(`${source}.tasks must be an array`);
  if (!Array.isArray(value.stages)) throw new Error(`${source}.stages must be an array`);

  const tasks = value.tasks.map((candidate, index): ValidatedTask => {
    const label = `${source}.tasks[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object`);
    const id = requiredString(candidate.id, `${label}.id`);
    if (typeof candidate.status !== 'string' || !taskStatuses.has(candidate.status as TaskStatus)) {
      throw new Error(`${label}.status must be running, passed, failed, or reused`);
    }
    if (candidate.exitCode !== undefined && (typeof candidate.exitCode !== 'number' || !Number.isFinite(candidate.exitCode))) {
      throw new Error(`${label}.exitCode must be a finite number when present`);
    }
    return {
      id,
      command: validateCommand(candidate.command, label),
      status: candidate.status as TaskStatus,
      ...(candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode }),
      ...(optionalString(candidate.evidence, `${label}.evidence`) === undefined ? {} : { evidence: candidate.evidence as string }),
      ...(optionalString(candidate.stdout, `${label}.stdout`) === undefined ? {} : { stdout: candidate.stdout as string }),
      ...(optionalString(candidate.stderr, `${label}.stderr`) === undefined ? {} : { stderr: candidate.stderr as string }),
      ...(optionalString(candidate.stdoutHash, `${label}.stdoutHash`) === undefined ? {} : { stdoutHash: candidate.stdoutHash as string }),
      ...(optionalString(candidate.stderrHash, `${label}.stderrHash`) === undefined ? {} : { stderrHash: candidate.stderrHash as string })
    };
  });
  return {
    status: value.status as ReportStatus,
    fingerprint: value.fingerprint as string,
    ...(optionalString(value.candidate, `${source}.candidate`) === undefined ? {} : { candidate: value.candidate as string }),
    tasks
  };
}

function repoPath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== '..'
    ? relativePath.split(sep).join('/')
    : path;
}

function verifyLogs(task: ValidatedTask): FeatureCoverageObservation['logs'] {
  const details = {
    ...(task.stdout === undefined ? {} : { stdout: task.stdout }),
    ...(task.stderr === undefined ? {} : { stderr: task.stderr }),
    ...(task.stdoutHash === undefined ? {} : { stdoutHash: task.stdoutHash }),
    ...(task.stderrHash === undefined ? {} : { stderrHash: task.stderrHash })
  };
  if (task.status === 'reused') return { integrity: 'requires-review', ...details };
  if (task.status !== 'passed' && task.status !== 'failed') return { integrity: 'requires-review', ...details };
  try {
    if (!task.stdout || !task.stderr || !task.stdoutHash || !task.stderrHash
      || digest(readFileSync(task.stdout)) !== task.stdoutHash
      || digest(readFileSync(task.stderr)) !== task.stderrHash) {
      return { integrity: 'missing-or-changed', ...details };
    }
    return { integrity: 'logs-match', ...details };
  } catch {
    return { integrity: 'missing-or-changed', ...details };
  }
}

function observation(reportPath: string, report: ValidatedWorkflowReport, task: ValidatedTask): FeatureCoverageObservation {
  return {
    reportPath,
    ...(report.candidate === undefined ? {} : { candidate: report.candidate }),
    fingerprint: { present: report.fingerprint.length > 0, ...(report.fingerprint.length > 0 ? { value: report.fingerprint } : {}) },
    reportStatus: report.status,
    task: { id: task.id },
    recordedStatus: task.status,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    command: task.command,
    commandIdentity: commandIdentity(task.command),
    ...(task.evidence === undefined ? {} : { evidence: task.evidence }),
    logs: verifyLogs(task),
    applicability: task.status === 'reused' ? 'requires-review' : 'historical-command-execution-only'
  };
}

function currentHead(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Cannot read current git HEAD for the capability directory');
  }
}

export function createFeatureCoverageReport(options: { root?: string; reports?: string[] } = {}): FeatureCoverageReport {
  const root = resolve(options.root ?? process.cwd());
  const coveragePath = resolve(root, 'docs', 'testing-feature-coverage.md');
  const entries = parseFeatureCoverage(readFileSync(coveragePath, 'utf8'));
  const loaded = (options.reports ?? []).map(input => {
    const path = resolve(root, input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read workflow report ${input}: ${(error as Error).message}`);
    }
    return { path: repoPath(root, path), report: validateWorkflowReport(parsed, input) };
  });
  // Shared contracts can belong to several capabilities. Read/hash each linked
  // task's logs once in this summary, without retaining a cross-run cache.
  const linkedTests = new Set(entries.flatMap(entry => entry.tests));
  const observationsByTest = new Map<string, FeatureCoverageObservation[]>();
  for (const { path, report } of loaded) for (const task of report.tasks) {
    const test = task.command.args[0]!;
    if (!linkedTests.has(test)) continue;
    const records = observationsByTest.get(test) ?? [];
    records.push(observation(path, report, task));
    observationsByTest.set(test, records);
  }

  return {
    schemaVersion: 1,
    scope: 'historical-command-execution-summary-only',
    notes: [
      'This directory only records historical command executions from explicitly supplied reports.',
      'It does not determine current capability pass status or complete acceptance.',
      'A report fingerprint, including an empty quick or targeted fingerprint, does not prove a clean tree or matching environment.',
      'Applicability, native/manual boundaries, failures, running work, invalidated reports, and reused results require independent review.'
    ],
    source: { coverageMarkdown: repoPath(root, coveragePath), currentHead: currentHead(root) },
    reports: loaded.map(({ path, report }) => ({
      path,
      ...(report.candidate === undefined ? {} : { candidate: report.candidate }),
      fingerprintPresent: report.fingerprint.length > 0,
      status: report.status
    })),
    entries: entries.map(entry => {
      if (entry.tests.length === 0) return { ...entry, observationStatus: 'manual-boundary', observations: [] };
      const observations = entry.tests.map(test => {
        const records = observationsByTest.get(test) ?? [];
        return { test, status: records.length ? 'historical-observations' : 'not-observed', observations: records } as const;
      });
      return {
        ...entry,
        observationStatus: observations.some(item => item.status === 'historical-observations') ? 'historical-observations' : 'not-observed',
        observations
      };
    })
  };
}

function usage(): string {
  return 'Usage: bun scripts/feature-coverage-report.ts [--report <report.json>]...';
}

export function parseFeatureCoverageReportArguments(argv: string[]): { reports: string[]; help: boolean } {
  const reports: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === '--help' || value === '-h') return { reports, help: true };
    if (value !== '--report') throw new Error(`Unknown argument: ${value}`);
    const report = argv[++index];
    if (!report || report.startsWith('--')) throw new Error('--report requires a report.json path');
    reports.push(report);
  }
  return { reports, help: false };
}

if (import.meta.main) {
  try {
    const arguments_ = parseFeatureCoverageReportArguments(process.argv.slice(2));
    if (arguments_.help) console.log(usage());
    else console.log(JSON.stringify(createFeatureCoverageReport({ reports: arguments_.reports }), null, 2));
  } catch (error) {
    console.error(`feature-coverage-report: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
