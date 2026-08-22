import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  extractDetailsBlocks,
  type DetailsBlockInfo
} from './markdownSyntax';
import { getViewportController } from './viewportController';
import {
  isLiveInputDerivedWorkRefresh,
  shouldDeferLiveInputDerivedWork
} from '../editor/liveInputDerivedWork';

const toggleDetailsBlockEffect = StateEffect.define<number>();
const detailsBlockLiveActiveField = StateField.define<boolean>({
  create: () => true,
  update: () => true
});

export interface DetailsBlockState extends DetailsBlockInfo {
  collapsed: boolean;
}

type DetailsBlockRecord = DetailsBlockState & {
  override: boolean | null;
};

function mapDetailsBlock(block: DetailsBlockRecord, transaction: Transaction): DetailsBlockRecord {
  const map = (position: number, assoc: -1 | 1 = 1) => transaction.changes.mapPos(position, assoc);
  return {
    ...block,
    anchorFrom: map(block.anchorFrom),
    anchorTo: map(block.anchorTo, -1),
    summaryFrom: map(block.summaryFrom),
    summaryTo: map(block.summaryTo, -1),
    lineFrom: map(block.lineFrom),
    lineTo: map(block.lineTo, -1),
    sectionFrom: map(block.sectionFrom),
    sectionTo: map(block.sectionTo, -1),
    bodyFrom: map(block.bodyFrom),
    bodyTo: map(block.bodyTo, -1),
    closingFrom: map(block.closingFrom),
    closingTo: map(block.closingTo, -1)
  };
}

function rebuildDetailsBlocks(
  state: EditorState,
  previous: readonly DetailsBlockRecord[],
  transaction: Transaction | null
): DetailsBlockRecord[] {
  const previousByAnchor = new Map(previous.map((block) => [
    transaction ? transaction.changes.mapPos(block.anchorFrom, 1) : block.anchorFrom,
    block
  ]));
  return extractDetailsBlocks(state).map((block) => {
    const override = previousByAnchor.get(block.anchorFrom)?.override ?? null;
    return {
      ...block,
      collapsed: override ?? block.defaultCollapsed,
      override
    };
  });
}

function applyDetailsToggleEffects(
  blocks: readonly DetailsBlockRecord[],
  transaction: Transaction
): DetailsBlockRecord[] {
  const toggles = transaction.effects
    .filter((effect) => effect.is(toggleDetailsBlockEffect))
    .map((effect) => effect.value);
  if (toggles.length === 0) return blocks as DetailsBlockRecord[];
  let next = blocks as DetailsBlockRecord[];
  for (const anchor of toggles) {
    next = next.map((block) => block.anchorFrom === anchor
      ? {
          ...block,
          collapsed: !block.collapsed,
          override: !block.collapsed === block.defaultCollapsed ? null : !block.collapsed
        }
      : block);
  }
  return next;
}

const detailsBlockStateField = StateField.define<DetailsBlockRecord[]>({
  create: (state) => rebuildDetailsBlocks(state, [], null),
  update(previous, transaction) {
    const toggleEffects = transaction.effects.filter((effect) => effect.is(toggleDetailsBlockEffect));
    if (shouldDeferLiveInputDerivedWork(transaction)) {
      const mapped = transaction.docChanged
        ? previous.map((block) => mapDetailsBlock(block, transaction))
        : previous;
      return applyDetailsToggleEffects(mapped, transaction);
    }
    if (!transaction.docChanged
      && !isLiveInputDerivedWorkRefresh(transaction)
      && !transaction.reconfigured
      && toggleEffects.length === 0) return previous;

    if (!transaction.state.field(detailsBlockLiveActiveField, false) && toggleEffects.length === 0) {
      return transaction.docChanged
        ? previous.map((block) => mapDetailsBlock(block, transaction))
        : previous;
    }
    const needsRebuild = transaction.docChanged
      || isLiveInputDerivedWorkRefresh(transaction)
      || transaction.reconfigured;
    const blocks = needsRebuild
      ? rebuildDetailsBlocks(transaction.state, previous, transaction)
      : previous;
    return applyDetailsToggleEffects(blocks, transaction);
  }
});

const detailsBlockStateExtension = Object.freeze([detailsBlockStateField]);

export function detailsBlockStateExtensions(): readonly any[] {
  return detailsBlockStateExtension;
}

export function getDetailsBlocks(
  state: EditorState,
  _tree?: unknown
): DetailsBlockState[] {
  return state.field(detailsBlockStateField, false) ?? [];
}

export function toggleDetailsBlock(view: EditorView, anchor: number): boolean {
  const block = getDetailsBlocks(view.state).find((candidate) => candidate.anchorFrom === anchor);
  if (!block) return false;

  const collapsed = block.collapsed;
  const nextCollapsed = !collapsed;
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
    const renderedBlock = Array.from(view.dom.querySelectorAll<HTMLElement>('.meo-md-html-block'))
      .find((candidate) => view.posAtDOM(candidate) === block.anchorFrom);
    const rendered = renderedBlock?.querySelector<HTMLDetailsElement>(
      ':scope > .meo-md-html-content > details'
    );
    if (rendered) rendered.open = !nextCollapsed;
    view.focus();
  };
  const viewportController = getViewportController(view);
  if (viewportController) viewportController.preservePositionWhileMutation(block.lineFrom, mutate, 'immediate');
  else mutate();
  return true;
}

const detailsBlockAutoExpandSelectionExtension = EditorView.updateListener.of((update) => {
  if (!update.state.field(detailsBlockLiveActiveField, false)) return;
  if (update.transactions.some((transaction) => (
    transaction.effects.some((effect) => effect.is(toggleDetailsBlockEffect))
  ))) return;

  const blocks = getDetailsBlocks(update.state).filter((candidate) => candidate.collapsed && (
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
