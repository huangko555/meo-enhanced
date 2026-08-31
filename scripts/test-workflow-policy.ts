export type TestWorkflowTier =
  | 'quick'
  | 'targeted'
  | 'release'
  | 'endurance'
  | 'large-document';

export type TargetedTestArea =
  | 'history'
  | 'table'
  | 'rendered'
  | 'appearance'
  | 'viewport'
  | 'uat';

export type TestWorkflowCommand = {
  args: string[];
  env?: Record<string, string>;
};

export type TestWorkflowStage = {
  title: string;
  commands: TestWorkflowCommand[];
  maxConcurrency?: number;
};

export type TestWorkflowRequest = {
  tier: TestWorkflowTier;
  area?: TargetedTestArea;
  documentPath?: string;
  confirmLongRun: boolean;
  dryRun: boolean;
};

export type TestWorkflowPlan = {
  tier: TestWorkflowTier;
  area?: TargetedTestArea;
  title: string;
  expectedDuration: string;
  longRunning: boolean;
  stages: TestWorkflowStage[];
};

const targetedAreas = new Set<TargetedTestArea>([
  'history',
  'table',
  'rendered',
  'appearance',
  'viewport',
  'uat'
]);

const script = (path: string, env?: Record<string, string>): TestWorkflowCommand => ({
  args: [path],
  ...(env ? { env } : {})
});

const packageScript = (name: string): TestWorkflowCommand => ({
  args: ['run', name]
});

const serialStage = (
  title: string,
  commands: TestWorkflowCommand[]
): TestWorkflowStage => ({ title, commands, maxConcurrency: 1 });

export function flattenTestWorkflowCommands(
  plan: TestWorkflowPlan
): TestWorkflowCommand[] {
  return plan.stages.flatMap((stage) => stage.commands);
}

