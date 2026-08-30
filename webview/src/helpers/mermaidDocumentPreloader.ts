import type { EditorState } from '@codemirror/state';
import { resolvedSyntaxTree } from './markdownSyntax';
import {
  getFencedCodeContent,
  getMermaidEditorPresentationIdentity,
  normalizeMermaidDiagramText
} from './mermaidDiagram';
import type { MermaidDiagramPresentationConsumer } from '../editor/mermaidDiagramPresentation';

export type MermaidDocumentPreloader = {
  schedule(state: EditorState): void;
  dispose(): void;
};

type MermaidSource = {
  readonly line: number;
  readonly source: string;
};

function codeInfo(state: EditorState, node: any): string | null {
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeInfo') {
      return state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    }
  }
  return null;
}

export function collectDocumentMermaidSources(state: EditorState): readonly MermaidSource[] {
  const sources: MermaidSource[] = [];
  const seen = new Set<string>();
  resolvedSyntaxTree(state).iterate({
    enter(node: any) {
      if (node.name !== 'FencedCode' || codeInfo(state, node) !== 'mermaid') return;
      const source = getFencedCodeContent(state, node);
      if (!source.trim() || seen.has(source)) return;
      seen.add(source);
      sources.push({ line: state.doc.lineAt(node.from).number, source });
    }
  });
  return sources;
}

/**
 * Starts at both document edges so ordinary forward reading and an immediate
 * outline jump to the end both benefit before background work reaches the
 * middle of a long Document.
 */
export function orderMermaidPreloads(
  sources: readonly MermaidSource[]
): readonly MermaidSource[] {
  const ordered: MermaidSource[] = [];
  for (let left = 0, right = sources.length - 1; left <= right; left += 1, right -= 1) {
    ordered.push(sources[right]);
    if (left !== right) ordered.push(sources[left]);
  }
  return ordered;
}

/** Owns bounded, deduplicated Mermaid warming for one Live Editor. */
export function createMermaidDocumentPreloader(
  consumer: MermaidDiagramPresentationConsumer,
  onHeightAvailable: () => void
): MermaidDocumentPreloader {
  let latestState: EditorState | null = null;
  let timer: number | null = null;
  let disposed = false;

  const run = (): void => {
    timer = null;
    if (disposed || !latestState) return;
    const identity = getMermaidEditorPresentationIdentity();
    const requests = orderMermaidPreloads(collectDocumentMermaidSources(latestState)).map(({ source }) => ({
      rawSource: source,
      normalizedSource: normalizeMermaidDiagramText(source),
      themeKey: identity.themeKey,
      configKey: identity.configKey,
      priority: 'normal' as const
    }));
    void (async () => {
      for (const request of requests) {
        if (disposed) return;
        await consumer.preload(request);
        if (!disposed) onHeightAvailable();
      }
    })();
  };

  const schedule = (state: EditorState): void => {
    if (disposed) return;
    latestState = state;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(run, 40);
  };

  const unsubscribeThemeRefresh = consumer.subscribeThemeRefresh(() => {
    if (latestState) schedule(latestState);
  });

  return {
    schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      latestState = null;
      unsubscribeThemeRefresh();
    }
  };
}
