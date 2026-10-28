export type TestWorkflowTier =
  | 'ui-light'
  | 'quick'
  | 'regression'
  | 'targeted'
  | 'release'
  | 'endurance'
  | 'large-document';

export type TargetedTestArea =
  | 'history'
  | 'table'
  | 'rendered'
  | 'appearance'
  | 'search'
  | 'viewport'
  | 'changes'
  | 'uat';

export type TestWorkflowCommand = {
  args: string[];
  env?: Record<string, string>;
};

export type TestWorkflowStage = {
  title: string;
  commands: TestWorkflowCommand[];
  maxConcurrency?: number;
  requiresPassed?: boolean;
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
  'search',
  'viewport',
  'changes',
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
        script('scripts/test-preview-shortcuts-production.ts'),
        script('scripts/test-math-completion-production.ts'),
        script('scripts/test-input-assistance-production.ts'),
        script('scripts/test-html-comment-input-production.ts'),
        script('scripts/test-editing-features-production.ts'),
        script('scripts/test-mixed-html-paste-production.ts'),
        script('scripts/test-slash-commands-production.ts'),
        script('scripts/test-editor-shortcuts.ts'),
        script('scripts/test-editor-history-runtime.ts'),
        script('scripts/test-editor-history-production-cutover.ts'),
        script('scripts/test-history-rendered-block-interaction.ts'),
        script('scripts/test-editor-history-runtime-browser.ts'),
        script('scripts/test-rendered-content-history-roundtrip.ts'),
        script('scripts/test-history-matrix.ts'),
        script('scripts/test-table-body-history-shortcut.ts')
      ];
    case 'table':
      return [
        script('scripts/test-table-provenance-history.ts'),
        script('scripts/test-live-command-presentation.ts'),
        script('scripts/test-editing-features-production.ts'),
        script('scripts/test-mixed-html-paste-production.ts'),
        script('scripts/test-slash-commands-production.ts'),
        script('scripts/test-table-clipboard.ts'),
        script('scripts/test-table-clipboard-production.ts'),
        script('scripts/test-table-cell-editing.ts'),
        script('scripts/test-table-column-width-policy.ts'),
        script('scripts/test-table-column-width-lifecycle.ts'),
        script('scripts/test-table-column-resize-viewport.ts'),
        script('scripts/test-table-diff-refresh.ts'),
        script('scripts/test-table-body-interaction-sticky-production.ts'),
        script('scripts/test-table-input-visual-stability.ts'),
        script('scripts/test-table-visible-history-viewport.ts'),
        script('scripts/test-mode-roundtrip-reveal.ts'),
        script('scripts/test-table-body-history-shortcut.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'rendered':
      return [
        packageScript('test:rendered-source'),
        script('scripts/test-math-tag-layout.ts'),
        script('scripts/test-composite-block-layout.ts'),
        script('scripts/test-composite-render-parity.ts'),
        script('scripts/test-indented-code-blocks-production.ts'),
        script('scripts/test-mode-selection-continuity.ts'),
        script('scripts/test-html-content.ts'),
        script('scripts/test-inline-syntax-boundaries.ts'),
        script('scripts/test-inline-syntax-boundaries-production.ts'),
        script('scripts/test-rendered-block-mode-shell.ts'),
        script('scripts/test-history-rendered-block-interaction.ts'),
        script('scripts/test-mermaid-diagram-presentation-runtime.ts'),
        script('scripts/test-mermaid-editing.ts'),
        script('scripts/test-preview-rendered-actions.ts'),
        script('scripts/test-live-rendered-image-copy.ts'),
        script('scripts/test-rendered-block-action-state.ts'),
        script('scripts/test-live-embedded-input-viewport.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'appearance':
      return [
        packageScript('test:theme-inheritance'),
        script('scripts/test-ui-colors-production.ts'),
        script('scripts/test-outline-colors-production.ts'),
        script('scripts/test-ui-colors.ts'),
        script('scripts/test-shiki-empty-line-recovery.ts'),
        script('scripts/test-source-syntax-stability.ts'),
        script('scripts/test-source-syntax-first-paint.ts'),
        script('scripts/test-source-theme-customizations.ts'),
        script('scripts/test-preview-preset-host.ts'),
        script('scripts/test-preview-fonts.ts'),
        script('scripts/test-preview-preset-preferences.ts'),
        script('scripts/test-preview-preset-preferences-browser.ts'),
        script('scripts/test-preview-presets-browser.ts'),
        script('scripts/test-preview-preset-position.ts'),
        { args: ['scripts/test-preview-preset-position.ts', '--large'] },
        script('scripts/test-preview-outline-viewport-browser.ts'),
        script('scripts/test-github-preset-export-browser.ts'),
        script('scripts/test-export-links.ts'),
        script('scripts/test-export-links-browser.ts'),
        script('scripts/test-preview-comment-toggle-browser.ts'),
        script('scripts/test-inline-code-layout-production.ts'),
        script('scripts/test-settings-window-production.ts'),
        script('scripts/test-editor-font-wheel.ts'),
        script('scripts/test-preview-preset-management-browser.ts'),
        script('scripts/test-toolbar-menus-browser.ts'),
        script('scripts/test-tooltips-production.ts'),
        script('scripts/test-linked-image-tooltips-production.ts'),
        script('scripts/test-tooltip-pointer-position.ts'),
        script('scripts/test-tooltip-hover-sequence.ts'),
        script('scripts/test-tooltip-display-latency.ts'),
        script('scripts/test-appearance-webview-adapter.ts'),
        script('scripts/test-appearance-settings.ts'),
        script('scripts/test-vscode-theme-transition.ts'),
        script('scripts/test-math-syntax-production.ts'),
        script('scripts/test-highlight.ts'),
        script('scripts/test-preview-code-highlight-layout.ts')
      ];
    case 'search':
      return [
        script('scripts/test-input-focus-return-production.ts'),
        script('scripts/test-search-replace-production.ts'),
        script('scripts/test-search-overview-ruler.ts'),
        script('scripts/test-webview-search-controls.ts'),
        script('scripts/test-search-mode-continuity.ts'),
        script('scripts/test-viewport-controller.ts'),
        script('scripts/test-table-column-width-lifecycle.ts')
      ];
    case 'viewport':
      return [
        packageScript('test:toolbar-viewport'),
        script('scripts/test-source-syntax-stability.ts'),
        script('scripts/test-preview-navigation-continuity.ts'),
        script('scripts/test-preview-preset-position.ts'),
        { args: ['scripts/test-preview-preset-position.ts', '--large'] },
        script('scripts/test-native-scroll-progress-production.ts'),
        script('scripts/test-rendered-block-scroll-layout.ts'),
        script('scripts/test-long-document-scroll.ts'),
        packageScript('test:reading-position'),
        script('scripts/test-font-size-viewport.ts'),
        script('scripts/test-embedded-source-font-size.ts'),
        script('scripts/test-viewport-controller.ts'),
        script('scripts/test-toolbar-input-viewport.ts'),
        script('scripts/test-line-number-typing-stability.ts'),
        script('scripts/test-line-number-no-wrap-stability.ts'),
        script('scripts/test-line-number-rendered-block-stability.ts'),
        script('scripts/test-line-number-layout-contract.ts'),
        script('scripts/test-display-math-gutter-paint.ts'),
        packageScript('test:input-presentation'),
        script('scripts/test-source-empty-line-caret.ts'),
        { args: ['scripts/test-source-diff-long-caret.ts', '--sampled', '--hidpi'] },
        script('scripts/test-fenced-block-enter-stability.ts'),
        script('scripts/test-indented-code-blocks-production.ts'),
        script('scripts/test-document-reload-mermaid-viewport.ts'),
        script('scripts/test-mode-roundtrip-reveal.ts'),
        script('scripts/test-mode-transition-matrix.ts'),
        script('scripts/test-uat-viewport-stability.ts'),
        script('scripts/test-live-embedded-input-viewport.ts'),
        script('scripts/test-table-position-after-embedded-edit.ts'),
        script('scripts/test-virtual-block-scroll-stability.ts')
      ];
    case 'changes':
      return [
        script('scripts/test-git-diff-background.ts'),
        script('scripts/test-changes-review.ts'),
        script('scripts/test-changes-review-consistency.ts'),
        script('scripts/test-git-diff-line-highlights-setting.ts'),
        script('scripts/test-saved-revision-tracker.ts'),
        script('scripts/test-diff-baseline-selection.ts'),
        script('scripts/test-document-diff-gutter.ts'),
        script('scripts/test-git-diff-overview-ruler.ts'),
        script('scripts/test-webview-viewport.ts'),
        script('scripts/test-table-diff-refresh.ts')
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
    || !['ui-light', 'quick', 'regression', 'targeted', 'release', 'endurance', 'large-document'].includes(tier)
  ) {
    throw new Error(
      'Expected one tier: ui-light, quick, regression, targeted, release, endurance, or large-document'
    );
  }

  if (tier === 'targeted') {
    const area = positional[1] as TargetedTestArea | undefined;
    if (!area || !targetedAreas.has(area)) {
      throw new Error(
        `Unknown targeted area "${area ?? ''}". Expected history, table, rendered, appearance, search, viewport, changes, or uat`
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
    case 'ui-light':
      return {
        tier: 'ui-light',
        title: 'Light UI automated build checks',
        expectedDuration: 'Webview build plus separate focused smoke checks',
        longRunning: false,
        stages: [serialStage('Webview build', [packageScript('build:webview')])]
      };
    case 'quick':
      return {
        tier: 'quick',
        title: 'Core development checks',
        expectedDuration: 'bounded core checks; affected-feature checks are additionally required',
        longRunning: false,
        stages: [serialStage('Core development contracts', [
          packageScript('typecheck'),
          script('scripts/test-document-session.ts'),
          script('scripts/test-document-auto-save-concurrency.ts'),
          script('scripts/test-document-save-flush-protocol.ts'),
          script('scripts/test-panel-session-ready-init.ts'),
          script('scripts/test-panel-session-window-focus.ts'),
          script('scripts/test-editor-history-runtime.ts'),
          script('scripts/test-editing-preferences.ts'),
          script('scripts/test-live-input-derived-work.ts'),
          script('scripts/test-viewport-controller.ts'),
          script('scripts/test-large-document-policy.ts'),
          script('scripts/test-test-workflow.ts'),
          script('scripts/test-test-inventory.ts'),
          script('scripts/test-source-syntax-first-paint.ts'),
          script('scripts/test-mode-roundtrip-reveal.ts'),
          script('scripts/test-virtual-block-scroll-stability.ts')
        ])]
      };
    case 'regression':
      return {
        tier: 'regression',
        title: 'Broad development regression',
        expectedDuration: 'historical full matrix 24-31 minutes; host dependent',
        longRunning: true,
        stages: [serialStage('Broad regression contracts', [
          packageScript('typecheck'),
          script('scripts/test-source-theme-customizations.ts'),
          script('scripts/test-shiki-empty-line-recovery.ts'),
          script('scripts/test-source-syntax-stability.ts'),
          script('scripts/test-source-syntax-first-paint.ts'),
          script('scripts/test-math-syntax-production.ts'),
          script('scripts/test-preview-presets.ts'),
          script('scripts/test-export-links.ts'),
          script('scripts/test-export-links-browser.ts'),
          script('scripts/test-preview-fonts.ts'),
          script('scripts/test-preview-preset-preferences.ts'),
          script('scripts/test-preview-preset-preferences-browser.ts'),
          script('scripts/test-preview-preset-position.ts'),
          script('scripts/test-editor-shortcuts.ts'),
          script('scripts/test-editing-preferences.ts'),
          script('scripts/test-math-completion.ts'),
          script('scripts/test-math-completion-production.ts'),
          script('scripts/test-html-completion-production.ts'),
          script('scripts/test-editor-services.ts'),
          script('scripts/test-link-candidates.ts'),
          script('scripts/test-document-links.ts'),
          script('scripts/test-local-links-production.ts'),
          script('scripts/test-input-assistance-production.ts'),
          script('scripts/test-html-comment-input-production.ts'),
          script('scripts/test-inline-code-layout-production.ts'),
          script('scripts/test-editing-features-production.ts'),
          script('scripts/test-link-candidates-production.ts'),
          script('scripts/test-mixed-html-paste-production.ts'),
          script('scripts/test-slash-commands-production.ts'),
          script('scripts/test-settings-window-production.ts'),
          script('scripts/test-editor-font-wheel.ts'),
          script('scripts/test-ui-colors.ts'),
          script('scripts/test-ui-colors-production.ts'),
          script('scripts/test-outline-colors-production.ts'),
          script('scripts/test-preview-preset-management-browser.ts'),
          script('scripts/test-input-focus-return-production.ts'),
          packageScript('test:reading-position'),
          script('scripts/test-test-workflow.ts'),
          script('scripts/test-document-auto-save-concurrency.ts'),
          script('scripts/test-panel-session-ready-init.ts'),
          script('scripts/test-panel-session-window-focus.ts'),
          script('scripts/test-editor-startup-load.ts'),
          script('scripts/test-mode-roundtrip-reveal.ts'),
          script('scripts/test-preview-navigation-continuity.ts'),
          script('scripts/test-preview-shortcuts-production.ts'),
          script('scripts/test-editor-history-runtime.ts'),
          script('scripts/test-table-cell-editing.ts'),
          script('scripts/test-rendered-block-mode-shell.ts'),
          script('scripts/test-live-input-derived-work.ts'),
          script('scripts/test-git-diff-background.ts'),
          packageScript('test:large-document-budget'),
          script('scripts/test-viewport-controller.ts'),
          script('scripts/test-native-scroll-progress-production.ts'),
          script('scripts/test-toolbar-input-viewport.ts'),
          script('scripts/test-line-number-typing-stability.ts'),
          script('scripts/test-line-number-no-wrap-stability.ts'),
          script('scripts/test-line-number-rendered-block-stability.ts'),
          script('scripts/test-line-number-layout-contract.ts'),
          script('scripts/test-display-math-gutter-paint.ts'),
          packageScript('test:input-presentation'),
          { args: ['scripts/test-source-diff-long-caret.ts', '--sampled', '--hidpi'] },
          script('scripts/test-fenced-block-enter-stability.ts'),
          script('scripts/test-html-enter-gutter-stability.ts'),
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
        expectedDuration: 'complete area pack; inspect the plan and recent timings before running',
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
        expectedDuration: request.documentPath
          ? 'full release gate plus complete font sweep and endurance; see per-stage timing report'
          : 'historical baseline 55-105 minutes, excluding native acceptance and document supplements',
        longRunning: true,
        stages: [
          serialStage('Production build', [packageScript('build')]),
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
              packageScript('test:reading-position'),
              packageScript('test:changes-review'),
              packageScript('test:unit'),
              script('scripts/test-large-document-opening-migration.ts'),
              script('scripts/test-panel-session-ready-init.ts')
            ]
          },
          serialStage('High-risk browser regression preflight', [
            packageScript('test:input-presentation'),
            packageScript('test:large-document-budget'),
            script('scripts/test-editor-startup-load.ts'),
            script('scripts/test-mode-roundtrip-reveal.ts'),
            script('scripts/test-preview-navigation-continuity.ts'),
            script('scripts/test-preview-shortcuts-production.ts'),
            packageScript('test:browser-high-risk')
          ]),
          serialStage('Production browser matrix', [packageScript('test:browser')]),
          serialStage('VSIX content validation', [packageScript('package:check')]),
          ...(request.documentPath ? [
            { ...serialStage('Full-document font sweep', [{ args: ['scripts/test-font-size-full-document.ts',
              `--document=${request.documentPath}`, '--confirm-long-run'] }]), requiresPassed: true },
            ...createTestWorkflowPlan({ ...request, tier: 'endurance' }).stages.map(stage => ({ ...stage, requiresPassed: true }))
          ] : [])
        ]
      };
    case 'endurance': {
      const documentPath = request.documentPath;
      if (!documentPath) throw new Error('Endurance UAT requires a document path');
      return {
        tier: 'endurance',
        title: 'Full-document endurance UAT',
        expectedDuration: 'about 20-35 minutes per run',
        longRunning: true,
        stages: [
          serialStage('Recent interaction regression preflight', [
            script('scripts/test-uat-document-operations.ts'),
            script('scripts/test-document-auto-save-concurrency.ts'),
            script('scripts/test-document-save-flush-webview-adapter.ts'),
            script('scripts/test-vscode-document-save-lifecycle-adapter.ts'),
            script('scripts/test-panel-session-native-save-flush.ts'),
            script('scripts/test-native-save-table-flush.ts'),
            script('scripts/test-document-reload-mermaid-viewport.ts'),
            script('scripts/test-search-replace-production.ts'),
            script('scripts/test-table-body-interaction-sticky-production.ts'),
            script('scripts/test-mermaid-editing.ts'),
            script('scripts/test-changes-review.ts'),
            script('scripts/test-document-diff-gutter.ts'),
            script('scripts/test-code-block-line-numbers.ts'),
            script('scripts/test-long-code-blocks.ts')
          ]),
          serialStage('Full-document endurance contracts', [{
            args: ['scripts/test-uat-full-document-endurance.ts', documentPath],
            env: { MEO_UAT_STRICT_FINDING: '*' }
          }]),
          serialStage('Production full-document scroll integrity', [{
            args: [
              'scripts/test-production-live-scroll-integrity.ts',
              `--document=${documentPath}`
            ]
          }])
        ]
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
          { args: ['scripts/test-line-number-typing-stability.ts', '--long'] },
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
