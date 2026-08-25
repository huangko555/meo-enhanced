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
    manualMode: 'preview',
    effectiveMode: 'preview',
    modeClass: 'is-preview',
    manualIntent: { mode: 'split', clearsTemporaryReveal: true },
    controlsLabel: example.controls,
    editorLabel: example.editor,
    modeButton: { action: 'edit', label: example.splitAction },
    layout: { wide: 'presentation-only', narrow: 'presentation-only' },
    source: 'destroyed',
    preview: 'presented'
  });

  const temporarySplit = decideRenderedBlockModeShell({
    kind: example.kind,
    lineNumber: 12,
    manualMode: 'preview',
    temporaryReveal: true
  });
  assert.equal(temporarySplit.effectiveMode, 'split');
  assert.equal(temporarySplit.modeClass, 'is-split');
  assert.deepEqual(temporarySplit.manualIntent, { mode: 'source', clearsTemporaryReveal: true });
  assert.deepEqual(temporarySplit.layout, { wide: 'side-by-side', narrow: 'stacked' });
  assert.equal(temporarySplit.source, 'visible');
  assert.equal(temporarySplit.preview, 'deferred');

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
  assert.deepEqual(manualSource.manualIntent, { mode: 'preview', clearsTemporaryReveal: true });
  assert.deepEqual(manualSource.modeButton, { action: 'preview', label: example.previewAction });
  assert.deepEqual(manualSource.layout, { wide: 'source-only', narrow: 'source-only' });
  assert.equal(manualSource.source, 'visible');
  assert.equal(manualSource.preview, 'destroyed');
}

console.log('Rendered block mode shell tests passed.');
