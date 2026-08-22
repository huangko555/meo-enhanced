import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  currentSyntaxTree,
  extractDetailsBlocks,
  resolvedSyntaxTree,
  type DetailsBlockInfo
} from './markdownSyntax';
import { getViewportController } from './viewportController';
import {
  isLiveInputDerivedWorkRefresh,
  shouldDeferLiveInputDerivedWork
} from '../editor/liveInputDerivedWork';

const toggleDetailsBlockEffect = StateEffect.define<number>();
const emptyDetailsOverrides = Object.freeze(new Map<number, boolean>());
const detailsBlockLiveActiveField = StateField.define<boolean>({
  create: () => true,
  update: () => true
});

export interface DetailsBlockState extends DetailsBlockInfo {
  collapsed: boolean;
}

function mapDetailsOverrides(
  overrides: ReadonlyMap<number, boolean>,
  transaction: Transaction
): Map<number, boolean> {
  if (!overrides.size || !transaction.docChanged) return new Map(overrides);
  return new Map(Array.from(overrides, ([anchor, collapsed]) => [
    transaction.changes.mapPos(anchor, 1),
    collapsed
  ]));
}

function normalizeDetailsOverrides(
  state: EditorState,
  overrides: Map<number, boolean>
): ReadonlyMap<number, boolean> {
  const blocks = new Map(extractDetailsBlocks(state).map((block) => [block.anchorFrom, block] as const));
  const entries = Array.from(overrides)
    .filter(([anchor, collapsed]) => {
      const block = blocks.get(anchor);
      return block && collapsed !== block.defaultCollapsed;
    })
    .sort((a, b) => a[0] - b[0]);
  return entries.length ? new Map(entries) : emptyDetailsOverrides;
}

function overridesEqual(a: ReadonlyMap<number, boolean>, b: ReadonlyMap<number, boolean>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  const aEntries = a.entries();
  const bEntries = b.entries();
  while (true) {
    const nextA = aEntries.next();
    const nextB = bEntries.next();
    if (nextA.done || nextB.done) return nextA.done === nextB.done;
    if (nextA.value[0] !== nextB.value[0] || nextA.value[1] !== nextB.value[1]) return false;
  }
}

const detailsBlockStateField = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => emptyDetailsOverrides,
  update(overrides, transaction) {
    const toggleEffects = transaction.effects.filter((effect) => effect.is(toggleDetailsBlockEffect));
    if (shouldDeferLiveInputDerivedWork(transaction)) {
      return transaction.docChanged ? mapDetailsOverrides(overrides, transaction) : overrides;
    }
    if (!transaction.docChanged
      && !isLiveInputDerivedWorkRefresh(transaction)
      && toggleEffects.length === 0) return overrides;

    const next = mapDetailsOverrides(overrides, transaction);
    if (!transaction.state.field(detailsBlockLiveActiveField, false) && toggleEffects.length === 0) {
      return overridesEqual(next, overrides) ? overrides : next;
    }
    const blocks = new Map(extractDetailsBlocks(transaction.state).map((block) => [block.anchorFrom, block] as const));
    for (const effect of toggleEffects) {
      const block = blocks.get(effect.value);
      if (!block) continue;
      const collapsed = !(next.get(block.anchorFrom) ?? block.defaultCollapsed);
      if (collapsed === block.defaultCollapsed) next.delete(block.anchorFrom);
      else next.set(block.anchorFrom, collapsed);
    }

    const normalized = normalizeDetailsOverrides(transaction.state, next);
    return overridesEqual(normalized, overrides) ? overrides : normalized;
  }
});

const detailsBlockStateExtension = Object.freeze([detailsBlockStateField]);

export function detailsBlockStateExtensions(): readonly any[] {
  return detailsBlockStateExtension;
}

export function getDetailsBlocks(
  state: EditorState,
  tree = resolvedSyntaxTree(state)
): DetailsBlockState[] {
  const overrides = state.field(detailsBlockStateField, false) ?? emptyDetailsOverrides;
  return extractDetailsBlocks(state, tree).map((block) => ({
    ...block,
    collapsed: overrides.get(block.anchorFrom) ?? block.defaultCollapsed
  }));
}

export function toggleDetailsBlock(view: EditorView, anchor: number): boolean {
  const block = extractDetailsBlocks(view.state).find((candidate) => candidate.anchorFrom === anchor);
  if (!block) return false;

  const collapsed = getDetailsBlocks(view.state)
    .find((candidate) => candidate.anchorFrom === anchor)?.collapsed ?? block.defaultCollapsed;
  const selectionTouchesBody = view.state.selection.ranges.some((range) => (
    range.empty
      ? range.from > block.bodyFrom && range.from < block.bodyTo
      : range.from < block.bodyTo && range.to > block.bodyFrom
  ));
  const transaction: any = {
    effects: toggleDetailsBlockEffect.of(anchor),
    annotations: Transaction.addToHistory.of(false)
  };
  if (!collapsed && selectionTouchesBody) transaction.selection = { anchor: block.lineFrom };

  const mutate = () => {
    view.dispatch(transaction);
    view.focus();
  };
  const viewportController = getViewportController(view);
  if (viewportController) viewportController.preservePositionWhileMutation(block.lineFrom, mutate, 'immediate');
  else mutate();
  return true;
}

const detailsBlockAutoExpandSelectionExtension = EditorView.updateListener.of((update) => {
  if (update.transactions.some(shouldDeferLiveInputDerivedWork)) return;
  if (!update.state.field(detailsBlockLiveActiveField, false)) return;
  if (update.transactions.some((transaction) => (
    transaction.effects.some((effect) => effect.is(toggleDetailsBlockEffect))
  ))) return;

  const blocks = getDetailsBlocks(update.state, currentSyntaxTree(update.state)).filter((candidate) => candidate.collapsed && (
    update.state.selection.ranges.some((range) => (
      range.empty
        ? range.from > candidate.bodyFrom && range.from < candidate.bodyTo
        : range.from < candidate.bodyTo && range.to > candidate.bodyFrom
    ))
  ));
  if (blocks.length === 0) return;
  update.view.dispatch({
    effects: blocks.map((block) => toggleDetailsBlockEffect.of(block.anchorFrom)),
    annotations: Transaction.addToHistory.of(false)
  });
});

const detailsBlockLiveExtension = Object.freeze([
  detailsBlockLiveActiveField,
  detailsBlockAutoExpandSelectionExtension
]);

export function detailsBlockLiveExtensions(): readonly any[] {
  return detailsBlockLiveExtension;
}
