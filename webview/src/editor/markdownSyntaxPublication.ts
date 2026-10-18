import { ensureSyntaxTree, forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { usesLargeDocumentDerivedWorkBudget } from './liveInputDerivedWork';

/** Publish already completed work before the parser's later idle receipt can
 * retire an otherwise complete presentation. forceParsing uses the public empty
 * transaction path; it does not require recognizing a private language effect. */
export const markdownSyntaxPublication = ViewPlugin.fromClass(class {
  private queued = false;
  private disposed = false;

  constructor(private readonly view: EditorView) { this.schedule(); }

  update() { this.schedule(); }

  private schedule() {
    if (this.queued || this.disposed || !usesLargeDocumentDerivedWorkBudget(this.view.state)) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      const state = this.view.state;
      if (!usesLargeDocumentDerivedWorkBudget(state) || !syntaxTreeAvailable(state, state.doc.length)) return;
      const completed = ensureSyntaxTree(state, state.doc.length, 0);
      if (!completed || completed === syntaxTree(state)) return;
      forceParsing(this.view, state.doc.length, 0);
    });
  }

  destroy() { this.disposed = true; }
});
