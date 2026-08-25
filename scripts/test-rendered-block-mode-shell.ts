import assert from 'node:assert/strict';
import {
  decideRenderedBlockModeShell,
  type RenderedBlockKind
} from '../webview/src/editor/renderedBlockModeShell';

const kinds: ReadonlyArray<{
  kind: RenderedBlockKind;
  controls: string;
  editor: string;
  splitAction: string;
  sourceAction: string;
  previewAction: string;
}> = [
  {
    kind: 'mermaid',
    controls: 'Mermaid block controls at line 12',
    editor: 'Mermaid editor at line 12',
    splitAction: 'Edit Mermaid in split view',
    sourceAction: 'Show Mermaid code only',
    previewAction: 'Show Mermaid preview'
  },
  {
    kind: 'latex',
    controls: 'Formula block controls at line 12',
    editor: 'Formula editor at line 12',
    splitAction: 'Edit formula in split view',
    sourceAction: 'Show formula source only',
    previewAction: 'Show formula preview'
  }
];

for (const example of kinds) {
  const preview = decideRenderedBlockModeShell({
    kind: example.kind,
    lineNumber: 12,
    manualMode: 'preview',
    temporaryReveal: false
  });
  assert.deepEqual(preview, {
    effectiveMode: 'preview',
    modeClass: 'is-preview',
    nextManualMode: 'split',
    controlsLabel: example.controls,
    editorLabel: example.editor,
    modeButton: { action: 'edit', label: example.splitAction },
    wideLayout: 'presentation-only',
    previewLifecycle: 'presented'
  });

  const temporarySplit = decideRenderedBlockModeShell({
    kind: example.kind,
    lineNumber: 12,
    manualMode: 'preview',
    temporaryReveal: true
  });
  assert.equal(temporarySplit.effectiveMode, 'split');
  assert.equal(temporarySplit.modeClass, 'is-split');
  assert.equal(temporarySplit.nextManualMode, 'source');
  assert.equal(temporarySplit.wideLayout, 'side-by-side');
  assert.equal(temporarySplit.previewLifecycle, 'deferred');

  const manualSplit = decideRenderedBlockModeShell({
    kind: example.kind,
    lineNumber: 12,
    manualMode: 'split',
    temporaryReveal: false
  });
  assert.deepEqual(manualSplit.modeButton, { action: 'source', label: example.sourceAction });

  const manualSource = decideRenderedBlockModeShell({
    kind: example.kind,
    lineNumber: 12,
    manualMode: 'source',
    temporaryReveal: true
  });
  assert.equal(manualSource.effectiveMode, 'source', 'manual mode must override an older reveal');
  assert.equal(manualSource.modeClass, 'is-source');
  assert.equal(manualSource.nextManualMode, 'preview');
  assert.deepEqual(manualSource.modeButton, { action: 'preview', label: example.previewAction });
  assert.equal(manualSource.wideLayout, 'source-only');
  assert.equal(manualSource.previewLifecycle, 'destroyed');
}

console.log('Rendered block mode shell tests passed.');
