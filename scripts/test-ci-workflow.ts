import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type WorkflowStep = { run?: unknown; uses?: unknown };
type Workflow = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

const repoRoot = resolve(import.meta.dir, '..');
const workflow = Bun.YAML.parse(
  readFileSync(resolve(repoRoot, '.github/workflows/architecture-gate.yml'), 'utf8')
) as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const steps = workflow.jobs?.verify?.steps;
if (!Array.isArray(steps)) {
  throw new Error('Architecture gate must define the verify job steps');
}

const runCommands = steps
  .map((step) => step.run)
  .filter((command): command is string => typeof command === 'string');
const requiredCommands = [
  'bun install --frozen-lockfile',
  'bun run typecheck',
  'bun run architecture:check',
  'bun run test:unit',
  'bun run build',
  'bun run package:check'
];
for (const command of requiredCommands) {
  if (runCommands.filter((candidate) => candidate === command).length !== 1) {
    throw new Error(`Architecture gate must run exactly one ${command}`);
  }
}
if (runCommands.indexOf('bun run package:check') <= runCommands.indexOf('bun run build')) {
  throw new Error('Architecture gate must validate VSIX contents after building runtime artifacts');
}

const consolidatedUnitContracts = [
  'scripts/test-document-session.ts',
  'scripts/test-document-session-application.ts',
  'scripts/test-document-session-protocol.ts',
  'scripts/test-document-session-actions.ts',
  'scripts/test-document-session-production-cutover.ts',
  'scripts/test-protocol-ready-init.ts',
  'scripts/test-protocol-stale-responses.ts'
];
const testUnit = packageJson.scripts?.['test:unit'] ?? '';
for (const contract of consolidatedUnitContracts) {
  if (!testUnit.includes(`bun ${contract}`)) {
    throw new Error(`test:unit no longer contains ${contract}`);
  }
  if (runCommands.some((command) => command.includes(contract))) {
    throw new Error(`Architecture gate duplicates test:unit contract ${contract}`);
  }
}

console.log('CI architecture gate contract passed');
