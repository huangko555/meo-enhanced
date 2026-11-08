import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commandIdentity, digest, prepareWorkflow, type TaskResult, type WorkflowReport } from './test-workflow-execution';
import { createTestWorkflowPlan } from './test-workflow-policy';
import { artifactFingerprint, workflowFingerprint } from './test-workflow-snapshot';
import { findBrowserExecutable } from './browser-test-helpers';

export type EvidenceSource = {
  report: string; reportHash: string; candidate?: string; task: string;
  status: TaskResult['status']; logsVerified: boolean;
};
export type EvidenceItem = {
  id: string; command: { args: string[]; env?: Record<string, string> };
  occurrences: string[]; sources: EvidenceSource[];
  disposition: 'missing' | 'rerun' | 'review' | 'reuse';
  rationale?: string;
};
export type ReuseReview = {
  snapshot: string;
  items: Array<{
    ids: string[]; decision: 'reuse' | 'rerun'; sourceReportHash?: string;
    source?: { reportHash: string; task: string };
    productAndBuild?: string; testAndSharedFixtures?: string;
    argumentsAndScale?: string; dependenciesAndEnvironment?: string;
    failures?: Array<{ reportHash: string; task: string; causeAndResolution: string }>;
  }>;
};

export function verifiedTaskLogs(task: TaskResult): boolean {
  try {
    return !!task.stdout && !!task.stderr && !!task.stdoutHash && !!task.stderrHash
      && digest(fs.readFileSync(task.stdout)) === task.stdoutHash
      && digest(fs.readFileSync(task.stderr)) === task.stderrHash;
  } catch { return false; }
}

/** Full current coverage, with historical results offered for review, never inferred as unaffected. */
export function createEvidenceItems(
  commands: Array<{ id: string; command: EvidenceItem['command'] }>,
  reports: Array<{ file: string; hash: string; report: WorkflowReport }>
): EvidenceItem[] {
  const items = new Map<string, EvidenceItem>();
  for (const task of commands) {
    const key = commandIdentity(task.command);
    const item: EvidenceItem = items.get(key) ?? { id: digest(key), command: task.command, occurrences: [], sources: [], disposition: 'missing' };
    item.occurrences.push(task.id);
    items.set(key, item);
  }
  for (const { file, hash, report } of reports) {
    if (report.schemaVersion !== 1 || !Array.isArray(report.tasks)) throw new Error(`Invalid workflow report: ${file}`);
    for (const task of report.tasks) {
      if (!task.command) continue;
      const item = items.get(commandIdentity(task.command));
      if (!item) continue;
      item.sources.push({ report: file, reportHash: hash, candidate: report.candidate,
        task: task.id, status: task.status, logsVerified: task.exitCode === 0 && !task.error && verifiedTaskLogs(task) });
    }
  }
  for (const item of items.values()) {
    item.disposition = item.sources.some(source => source.status === 'failed') ? 'rerun'
      : item.sources.some(source => source.logsVerified && ['passed', 'reused'].includes(source.status)) ? 'review' : 'missing';
  }
  return [...items.values()];
}

export function applyEvidenceReview(items: EvidenceItem[], snapshot: string, review: ReuseReview): void {
  if (review.snapshot !== snapshot || !Array.isArray(review.items)) throw new Error('Evidence review belongs to different inputs or reports.');
  const seen = new Set<string>();
  for (const decision of review.items) {
    if (!Array.isArray(decision.ids) || !decision.ids.length || !['reuse', 'rerun'].includes(decision.decision)) throw new Error('Invalid evidence decision.');
    for (const id of decision.ids) {
      const item = items.find(item => item.id === id);
      if (!item || seen.has(id)) throw new Error('Unknown or duplicate evidence decision.');
      seen.add(id);
      const explanations = [decision.productAndBuild, decision.testAndSharedFixtures,
        decision.argumentsAndScale, decision.dependenciesAndEnvironment];
      if (decision.decision === 'reuse') {
        if (explanations.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`Incomplete applicability review: ${item.id}`);
        const source = item.sources.find(source => decision.source
          ? source.reportHash === decision.source.reportHash && source.task === decision.source.task
          : source.reportHash === decision.sourceReportHash && source.logsVerified && ['passed', 'reused'].includes(source.status));
        if (!source?.logsVerified || !['passed', 'reused'].includes(source.status)) throw new Error(`Reuse requires verified passing logs: ${item.id}`);
        for (const failure of item.sources.filter(source => source.status === 'failed')) {
          if (!decision.failures?.some(entry => entry.reportHash === failure.reportHash && entry.task === failure.task
            && typeof entry.causeAndResolution === 'string' && entry.causeAndResolution.trim())) {
            throw new Error(`Unresolved historical failure: ${failure.reportHash}#${failure.task}`);
          }
        }
      }
      item.disposition = decision.decision;
      item.rationale = explanations.filter(Boolean).join('\n');
    }
  }
}

