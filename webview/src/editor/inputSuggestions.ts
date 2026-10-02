import { createRequestPrefix } from '../adapters/requestIdentity';
import { EditorSelection, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { LinkCandidate } from '../../../src/protocol/editorServices';
import { detectSuggestionContext, emojiSuggestions, type SuggestionContext } from '../application/inputSuggestions';
import { inputAssistanceFacet } from './typingAssistance';
import { isCodeInput } from './pasteAssistance';
import { uiLanguageFacet } from './uiLanguage';
import { commandTitle } from '../application/settingsCatalog';
import type { EditorCommandId } from '../../../src/foundation/editingPreferences';

type Suggestion = LinkCandidate & { readonly caret?: number };
export function createInputSuggestions(options: {
  readonly requestLinks?: (context: { kind: 'documents' | 'paths' | 'headings'; query: string; target: string }) => Promise<readonly LinkCandidate[]>;
  readonly currentHeadings: () => readonly LinkCandidate[];
}): Extension {
  const plugin = ViewPlugin.fromClass(class {
    readonly popup = document.createElement('div');
    timer: ReturnType<typeof setTimeout> | null = null;
    generation = 0; disposed = false; index = 0;
    items: readonly Suggestion[] = []; context: SuggestionContext | null = null; head = 0;
    constructor(readonly view: EditorView) {
      this.popup.className = 'meo-input-suggestions'; this.popup.hidden = true; this.popup.setAttribute('role', 'listbox');
      this.popup.id = 'meo-input-suggestions-' + createRequestPrefix();
      view.dom.ownerDocument.body.append(this.popup);
      this.popup.addEventListener('pointerdown', event => event.preventDefault());
      // EditorView initializes composition/focus state after constructing plugins.
      queueMicrotask(() => { if (!this.disposed) this.schedule(); });
    }
    update(update: ViewUpdate) { if (update.transactions.some(transaction => transaction.isUserEvent('input.complete'))) { this.clear(); return; } if (update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some(transaction => transaction.reconfigured)) this.schedule(); }
    getContext() {
      const selection = this.view.state.selection;
      if (this.disposed || !selection.main.empty || selection.ranges.length !== 1 || this.view.compositionStarted || !this.view.hasFocus || this.view.dom.ownerDocument.activeElement !== this.view.contentDOM || isCodeInput(this.view)) return null;
      const range = selection.main, line = this.view.state.doc.lineAt(range.head);
      return detectSuggestionContext(this.view.state.sliceDoc(line.from, range.head), this.view.state.facet(inputAssistanceFacet));
    }
    schedule() {
      this.clear(); const context = this.getContext(); if (!context) return;
      const generation = this.generation;
      this.timer = setTimeout(() => { this.timer = null; void this.resolve(context, generation); }, context.type === 'documents' || context.type === 'paths' || context.type === 'headings' ? 160 : 40);
    }
    clear() {
      this.generation++; if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
      this.popup.hidden = true; this.items = []; this.context = null;
      this.view.contentDOM.removeAttribute('aria-controls'); this.view.contentDOM.removeAttribute('aria-activedescendant');
    }
    async resolve(context: SuggestionContext, generation: number) {
      const language = this.view.state.facet(uiLanguageFacet);
      let items: readonly Suggestion[];
      if (context.type === 'emoji') items = emojiSuggestions.filter(item => item.name.startsWith(context.query.toLowerCase())).map(item => ({ label: item.value + ' ' + item.name, insert: item.value, detail: '' }));
      else if (context.type === 'slash') {
        const blocks: readonly [EditorCommandId, string, number?][] = [
          ['heading1', '# '], ['heading2', '## '], ['heading3', '### '], ['heading4', '#### '], ['heading5', '##### '], ['heading6', '###### '],
          ['bullet', '- '], ['ordered', '1. '], ['taskList', '- [ ] '], ['quote', '> '], ['codeBlock', '```\n\n```', 4],
          ['insertTable', language === 'zh-CN' ? '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |' : '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |', 2], ['rule', '---\n'], ['blockMath', '$$\n\n$$', 3]
        ];
        items = blocks.filter(([command]) => [command, commandTitle(command, language)].some(value => value.toLocaleLowerCase().includes(context.query.toLocaleLowerCase())))
          .map(([command, insert, caret]) => ({ label: commandTitle(command, language), insert, detail: '', caret }));
      } else if (context.type === 'headings' && !context.target) items = options.currentHeadings().filter(item => item.label.toLocaleLowerCase().includes(context.query.toLocaleLowerCase())).slice(0, 50);
      else {
        try { items = await options.requestLinks?.({ kind: context.type, query: context.query, target: context.target }) ?? []; }
        catch { items = []; }
      }
      if (this.disposed || generation !== this.generation || JSON.stringify(context) !== JSON.stringify(this.getContext()) || !items.length) return;
      this.context = context; this.items = items; this.index = 0; this.head = this.view.state.selection.main.head;
      this.render();
    }
    render() {
      this.popup.replaceChildren();
      this.items.forEach((item, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'meo-input-suggestion'; row.setAttribute('role', 'option');
        row.id = this.popup.id + '-' + index; row.setAttribute('aria-selected', String(index === this.index)); row.tabIndex = -1;
        const label = document.createElement('span'); label.textContent = item.label; row.append(label);
        if (item.detail) { const detail = document.createElement('span'); detail.className = 'meo-input-suggestion-detail'; detail.textContent = item.detail; row.append(detail); }
        row.addEventListener('click', () => this.choose(index)); this.popup.append(row);
      });
      this.popup.hidden = false; this.view.contentDOM.setAttribute('aria-controls', this.popup.id); this.view.contentDOM.setAttribute('aria-activedescendant', this.popup.id + '-' + this.index);
      const coords = this.view.coordsAtPos(this.head); if (!coords) { this.clear(); return; }
      const bounds = this.popup.getBoundingClientRect();
      this.popup.style.left = Math.max(8, Math.min(coords.left, innerWidth - bounds.width - 8)) + 'px';
      this.popup.style.top = (coords.bottom + bounds.height + 8 <= innerHeight ? coords.bottom + 4 : Math.max(8, coords.top - bounds.height - 4)) + 'px';
      this.popup.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    choose(index: number) {
      const context = this.context, item = this.items[index];
      if (!context || !item || this.head !== this.view.state.selection.main.head || JSON.stringify(context) !== JSON.stringify(this.getContext())) { this.clear(); return; }
      let insert = item.insert;
      if (context.type === 'documents') insert = insert.replace(/\.(?:md|markdown|mdx|mdc)$/i, '');
      if (context.type === 'paths') insert = insert.split('/').map(part => encodeURIComponent(part)).join('/');
      if (context.type === 'headings' && !context.wiki) insert = encodeURIComponent(item.anchor ?? insert);
      const from = this.head - context.length;
      const caret = from + (item.caret ?? insert.length);
      this.clear();
      this.view.dispatch({ changes: { from, to: this.head, insert }, selection: EditorSelection.cursor(caret), annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] });
      this.view.focus();
    }
    keydown(event: KeyboardEvent) {
      if (event.isComposing || this.view.compositionStarted || this.popup.hidden || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'Escape') { event.preventDefault(); this.clear(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.index = (this.index + (event.key === 'ArrowDown' ? 1 : this.items.length - 1)) % this.items.length; this.render(); return true; }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); this.choose(this.index); return true; }
      return false;
    }
    destroy() { this.disposed = true; this.clear(); this.popup.remove(); }
  }, { eventHandlers: {
    keydown(event) { return this.keydown(event); },
    blur() { this.clear(); return false; },
    compositionstart() { this.clear(); return false; },
    compositionend() { this.schedule(); return false; }
  } });
  return plugin;
}
