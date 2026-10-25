import type { PreviewCodeSource } from '../../../src/foundation/previewDocument';

const documents = new WeakMap<Document, Map<string, PreviewCodeSource>>();
const retained = new WeakMap<Element, PreviewCodeSource>();

export function previewCodeSource(code: Element): PreviewCodeSource | undefined {
  const id = code.closest<HTMLElement>('[data-meo-code-id]')?.dataset.meoCodeId;
  if (!id) return undefined;
  const previous = retained.get(code);
  if (previous?.id === id) return previous;
  const source = documents.get(code.ownerDocument)?.get(id);
  if (source) retained.set(code, source);
  return source;
}

/** Old themed nodes retain their context while an edited fence waits for tokens. */
export function setPreviewCodeSources(document: Document, sources: readonly PreviewCodeSource[] = []): void {
  for (const code of document.querySelectorAll('code.hljs')) previewCodeSource(code);
  documents.set(document, new Map(sources.map(source => [source.id, source])));
}