export function changedAcceptancePaths(root: string, baseline: string): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set([...git(['diff', '--name-only', '-z', baseline, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('bun run acceptance:evidence -- --baseline=<commit> --output=<new.json> [--document=<file>] [--report=<report.json> ...] [--review=<review.json>] [--runtime=<browser-or-Code.exe> ...]');
    console.log('Lists complete release coverage without executing tests. Reuse is an explicit applicability review, not runner resume or release approval.');
    return;
  }
  const options = new Map<string, string[]>();
  for (const arg of args) {
    const match = /^--(baseline|output|document|report|review|runtime)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown or incomplete option: ${arg}`);
    const values = options.get(match[1]!) ?? []; values.push(match[2]!); options.set(match[1]!, values);
  }
  const one = (name: string, required = false) => {
    const values = options.get(name) ?? [];
    if (values.length > 1 || required && values.length !== 1) throw new Error(`Expected one --${name}= value`);
    return values[0];
  };
  const root = process.cwd(), baseline = execFileSync('git', ['rev-parse', '--verify', `${one('baseline', true)!}^{commit}`], { encoding: 'utf8' }).trim();
  const output = path.resolve(one('output', true)!);
  if (fs.existsSync(output)) throw new Error('Preserve existing evidence; choose a new output file.');
  const document = one('document');
  const plan = createTestWorkflowPlan({ tier: 'release', confirmLongRun: false, dryRun: true,
    ...(document ? { documentPath: path.resolve(document) } : {}) });
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const captureBrowser = process.env.MEO_TEST_CAPTURE_BROWSER?.trim();
  const stages = prepareWorkflow(plan, scripts, undefined, captureBrowser ? path.resolve(captureBrowser) : undefined);
  const reports = (options.get('report') ?? []).map(file => {
    const absolute = path.resolve(file), bytes = fs.readFileSync(absolute);
    return { file: absolute, hash: digest(bytes), report: JSON.parse(bytes.toString()) as WorkflowReport };
  });
  const items = createEvidenceItems(stages.flatMap(stage => stage.groups.flat()), reports);
  // The original report and both streams are part of the review identity, including files outside Git.
  const evidenceFiles = reports.flatMap(source => [source.file,
    ...source.report.tasks.flatMap(task => [task.stdout, task.stderr].filter((file): file is string => !!file && fs.existsSync(file)))]);
  const runtimes = [...new Set([findBrowserExecutable(), ...(captureBrowser ? [path.resolve(captureBrowser)] : []),
    ...(options.get('runtime') ?? []).map(file => path.resolve(file))])];
  const input = workflowFingerprint(root, runtimes,
    undefined, [...evidenceFiles, ...(document ? [path.resolve(document)] : [])]);
  const snapshot = digest(JSON.stringify({ input, artifacts: artifactFingerprint(root), items, baseline,
    stages: stages.map(stage => ({ title: stage.title, requiresPassed: stage.requiresPassed, groups: stage.groups })) }));
  const reviewFile = one('review');
  if (reviewFile) applyEvidenceReview(items, snapshot, JSON.parse(fs.readFileSync(reviewFile, 'utf8')));
  const counts = Object.fromEntries(['missing', 'rerun', 'review', 'reuse'].map(value => [value, items.filter(item => item.disposition === value).length]));
  const reviewTemplate: ReuseReview = { snapshot, items: [{ ids: items.map(item => item.id), decision: 'rerun' }] };
  const result = { schemaVersion: 1, purpose: 'Release coverage planning; not a passing full runner or release approval',
    candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseline,
    changedPaths: changedAcceptancePaths(root, baseline), snapshot, runtimes, document: document ?? null,
    includesDocumentSupplements: !!document, nativeCoverage: 'Separate installed/native receipts are required',
    counts, items, reviewTemplate, independentCoverageReviewRequired: true };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, snapshot, counts, includesDocumentSupplements: !!document }));
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
