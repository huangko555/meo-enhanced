import { Facet, type EditorState } from '@codemirror/state';

/** Presentation port for host-owned containers; no editor implementation crosses it. */
export interface DocumentBlockInput {
  readonly language: string;
  readonly text: string;
  readonly line: number;
  /** Editor-owned ephemeral state; the presentation adapter exposes it to renderers. */
  readonly camera?: { value?: { scale: number; x: number; y: number } };
}
export interface DocumentBlocksPort {
  /** Immutable renderer-availability receipt; absent ports stay state-local. */
  readonly revision?: object;
  supports(language: string): boolean;
  mount(container: HTMLElement, input: DocumentBlockInput): {
    update(input: DocumentBlockInput): void;
    dispose(): void;
  };
}

export const documentBlocksFacet = Facet.define<DocumentBlocksPort, DocumentBlocksPort | undefined>({ combine: values => values.at(-1) });

/** Built-in and registered renderers enter the same native-source editing path. */
export function isGraphBlockLanguage(state: EditorState, language: string | null | undefined): boolean {
  return !!language && (language === 'mermaid' || !!state.facet(documentBlocksFacet)?.supports(language));
}