function targetedCommands(
  area: TargetedTestArea,
  documentPath?: string
): TestWorkflowCommand[] {
  switch (area) {
    case 'history':
      return [
        script('scripts/test-editor-history-runtime.ts'),
        script('scripts/test-editor-history-production-cutover.ts'),
        script('scripts/test-history-rendered-block-interaction.ts'),
        script('scripts/test-editor-history-runtime-browser.ts'),
        script('scripts/test-rendered-content-history-roundtrip.ts'),
        script('scripts/test-history-matrix.ts')
      ];
    case 'table':
      return [
        script('scripts/test-table-cell-editing.ts'),
        script('scripts/test-table-column-width-policy.ts'),
        script('scripts/test-table-column-width-lifecycle.ts'),
        script('scripts/test-table-diff-refresh.ts'),
        script('scripts/test-table-input-visual-stability.ts'),
        script('scripts/test-table-visible-history-viewport.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'rendered':
      return [
        script('scripts/test-rendered-block-mode-shell.ts'),
        script('scripts/test-history-rendered-block-interaction.ts'),
        script('scripts/test-mermaid-diagram-presentation-runtime.ts'),
        script('scripts/test-mermaid-editing.ts'),
        script('scripts/test-live-embedded-input-viewport.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'appearance':
      return [
        script('scripts/test-appearance-webview-adapter.ts'),
        script('scripts/test-appearance-settings.ts'),
        script('scripts/test-vscode-theme-transition.ts'),
        script('scripts/test-highlight.ts')
      ];
    case 'viewport':
      return [
        script('scripts/test-viewport-controller.ts'),
        script('scripts/test-uat-viewport-stability.ts'),
        script('scripts/test-live-embedded-input-viewport.ts'),
        script('scripts/test-table-position-after-embedded-edit.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'uat':
      if (!documentPath) throw new Error('Targeted UAT requires a document path');
      return [
        {
          args: ['scripts/test-uat-full-document-endurance.ts', documentPath],
          env: {
            MEO_UAT_ENDURANCE_LIMIT: '8',
            MEO_UAT_STRICT_FINDING: '*'
          }
        },
        {
          args: ['scripts/test-production-live-scroll-integrity.ts', `--document=${documentPath}`]
        }
      ];
  }
}

export function parseTestWorkflowRequest(argv: string[]): TestWorkflowRequest {
  const confirmLongRun = argv.includes('--confirm-long-run');
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((value) => !value.startsWith('--'));
  const tier = positional[0] as TestWorkflowTier | undefined;
  if (
    !tier
    || !['quick', 'targeted', 'release', 'endurance', 'large-document'].includes(tier)
  ) {
    throw new Error(
      'Expected one tier: quick, targeted, release, endurance, or large-document'
    );
  }

  if (tier === 'targeted') {
    const area = positional[1] as TargetedTestArea | undefined;
    if (!area || !targetedAreas.has(area)) {
      throw new Error(
        `Unknown targeted area "${area ?? ''}". Expected history, table, rendered, appearance, viewport, or uat`
      );
    }
    const documentPath = positional[2];
    if (area === 'uat' && !documentPath) {
      throw new Error('Targeted UAT requires a document path');
    }
    return { tier, area, documentPath, confirmLongRun, dryRun };
  }

  const documentPath = positional[1];
  if (tier === 'endurance' && !documentPath) {
    throw new Error('Endurance UAT requires a document path');
  }
  if (tier === 'large-document' && !documentPath) {
    throw new Error('Large-document stress test requires a document path');
  }
  return { tier, documentPath, confirmLongRun, dryRun };
}

export function createTestWorkflowPlan(request: TestWorkflowRequest): TestWorkflowPlan {
  switch (request.tier) {
    case 'quick':
      return {
        tier: 'quick',
        title: 'Quick regression gate',
        expectedDuration: 'about 30-60 seconds',
        longRunning: false,
        stages: [serialStage('Quick regression contracts', [
          packageScript('typecheck'),
          script('scripts/test-test-workflow.ts'),
          script('scripts/test-editor-history-runtime.ts'),
          script('scripts/test-table-cell-editing.ts'),
          script('scripts/test-rendered-block-mode-shell.ts'),
          script('scripts/test-live-input-derived-work.ts'),
          script('scripts/test-viewport-controller.ts'),
          script('scripts/test-uat-viewport-stability.ts'),
          script('scripts/test-virtual-block-scroll-stability.ts')
        ])]
      };
    case 'targeted': {
      const area = request.area;
      if (!area) throw new Error('Targeted workflow requires an area');
      return {
        tier: 'targeted',
        area,
        title: `Targeted ${area} regression`,
        expectedDuration: area === 'uat' ? 'about 2-5 minutes' : 'about 1-3 minutes',
        longRunning: false,
        stages: [serialStage(
          `Targeted ${area} contracts`,
          targetedCommands(area, request.documentPath)
        )]
      };
    }
    case 'release':
      return {
        tier: 'release',
        title: 'Full release gate',
        expectedDuration: 'about 10-20 minutes',
        longRunning: true,
        stages: [
          {
            title: 'Static checks and domain suites',
            maxConcurrency: 3,
            commands: [
              packageScript('typecheck'),
              packageScript('architecture:check'),
              packageScript('test:latex-scanner'),
              packageScript('test:table-provenance'),
              packageScript('test:table-column-width'),
              packageScript('test:table-sticky-header'),
              packageScript('test:table-command'),
              packageScript('test:image-presentation'),
              packageScript('test:mermaid-presentation'),
              packageScript('test:unit')
            ]
          },
          serialStage('Production browser matrix', [packageScript('test:browser')]),
          serialStage('Production build', [packageScript('build')]),
          serialStage('VSIX content validation', [packageScript('package:check')])
        ]
      };
    case 'endurance': {
      const documentPath = request.documentPath;
      if (!documentPath) throw new Error('Endurance UAT requires a document path');
      return {
        tier: 'endurance',
        title: 'Full-document endurance UAT',
        expectedDuration: 'about 15-30 minutes per run',
        longRunning: true,
        stages: [serialStage('Full-document endurance contracts', [{
          args: ['scripts/test-uat-full-document-endurance.ts', documentPath],
          env: { MEO_UAT_STRICT_FINDING: '*' }
        }])]
      };
    }
    case 'large-document': {
      const documentPath = request.documentPath;
      if (!documentPath) {
        throw new Error('Large-document stress test requires a document path');
      }
      return {
        tier: 'large-document',
        title: 'Simplified large-document stress test',
        expectedDuration: 'about 1-3 minutes',
        longRunning: true,
        stages: [serialStage('Large-document stress contracts', [
          packageScript('benchmark:large-document'),
          {
            args: ['scripts/test-uat-full-document-endurance.ts', documentPath],
            env: {
              MEO_UAT_ENDURANCE_LIMIT: '8',
              MEO_UAT_STRICT_FINDING: '*'
            }
          },
          {
            args: [
              'scripts/test-production-live-scroll-integrity.ts',
              `--document=${documentPath}`
            ]
          }
        ])]
      };
    }
  }
}

export function validateTestWorkflowAuthorization(
  plan: TestWorkflowPlan,
  confirmLongRun: boolean,
  dryRun: boolean
): void {
  if (plan.longRunning && !confirmLongRun && !dryRun) {
    throw new Error(
      `${plan.title} is a long-running workflow. Re-run with --confirm-long-run only after the user explicitly authorizes it for the current task.`
    );
  }
}
