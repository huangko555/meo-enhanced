import { createRequestPrefix } from '../adapters/requestIdentity';
import { EditorSelection, EditorState, Transaction, StateEffect, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { htmlCompletionSource, htmlLanguage } from '@codemirror/lang-html';
import { parser } from '@lezer/markdown';
import { isolateHistory } from '@codemirror/commands';
import type { LinkCandidate } from '../../../src/protocol/editorServices';
import { detectSuggestionContext, emojiSuggestions, isSuggestionAddress, type SuggestionContext } from '../application/inputSuggestions';
import { inputAssistanceFacet } from './typingAssistance';
import { isCodeInput } from './pasteAssistance';
import { uiLanguageFacet } from './uiLanguage';
import { readSlashQuery, slashCommandSuggestions, type SlashCommand } from '../application/slashCommands';
import { beginHtmlCommentTemplate } from './htmlCommentEditing';
import { nativeSymbolInput } from './nativeTypingAssistance';
import { addAutomaticSymbolPair } from './typingAssistance';
import { sourceTableAt } from './sourceTableCommands';
import { blockInsertion, type MarkdownInputContext } from './blockInsertion';
import { encodeMarkdownPath } from '../../../src/foundation/linkDestination';
import { scanHtmlTags } from '../../../src/foundation/htmlSyntax';
import { candidateMatchPositions, candidateTextMatch } from '../../../src/foundation/candidateText';
import { createTooltip } from '../adapters/tooltip';
import { detectMathCompletion, mathCompletionSuggestions, planMathCompletion, type MathCompletion, type MathCompletionContext, type MathCompletionBody } from './mathCompletion';

export const refreshInputSuggestions = StateEffect.define<null>();

type Suggestion = LinkCandidate & { readonly caret?: number; readonly slash?: SlashCommand; readonly math?: MathCompletion };
type HtmlCompletionContext = { readonly type: 'html'; readonly from: number; readonly to: number; readonly query: string; readonly options: readonly Completion[] };
type InputSuggestionContext = SuggestionContext | MathCompletionContext | HtmlCompletionContext;

/** Markdown recognizes some opening tags only after `>`; complete the unfinished token independently. */
function incompleteHtmlCompletion(state: EditorState, position: number, explicit: boolean, inputContext: (state: EditorState, position: number) => MarkdownInputContext) {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (node.parent && node.name !== 'Paragraph') node = node.parent;
  if (node.name !== 'Paragraph') return null;
  const from = Math.max(node.from, state.doc.lineAt(position).from), source = state.sliceDoc(from, position);
  if (!/^ {0,3}<[a-z][\w:-]*(?:\s[\s\S]*)?$/i.test(source) || scanHtmlTags(source).length) return null;
  if (inputContext(state, from + source.indexOf('<')) !== 'block') return null;
  // Value completion must see an existing closing quote to the right of the caret.
  const htmlState = EditorState.create({ doc: state.sliceDoc(from, state.doc.lineAt(position).to), extensions: htmlLanguage });
  const result = htmlCompletionSource(new CompletionContext(htmlState, source.length, explicit));
  return result ? { from: from + result.from, to: from + (result.to ?? source.length), options: result.options } : null;
}

export function createInputSuggestions(options: {
  readonly inputContext: (state: EditorState, position: number) => MarkdownInputContext;
  readonly mathContext: (state: EditorState, position: number) => MathCompletionBody | null;
  readonly renderMathPreview: (source: string) => string | null;
  readonly requestLinks?: (context: { kind: 'documents' | 'paths' | 'headings'; query: string; target: string; wiki?: boolean }) => Promise<readonly LinkCandidate[]>;
  readonly replaceCell?: (input: HTMLTextAreaElement, value: string, anchor: number, head?: number) => boolean;
  readonly focusTable?: () => void;
  readonly focusMath?: () => boolean;
  readonly cellCoords?: (input: HTMLTextAreaElement, offset: number) => { left: number; top: number };
  readonly currentHeadings: () => readonly LinkCandidate[];
}): Extension {
  const plugin = ViewPlugin.fromClass(class {
    readonly popup = document.createElement('div');
    ariaInput: HTMLElement | null = null;
    timer: ReturnType<typeof setTimeout> | null = null;
    generation = 0; disposed = false; index = 0;
    slashFrom: number | null = null;
    htmlActivation: 'typing' | 'explicit' | null = null;
    cellFrom: number | null = null; cellInput: HTMLTextAreaElement | null = null;
    fieldInput: HTMLTextAreaElement | null = null; fieldValue = '';
    selectedCommand = ''; resolvedQuery = '';
    positionFrame: number | null = null; above: boolean | null = null;
    tooltipFrame: number | null = null;
    selectedTooltip: ReturnType<typeof createTooltip> | null = null;
    dismissed = false;
    selectedCandidate = '';
    candidateKey(item: Suggestion) { return this.context?.type === 'documents' || this.context?.type === 'paths' ? item.detail || item.insert : item.detail + '#' + (item.anchor ?? item.insert); }
    readonly windowBlur = () => { this.dismissed = true; this.htmlActivation = null; this.clear(); };
    readonly nativeEvent = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLTextAreaElement) || !input.closest('.meo-md-html-table-wrap') || !this.view.dom.contains(input)) return;
      if (event.type === 'keydown') {
        if (this.keydown(event as KeyboardEvent)) event.stopImmediatePropagation();
        return;
      }
      if (event.type === 'compositionstart') { this.composing = true; return; }
      if (event.type === 'compositionend') this.composing = false;
      if (event.type === 'input' || event.type === 'pointerup') this.dismissed = false;
      if (event.type === 'focusout') {
        queueMicrotask(() => { if (input !== this.view.dom.ownerDocument.activeElement) { this.dismissed = true; this.cellFrom = null; this.cellInput = null; this.fields = []; this.clear(); } }); return;
      }
      const typed = event as InputEvent;
      // Native textarea IME commits do not emit an insertText input event.
      if (this.cellFrom === null && typed.data === '/' && (event.type === 'compositionend' || event.type === 'input' && typed.inputType === 'insertText') && input.selectionStart === input.selectionEnd && input.value[input.selectionStart - 1] === '/') {
        this.cellInput = input; this.cellFrom = input.selectionStart - 1; this.selectedCommand = ''; this.resolvedQuery = ''; this.above = null;
      }
      if (event.type === 'input') {
        if (this.fieldInput === input && this.fields.length) {
          const before = this.fieldValue, after = input.value;
          let start = 0, end = before.length, nextEnd = after.length;
          while (start < end && start < nextEnd && before[start] === after[start]) start++;
          while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
          const map = (pos: number, right: boolean) => pos < start ? pos : pos > end ? pos + nextEnd - end : right ? nextEnd : start;
          this.fields = this.fields.map(field => ({ from: map(field.from, false), to: map(field.to, true) }));
          this.templateEnd = map(this.templateEnd, true); this.fieldValue = after;
        }
      }
      this.schedule();
    };
    readonly reposition = () => {
      const window = this.view.dom.ownerDocument.defaultView;
      if (!window || this.popup.hidden || this.positionFrame !== null) return;
      this.positionFrame = window.requestAnimationFrame(() => {
        this.positionFrame = null;
        if (!this.disposed && !this.popup.hidden) this.position();
      });
    };
    fields: { from: number; to: number }[] = []; fieldIndex = 0; templateEnd = 0;
    parents: { fields: { from: number; to: number }[]; fieldIndex: number; templateEnd: number }[] = [];
    resetFields() { this.fields = []; this.parents = []; }
    composing = false;
    get reverseOrder() { return this.view.state.facet(inputAssistanceFacet).slashPreferAbove; }
    items: readonly Suggestion[] = []; context: InputSuggestionContext | null = null; head = 0;
    constructor(readonly view: EditorView) {
      this.popup.className = 'meo-input-suggestions'; this.popup.hidden = true; this.popup.setAttribute('role', 'listbox');
      this.popup.id = 'meo-input-suggestions-' + createRequestPrefix();
      view.dom.ownerDocument.body.append(this.popup);
      for (const type of ['input', 'keydown', 'select', 'pointerup', 'compositionstart', 'compositionend', 'focusout']) view.dom.addEventListener(type, this.nativeEvent, type === 'keydown' || type.startsWith('composition'));
      view.dom.ownerDocument.addEventListener('scroll', this.reposition, true);
      view.dom.ownerDocument.defaultView?.addEventListener('resize', this.reposition);
      view.dom.ownerDocument.defaultView?.addEventListener('blur', this.windowBlur);
      view.dom.ownerDocument.fonts.addEventListener('loadingdone', this.reposition);
      this.popup.addEventListener('pointerdown', event => event.preventDefault());
      // EditorView initializes composition/focus state after constructing plugins.
      queueMicrotask(() => { if (!this.disposed) this.schedule(); });
    }
    update(update: ViewUpdate) {
      if ((update.docChanged || update.selectionSet) && !update.transactions.some(transaction => transaction.isUserEvent('input.complete'))) this.dismissed = false;
      if (this.slashFrom !== null && update.docChanged) this.slashFrom = update.changes.mapPos(this.slashFrom, -1);
      if (!this.fieldInput && this.fields.length && update.docChanged) {
        this.fields = this.fields.map(field => ({ from: update.changes.mapPos(field.from, -1), to: update.changes.mapPos(field.to, 1) }));
        this.templateEnd = update.changes.mapPos(this.templateEnd, 1);
        this.parents = this.parents.map(parent => ({ ...parent,
          fields: parent.fields.map(field => ({ from: update.changes.mapPos(field.from, -1), to: update.changes.mapPos(field.to, 1) })),
          templateEnd: update.changes.mapPos(parent.templateEnd, 1) }));
      }
      for (const transaction of update.transactions) {
        if (transaction.isUserEvent('input.complete')) { this.htmlActivation = null; this.slashFrom = null; this.clear(); return; }
        if (transaction.isUserEvent('input.type')) this.htmlActivation ??= 'typing';
        if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.reconfigured) this.htmlActivation = null;
        if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.reconfigured) { this.slashFrom = null; this.resetFields(); }
        if (transaction.reconfigured && this.context?.type === 'math') { this.dismissed = true; this.clear(); return; }
        if (transaction.isUserEvent('input.type')) transaction.changes.iterChanges((_from, _to, from, to, inserted) => {
          if (this.slashFrom === null && inserted.toString() === '/' && to === update.state.selection.main.head) { this.slashFrom = from; this.selectedCommand = ''; this.resolvedQuery = ''; this.above = null; }
        });
      }
      if (update.selectionSet && !update.docChanged && !this.composing) this.slashFrom = null;
      if (update.selectionSet && !update.docChanged && !this.composing) this.htmlActivation = null;
      if (!this.fieldInput && this.fields.length && update.selectionSet) {
        const selection = update.state.selection.main, field = this.fields[this.fieldIndex];
        if (!field || selection.from < field.from || selection.to > field.to || update.state.selection.ranges.length !== 1) this.resetFields();
      }
      if (update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some(transaction => transaction.reconfigured || transaction.effects.some(effect => effect.is(refreshInputSuggestions)))) this.schedule();
      else if (update.geometryChanged || update.viewportChanged) this.reposition();
    }
    getContext() {
      if (this.disposed || this.dismissed) return null;
      const selection = this.view.state.selection;
      const active = this.view.dom.ownerDocument.activeElement;
      if (active instanceof HTMLTextAreaElement && active.closest('.meo-md-html-table-wrap') && this.view.dom.contains(active)) {
        const preferences = this.view.state.facet(inputAssistanceFacet);
        if (this.view.state.readOnly || active.selectionStart !== active.selectionEnd && !this.composing) return null;
        this.cellInput = active;
        const head = this.composing ? active.selectionEnd : active.selectionStart, beforeHead = active.value.slice(0, head);
        let node = parser.parse(active.value).resolveInner(head, -1), excluded = false;
        for (;;) {
          if (/^(?:InlineCode|FencedCode|CodeBlock|HTMLBlock|HTMLTag|CommentBlock|ProcessingInstruction|Autolink|LinkTitle)$/.test(node.name)) excluded = true;
          if (!node.parent) break; node = node.parent;
        }
        if (excluded || /\$[^$]*$/.test(beforeHead)) { this.cellFrom = null; return null; }
        const suggestion = detectSuggestionContext(beforeHead, preferences, this.composing);
        if (suggestion) { this.cellFrom = null; return suggestion; }
        if (isSuggestionAddress(beforeHead) || this.cellFrom === null) { this.cellFrom = null; return null; }
        const from = this.cellFrom, value = active.value.slice(from, this.composing ? active.selectionEnd : active.selectionStart), query = readSlashQuery(value), before = active.value.slice(0, from);
        if (this.view.state.facet(inputAssistanceFacet).slash && (this.composing || active.selectionStart === active.selectionEnd) && query !== null && before.slice(-1) !== '/' &&
            !/\]\([^)]*$|<[^>]*$|(?:[a-z][a-z0-9+.-]*:\/+|www\.)[^\s]*$|\$[^$]*$/.test(before))
          return { type: 'slash', query, target: '', length: value.length, wiki: false } as SuggestionContext;
        this.cellFrom = null; this.cellInput = null; return null;
      }
      this.cellInput = null;
      if (this.disposed || this.view.state.readOnly || !selection.main.empty && !this.composing || selection.ranges.length !== 1 || !this.view.hasFocus || active !== this.view.contentDOM) {
        this.slashFrom = null; return null;
      }
      const range = selection.main, line = this.view.state.doc.lineAt(this.composing ? range.to : range.head), preferences = this.view.state.facet(inputAssistanceFacet);
      const position = this.composing ? range.to : range.head;
      if (preferences.html && this.htmlActivation && (this.composing || this.view.compositionStarted) && this.context?.type === 'html') return this.context;
      const htmlActive = htmlLanguage.isActiveAt(this.view.state, position, -1);
      const unfinishedHtml = !htmlActive && preferences.html && this.htmlActivation && !this.composing && !this.view.compositionStarted
        ? incompleteHtmlCompletion(this.view.state, position, this.htmlActivation === 'explicit', options.inputContext) : null;
      if (htmlActive || unfinishedHtml) {
        this.slashFrom = null;
        if (!preferences.html || !this.htmlActivation) return null;
        // Composition updates retain the last query; preedit text never changes candidates or accepts an item.
        if (this.composing || this.view.compositionStarted) return this.context?.type === 'html' ? this.context : null;
        const result = unfinishedHtml ?? htmlCompletionSource(new CompletionContext(this.view.state, position, this.htmlActivation === 'explicit'));
        return result ? { type: 'html' as const, from: result.from, to: result.to ?? position,
          query: this.view.state.sliceDoc(result.from, position), options: result.options } : null;
      }
      if (preferences.math) {
        const position = this.composing ? range.to : range.head;
        const math = detectMathCompletion(this.view.state, position, () => options.mathContext(this.view.state, position));
        if (math && !sourceTableAt(this.view.state, range.head)) { this.slashFrom = null; return math; }
      }
      if (this.slashFrom !== null) {
        const from = this.slashFrom;
        const head = this.composing ? range.to : range.head;
        const value = from >= line.from && from < head ? this.view.state.sliceDoc(from, head) : '';
        const query = readSlashQuery(value);
        if (preferences.slash && query !== null && this.view.state.sliceDoc(from - (from > 0 ? 1 : 0), from) !== '/' && options.inputContext(this.view.state, from + 1) !== 'excluded')
          return { type: 'slash', query, target: '', length: value.length, wiki: false } as SuggestionContext;
        this.slashFrom = null;
      }
      if (isCodeInput(this.view)) return null;
      const context = detectSuggestionContext(this.view.state.sliceDoc(line.from, this.composing ? range.to : range.head), preferences, this.composing || this.view.compositionStarted);
      return context?.type === 'slash' ? null : context;
    }
    schedule() {
      if (this.items[this.index]?.slash) this.selectedCommand = this.items[this.index].slash!.id;
      if (this.items[this.index]) this.selectedCandidate = this.candidateKey(this.items[this.index]);
      const context = this.getContext();
      if (context && context.type === this.context?.type && !this.popup.hidden) {
        if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
        const generation = ++this.generation;
        // Keep the surface visible while filtering; layout reads wait until the editor update ends.
        queueMicrotask(() => { if (!this.disposed && generation === this.generation) void this.resolve(context, generation); });
        return;
      }
      this.clear(); if (!context) return;
      const generation = this.generation;
      this.timer = setTimeout(() => { this.timer = null; void this.resolve(context, generation); }, context.type === 'documents' || context.type === 'paths' || context.type === 'headings' ? 160 : 40);
    }
    clear() {
      this.generation++; if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
      if (this.positionFrame !== null) this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.positionFrame);
      this.positionFrame = null;
      if (this.tooltipFrame !== null) this.view.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.tooltipFrame);
      this.tooltipFrame = null; this.selectedTooltip?.dispose(); this.selectedTooltip = null;
      this.popup.hidden = true; this.items = []; this.context = null;
      this.ariaInput?.removeAttribute('aria-controls'); this.ariaInput?.removeAttribute('aria-activedescendant'); this.ariaInput = null;
    }
    async resolve(context: InputSuggestionContext, generation: number) {
      const language = this.view.state.facet(uiLanguageFacet);
      let items: readonly Suggestion[];
      if (context.type === 'math') items = mathCompletionSuggestions(context).map(math => ({ label: math.label, insert: math.insert, detail: language === 'zh-CN' ? math.zh : math.en, math }));
      else if (context.type === 'html') items = context.options
        .flatMap(option => {
          const match = candidateTextMatch(option.label, context.query);
          return match && (option.apply === undefined || typeof option.apply === 'string')
            ? [{ option, rank: match.rank - (option.boost ?? 0) }] : [];
        }).sort((a, b) => a.rank - b.rank || a.option.label.localeCompare(b.option.label))
        .slice(0, 100).map(({ option }) => ({ label: option.label, insert: typeof option.apply === 'string' ? option.apply : option.label, detail: '' }));
      else if (context.type === 'emoji') items = emojiSuggestions.filter(item => item.name.startsWith(context.query.toLowerCase())).map(item => ({ label: ':' + item.name + ':', insert: item.value, detail: item.value }));
      else if (context.type === 'slash') {
        const scope = this.cellFrom !== null ? 'inline' : options.inputContext(this.view.state, this.slashFrom! + 1);
        items = scope === 'excluded' ? [] : slashCommandSuggestions(context.query, scope).map(slash => ({ label: slash.label, insert: slash.insert, detail: language === 'zh-CN' ? slash.zh : slash.en, caret: slash.caret, slash }));
      } else if (context.type === 'headings' && !context.target) items = options.currentHeadings().filter(item => candidateMatchPositions(item.label, context.query).length || !context.query).slice(0, 50)
        .map(item => context.wiki ? { ...item, insert: item.anchor ?? item.insert } : item);
      else {
        try { items = await options.requestLinks?.({ kind: context.type, query: context.query, target: context.target, wiki: context.wiki }) ?? []; }
        catch { items = []; }
      }
      if (this.disposed || generation !== this.generation || JSON.stringify(context) !== JSON.stringify(this.getContext())) return;
      if (!items.length) { this.clear(); return; }
      const unchanged = !this.popup.hidden && this.ariaInput === (this.cellInput ?? this.view.contentDOM) &&
        JSON.stringify(context) === JSON.stringify(this.context) && JSON.stringify(items) === JSON.stringify(this.items);
      if (this.context?.type !== context.type) this.above = null;
      this.context = context; this.items = items; const exact = context.type === 'slash' ? items.findIndex(item => [item.slash!.id.toLowerCase(), ...item.slash!.aliases].includes(context.query.toLowerCase())) : -1;
      if (!unchanged) this.index = context.query !== this.resolvedQuery && exact >= 0 ? exact : Math.max(0, items.findIndex(item => item.slash ? item.slash.id === this.selectedCommand : context.query === this.resolvedQuery && this.candidateKey(item) === this.selectedCandidate));
      this.resolvedQuery = context.query;
      this.head = this.cellInput ? this.composing ? this.cellInput.selectionEnd : this.cellInput.selectionStart : this.composing ? this.view.state.selection.main.to : this.view.state.selection.main.head;
      if (unchanged) {
        // Automatic cell commits must not replace a candidate pressed by the pointer.
        this.popup.querySelectorAll<HTMLElement>('[role="option"]').forEach(row => row.setAttribute('aria-disabled', String(!!this.items[Number(row.dataset.suggestionIndex)]?.slash?.disabled || this.composing || this.view.compositionStarted)));
        this.reposition();
      } else this.render();
    }
    render() {
      this.popup.replaceChildren();
      this.popup.lang = this.view.state.facet(uiLanguageFacet);
      this.popup.dataset.suggestionKind = this.context?.type;
      this.popup.dataset.htmlKind = this.context?.type === 'html' ? this.context.options[0]?.type ?? 'type' : '';
      const slash = this.context?.type === 'slash', documents = this.context?.type === 'documents', paths = this.context?.type === 'paths';
      this.popup.classList.toggle('meo-slash-suggestions', slash || this.context?.type === 'math');
      this.popup.classList.toggle('meo-math-suggestions', this.context?.type === 'math');
      this.popup.classList.toggle('meo-link-suggestions', documents);
      this.popup.classList.toggle('meo-path-suggestions', paths);
      this.popup.classList.toggle('meo-html-suggestions', this.context?.type === 'html');
      this.popup.classList.toggle('meo-narrow-suggestions', this.context?.type === 'emoji');
      this.popup.style.removeProperty('--meo-suggestion-max-height'); this.popup.style.removeProperty('max-width');
      const list = document.createElement('div'); list.className = 'meo-suggestion-list';
      if (slash || this.context?.type === 'math') list.classList.add('meo-slash-list');
      this.popup.append(list);
      const font = getComputedStyle(this.view.contentDOM);
      this.popup.style.setProperty('--meo-suggestion-font', font.fontFamily);
      this.popup.style.setProperty('--meo-suggestion-font-size', font.fontSize);
      const appendMatched = (element: HTMLElement, value: string, query: string) => {
        const positions = new Set(candidateMatchPositions(value, query));
        let start = 0;
        while (start < value.length) {
          const matched = positions.has(start); let end = start + 1;
          while (end < value.length && positions.has(end) === matched) end++;
          if (matched) { const span = document.createElement('span'); span.className = 'meo-suggestion-match'; span.textContent = value.slice(start, end); element.append(span); }
          else element.append(value.slice(start, end));
          start = end;
        }
      };
      this.items.forEach((item, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'meo-input-suggestion'; row.setAttribute('role', 'option');
        row.id = this.popup.id + '-' + index; row.setAttribute('aria-selected', String(index === this.index)); row.tabIndex = -1; row.setAttribute('aria-disabled', String(!!item.slash?.disabled || this.composing || this.view.compositionStarted));
        row.dataset.suggestionIndex = String(index);
        const marker = document.createElement('span'); marker.className = 'meo-suggestion-marker'; marker.setAttribute('aria-hidden', 'true');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 20 16');
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path'); chevron.setAttribute('d', 'M3 3L8 8L3 13M10 3L15 8L10 13');
        icon.append(chevron); marker.append(icon); row.append(marker);
        const label = document.createElement('span'); label.className = 'meo-suggestion-label';
        if (item.math) {
          row.dataset.mathCommand = item.math.label;
          row.classList.add('meo-slash-suggestion'); label.classList.add('meo-suggestion-command');
          appendMatched(label, item.label, this.context?.type === 'math' && this.context.environment ? this.context.query : '\\' + (this.context?.query ?? ''));
          const added = document.createElement('span'); added.className = 'meo-math-completion-added';
          added.textContent = item.math.insert.slice(item.math.label.length).replace(/\s*\n\s*/g, ' ');
          label.append(added); label.dataset.tooltip = item.math.insert; label.dataset.tooltipKind = 'fulltext';
          row.setAttribute('aria-label', item.math.insert + ' · ' + item.detail);
        } else if (item.slash) {
          row.dataset.command = item.slash.id; row.classList.add('meo-slash-suggestion');
          label.classList.add('meo-suggestion-command');
          const prefix = document.createElement('span'); prefix.className = 'meo-suggestion-slash'; prefix.textContent = '/';
          label.append(prefix);
          const query = (this.context?.type === 'slash' ? this.context.query : '').toLowerCase().replace(/×/g, 'x');
          const exactAlias = item.slash.aliases.includes(query) || item.slash.id.startsWith('code-') || item.slash.label.toLowerCase().replace(/[^a-z0-9]/g, '') === query;
          const command = query && exactAlias && !item.slash.command.includes(query) ? query : item.slash.command;
          appendMatched(label, command, query);
          if (item.slash.parameters) {
            const dimensions = document.createElement('span'); dimensions.className = 'meo-suggestion-parameters'; dimensions.textContent = item.slash.parameters; label.append(dimensions);
          }
        } else if (this.context?.type === 'emoji') {
          const prefix = document.createElement('span'); prefix.className = 'meo-suggestion-trigger'; prefix.textContent = ':'; label.append(prefix);
          appendMatched(label, item.label.slice(1), this.context.query);
        } else {
          const query = this.context?.query ?? '';
          appendMatched(label, item.label, this.context?.type === 'paths' ? query.slice(Math.max(query.lastIndexOf('/'), query.lastIndexOf('\\')) + 1) : query);
          label.dataset.tooltip = item.label; label.dataset.tooltipKind = 'fulltext';
        }
        row.append(label);
        const detailValue = this.context?.type === 'headings' && item.anchor ? '#' + item.anchor : documents ? item.detail || item.insert : item.detail;
        if (item.math) {
          const preview = document.createElement('span'); preview.className = 'meo-math-completion-preview'; preview.setAttribute('aria-hidden', 'true');
          const html = options.renderMathPreview(item.math.preview);
          if (html) preview.innerHTML = html;
          else preview.textContent = item.math.label;
          row.append(preview);
        } else if (!paths && (documents || detailValue)) {
          const detail = document.createElement('span'); detail.className = 'meo-input-suggestion-detail';
          if (item.slash || this.context?.type === 'html') detail.textContent = detailValue;
          else { appendMatched(detail, detailValue, this.context?.query ?? ''); detail.dataset.tooltip = [item.detail, detailValue].filter((value, index, values) => value && values.indexOf(value) === index).join(' · '); detail.dataset.tooltipKind = 'fulltext'; }
          row.append(detail);
        }
        row.addEventListener('click', () => this.choose(index));
        row.addEventListener('pointermove', () => {
          if (this.index === index) return;
          this.select(index, false);
        });
        if (this.reverseOrder) list.prepend(row); else list.append(row);
      });
      this.popup.hidden = false; this.ariaInput = this.cellInput ?? this.view.contentDOM;
      this.ariaInput.setAttribute('aria-controls', this.popup.id); this.ariaInput.setAttribute('aria-activedescendant', this.popup.id + '-' + this.index);
      this.position();
      if (!this.popup.hidden) { this.scrollSelection(); this.position(); }
    }
    select(index: number, scroll: boolean) {
      this.index = index;
      if (this.items[index]?.slash) this.selectedCommand = this.items[index].slash!.id;
      if (this.items[index]) this.selectedCandidate = this.candidateKey(this.items[index]);
      this.popup.querySelectorAll<HTMLElement>('[role="option"]').forEach(row => row.setAttribute('aria-selected', String(Number(row.dataset.suggestionIndex) === index)));
      this.ariaInput?.setAttribute('aria-activedescendant', this.popup.id + '-' + index);
      if (scroll) this.scrollSelection();
      this.position();
    }
    updateSelectedTooltip() {
      if (this.tooltipFrame !== null) return;
      const window = this.view.dom.ownerDocument.defaultView!;
      this.tooltipFrame = window.requestAnimationFrame(() => {
        this.tooltipFrame = null;
        if (this.disposed || this.popup.hidden) return;
        const row = this.popup.querySelector<HTMLElement>('[aria-selected="true"]');
        const fields = row ? [...row.querySelectorAll<HTMLElement>('.meo-suggestion-label, .meo-input-suggestion-detail')]
          .filter(field => field.scrollWidth > field.clientWidth + 1 || field.scrollHeight > field.clientHeight + 1) : [];
        const text = fields.map(field => (this.context?.type === 'math' ? field.dataset.tooltip : undefined) ?? field.textContent?.trim() ?? '').filter(Boolean).join('\n');
        if (!row || !text) { this.selectedTooltip?.dispose(); this.selectedTooltip = null; return; }
        if (!this.selectedTooltip) this.selectedTooltip = createTooltip(row, { content: { text, kind: 'fulltext' }, immediate: true, manual: true });
        else { this.selectedTooltip.setAnchor(row); this.selectedTooltip.setContent({ text, kind: 'fulltext' }); }
        this.selectedTooltip.show();
      });
    }
    scrollSelection() {
      const list = this.popup.querySelector<HTMLElement>('.meo-suggestion-list')!;
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      // Scroll only enough to reveal a candidate; keep both the list and document stable otherwise.
      const row = selected.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    }
    fitMathPreviews() {
      if (this.context?.type !== 'math') return;
      for (const preview of this.popup.querySelectorAll<HTMLElement>('.meo-math-completion-preview')) {
        const formula = preview.firstElementChild as HTMLElement | null;
        if (!formula?.offsetWidth || !formula.offsetHeight) continue;
        // Transform only the example: formula geometry must never resize a row.
        const scale = Math.min(1, Math.max(0, preview.clientWidth - 2) / formula.offsetWidth, Math.max(0, preview.clientHeight - 1) / formula.offsetHeight);
        preview.style.setProperty('--meo-math-preview-scale', String(scale));
      }
    }
    position() {
      const slash = this.context?.type === 'slash', document = this.view.dom.ownerDocument;
      const close = () => {
        this.dismissed = true;
        if (slash) { this.slashFrom = null; this.cellFrom = null; this.cellInput = null; }
        this.clear();
      };
      const native = this.cellInput ? options.cellCoords?.(this.cellInput, slash ? this.cellFrom! : this.head) : null;
      const coords = native ? {
        left: native.left - this.cellInput!.scrollLeft,
        right: native.left - this.cellInput!.scrollLeft + this.view.defaultCharacterWidth,
        top: native.top - this.cellInput!.scrollTop,
        bottom: native.top - this.cellInput!.scrollTop + (parseFloat(getComputedStyle(this.cellInput!).lineHeight) || this.view.defaultLineHeight)
      } : this.view.coordsAtPos(slash ? this.slashFrom! : this.context?.type === 'math' ? this.context.from : this.head);
      if (!coords) { close(); return; }
      const viewport = document.documentElement;
      const scroller = this.view.scrollDOM, scroll = scroller.getBoundingClientRect();
      const toolbar = document.querySelector('.mode-toolbar')?.getBoundingClientRect();
      const top = Math.max(8, scroll.top + scroller.clientTop, toolbar?.bottom ?? 0);
      const bottom = Math.min(viewport.clientHeight - 8, scroll.top + scroller.clientTop + scroller.clientHeight);
      let left = Math.max(8, scroll.left + scroller.clientLeft + 8);
      let right = Math.min(viewport.clientWidth - 8, scroll.left + scroller.clientLeft + scroller.clientWidth - 8);
      const outline = this.view.dom.closest('.editor-wrapper')?.querySelector<HTMLElement>('.outline-sidebar');
      if (outline && !outline.hidden) {
        const bounds = outline.getBoundingClientRect();
        if (bounds.bottom > top && bounds.top < bottom) {
          if (outline.closest<HTMLElement>('[data-outline-position]')?.dataset.outlinePosition === 'left') left = Math.max(left, bounds.right + 8);
          else right = Math.min(right, bounds.left - 8);
        }
      }
      let visibleTop = top, visibleBottom = bottom, visibleLeft = left - 8, visibleRight = right + 8;
      // A cell can be clipped by its own scroll or by a horizontally scrolling table.
      // The menu still uses the editor viewport, so it can extend beyond the small cell.
      for (let node: HTMLElement | null = this.cellInput; node && node !== scroller; node = node.parentElement) {
        const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
        if (node === this.cellInput || /auto|scroll|hidden|clip/.test(style.overflowY)) {
          visibleTop = Math.max(visibleTop, bounds.top + node.clientTop);
          visibleBottom = Math.min(visibleBottom, bounds.top + node.clientTop + node.clientHeight);
        }
        if (node === this.cellInput || /auto|scroll|hidden|clip/.test(style.overflowX)) {
          visibleLeft = Math.max(visibleLeft, bounds.left + node.clientLeft);
          visibleRight = Math.min(visibleRight, bounds.left + node.clientLeft + node.clientWidth);
        }
      }
      if (coords.bottom <= visibleTop || coords.top >= visibleBottom || coords.left >= visibleRight ||
          Math.max(coords.right, coords.left + this.view.defaultCharacterWidth) <= visibleLeft || right <= left) { close(); return; }
      this.popup.style.maxWidth = (right - left) + 'px';
      this.fitMathPreviews();
      const list = this.popup.querySelector<HTMLElement>('.meo-suggestion-list')!, previous = list.getBoundingClientRect();
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]'), selectedBefore = selected?.getBoundingClientRect();
      const selectedVisible = selectedBefore && selectedBefore.top >= previous.top - 1 && selectedBefore.bottom <= previous.bottom + 1;
      const first = list.firstElementChild!.getBoundingClientRect(), last = list.lastElementChild!.getBoundingClientRect();
      const chrome = this.popup.getBoundingClientRect().height - previous.height;
      // Measure content without enlarging the list: a temporary resize clamps its scroll position.
      const minimumRows = Math.min(6, this.items.length);
      const preferredHeight = parseFloat(getComputedStyle(this.popup).getPropertyValue('--meo-suggestion-preferred-height'));
      const preferred = Math.min(Math.max(preferredHeight, minimumRows * first.height + chrome), last.bottom - first.top + chrome);
      const below = Math.max(0, bottom - coords.bottom - 4), above = Math.max(0, coords.top - top - 4);
      const aboveRows = Math.max(0, Math.floor((above - chrome + 0.001) / first.height));
      const belowRows = Math.max(0, Math.floor((below - chrome + 0.001) / first.height));
      if (this.above === null) this.above = this.reverseOrder;
      // Stay on this side while it meets the target; equal row capacities must not cause a flip.
      const currentRows = this.above ? aboveRows : belowRows, otherRows = this.above ? belowRows : aboveRows;
      if (currentRows < minimumRows && otherRows > currentRows) this.above = !this.above;
      const available = this.above ? above : below;
      const rows = Math.floor((Math.min(preferred, available) - chrome + 0.001) / first.height);
      if (rows < 1) { close(); return; }
      // Keep the edge between rows, including fractional heights from editor fonts and zoom.
      this.popup.style.setProperty('--meo-suggestion-max-height', rows * first.height + chrome + 'px');
      const bounds = this.popup.getBoundingClientRect();
      this.popup.style.left = Math.max(left, Math.min(coords.left, right - bounds.width)) + 'px';
      this.popup.style.top = (this.above ? coords.top - bounds.height - 4 : coords.bottom + 4) + 'px';
      // Shrinking the viewport must not hide a command that was already visible.
      if (selectedVisible && list.getBoundingClientRect().height < previous.height) this.scrollSelection();
      if (selected) {
        // Paint a single selection background across the list and its reserved scrollbar gutter.
        const row = selected.getBoundingClientRect(), offset = row.top - bounds.top - this.popup.clientTop;
        this.popup.style.setProperty('--meo-suggestion-selected-top', offset + 'px');
        this.popup.style.setProperty('--meo-suggestion-selected-bottom', offset + row.height + 'px');
      }
      this.updateSelectedTooltip();
    }
    choose(index: number) {
      if (this.composing || this.view.compositionStarted) return;
      const context = this.context, item = this.items[index];
      if (item?.slash?.disabled) return;
      if (!context || !item || this.head !== (this.cellInput ? this.cellInput.selectionStart : this.view.state.selection.main.head) || JSON.stringify(context) !== JSON.stringify(this.getContext())) { this.clear(); return; }
      if (context.type === 'html') {
        this.clear(); this.htmlActivation = null; this.dismissed = true;
        this.view.dispatch({ changes: { from: context.from, to: context.to, insert: item.insert },
          selection: EditorSelection.cursor(context.from + item.insert.length),
          annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] });
        this.view.focus(); return;
      }
      if (context.type === 'math' && item.math) {
        const plan = planMathCompletion(this.view.state, context, item.math);
        const active = this.fields[this.fieldIndex];
        const nested = !this.fieldInput && active && plan.from >= active.from && plan.to <= active.to;
        if (!nested) this.resetFields();
        this.clear(); this.slashFrom = null; this.dismissed = true;
        this.view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert },
          selection: EditorSelection.cursor(plan.fields[0]?.from ?? plan.end),
          effects: plan.pairs.map(pair => addAutomaticSymbolPair.of(pair)),
          annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] });
        if (plan.fields.length) {
          if (nested) this.parents.push({ fields: this.fields, fieldIndex: this.fieldIndex, templateEnd: this.templateEnd });
          this.fieldInput = null; this.fields = plan.fields; this.fieldIndex = 0; this.templateEnd = plan.end;
        }
        this.view.focus(); return;
      }
      if (this.cellInput && this.cellFrom !== null && item.slash) {
        const input = this.cellInput, from = this.cellFrom, command = item.slash;
        const insert = command.id === 'lineBreak' ? '<br>\n' : command.insert;
        const caret = from + (command.id === 'lineBreak' ? insert.length : command.caret);
        const value = input.value.slice(0, from) + insert + input.value.slice(this.head);
        this.cellFrom = null; this.cellInput = null; this.clear(); this.fields = [];
        if (!options.replaceCell?.(input, value, caret)) return;
        if (command.id === 'comment') nativeSymbolInput(input)?.beginComment(caret, caret);
        if (command.fields) {
          this.fieldInput = input; this.fieldValue = value; this.fieldIndex = 0; this.templateEnd = from + insert.length;
          this.fields = command.fields.map(([start, end]) => ({ from: from + start, to: from + end }));
          input.setSelectionRange(this.fields[0].from, this.fields[0].to);
        }
        return;
      }
      const tableBreak = item.slash?.id === 'lineBreak' && !!sourceTableAt(this.view.state, this.head);
      let insert = tableBreak ? '<br>' : item.insert;
      if (context.type === 'paths' && !context.wiki) insert = encodeMarkdownPath(insert);
      if (context.type === 'headings' && !context.wiki) insert = item.anchor ?? insert;
      const from = this.head - context.length;
      const alias = context.type === 'documents' ? insert.indexOf('|') : -1;
      const caret = from + (tableBreak ? insert.length : item.caret ?? (alias < 0 ? insert.length : alias));
      if (context.wiki && (this.cellInput || sourceTableAt(this.view.state, this.head))) insert = insert.replaceAll('|', '\\|');
      let to = this.head;
      const text = this.cellInput?.value ?? this.view.state.doc.toString();
      if (context.type !== 'slash' && context.type !== 'emoji') {
        const stop = context.wiki ? /[\r\n\]|#]/ : context.type === 'paths' ? /[\/\\)#?<>\s]/ : /[)#?<>\s]/;
        while (to < text.length && !stop.test(text[to]) && !(context.wiki && text[to] === '\\' && text[to + 1] === '|')) to++;
      }
      if (this.cellInput) {
        // Cell drafts retain Markdown escapes; an alias separator must not create a new column.
        const nativeInsert = insert;
        const input = this.cellInput, value = input.value.slice(0, from) + nativeInsert + input.value.slice(to);
        const delta = nativeInsert.length - (to - from), map = (position: number, right: boolean) => position < from ? position : position > to ? position + delta : right ? from + nativeInsert.length : from;
        this.fields = this.fields.map(field => ({ from: map(field.from, false), to: map(field.to, true) })); this.templateEnd = map(this.templateEnd, true);
        this.clear(); this.cellFrom = null; this.dismissed = item.kind !== 'directory';
        if (options.replaceCell?.(input, value, caret)) {
          const active = this.view.dom.ownerDocument.activeElement;
          if (active instanceof HTMLTextAreaElement) { this.cellInput = active; if (this.fields.length) { this.fieldInput = active; this.fieldValue = value; } }
          if (item.kind === 'directory') this.schedule();
          else { this.dismissed = true; this.clear(); }
        }
        return;
      }
      const command = item.slash;
      let fields = command?.fields?.map(([start, end]) => ({ from: from + start, to: from + end }));
      let templateEnd = from + insert.length;
      let transaction: TransactionSpec = { changes: { from, to, insert }, selection: EditorSelection.cursor(caret) };
      if (item.slash?.scope === 'block') {
        const plan = blockInsertion(this.view.state, from, this.head, insert, item.caret!, options.inputContext(this.view.state, from));
        if (!plan) { this.slashFrom = null; this.clear(); return; }
        transaction = plan.transaction;
        fields = command?.fields?.map(([start, end]) => ({ from: plan.positionAt(start), to: plan.positionAt(end) }));
        templateEnd = plan.positionAt(insert.length);
      }
      this.slashFrom = null; this.clear();
      this.dismissed = item.kind !== 'directory';
      this.view.dispatch({ ...transaction, effects: command?.id === 'comment' ? [beginHtmlCommentTemplate.of({ from: caret, to: caret, end: templateEnd }), addAutomaticSymbolPair.of({ from, to: templateEnd, open: '<!--', close: '-->' })] : transaction.effects, annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] });
      if (fields) {
        this.fieldInput = null;
        this.fields = fields; this.fieldIndex = 0; this.templateEnd = templateEnd;
        const field = this.fields[0]; this.view.dispatch({ selection: EditorSelection.range(field.from, field.to) });
      }
      this.view.focus();
      if (item.kind === 'directory') this.schedule();
      if (command?.id === 'blockMath') options.focusMath?.();
      if (command?.id === 'table') options.focusTable?.();
    }
    keydown(event: KeyboardEvent) {
      if (event.isComposing || this.composing || this.view.compositionStarted || event.keyCode === 229) return false;
      if (this.view.state.readOnly) { this.resetFields(); this.clear(); return false; }
      const manualHtml = !event.shiftKey && !event.metaKey && (event.ctrlKey && !event.altKey && event.code === 'Space'
        || !event.ctrlKey && event.altKey && /Mac/.test(navigator.platform) && ['Backquote', 'KeyI'].includes(event.code));
      if (manualHtml && !this.cellInput && this.view.state.facet(inputAssistanceFacet).html
        && (htmlLanguage.isActiveAt(this.view.state, this.view.state.selection.main.head, -1)
          || incompleteHtmlCompletion(this.view.state, this.view.state.selection.main.head, true, options.inputContext))) {
        event.preventDefault(); this.dismissed = false; this.htmlActivation = 'explicit'; this.schedule(); return true;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'Tab' && this.fields.length && this.popup.hidden) {
        event.preventDefault();
        const index = this.fieldIndex + (event.shiftKey ? -1 : 1), field = this.fields[index];
        if (field) {
          this.fieldIndex = index;
          if (this.fieldInput) this.fieldInput.setSelectionRange(field.from, field.to);
          else this.view.dispatch({ selection: EditorSelection.range(field.from, field.to) });
        } else if (event.shiftKey) {
          // At the first field, stay in place instead of unexpectedly exiting.
          return true;
        } else {
          let end = this.templateEnd;
          while (this.parents.length) {
            const parent = this.parents.pop()!;
            this.fields = parent.fields; this.fieldIndex = parent.fieldIndex + 1; this.templateEnd = parent.templateEnd;
            const next = this.fields[this.fieldIndex];
            if (next) { this.view.dispatch({ selection: EditorSelection.range(next.from, next.to) }); return true; }
            end = parent.templateEnd;
          }
          this.resetFields();
          if (this.fieldInput) this.fieldInput.setSelectionRange(end, end);
          else this.view.dispatch({ selection: EditorSelection.cursor(end) });
        }
        return true;
      }
      if (event.key === 'Escape' && (this.slashFrom !== null || this.cellFrom !== null || !this.popup.hidden || this.fields.length)) { event.preventDefault(); this.dismissed = true; this.htmlActivation = null; this.slashFrom = null; this.cellFrom = null; this.cellInput = null; this.resetFields(); this.clear(); return true; }
      if (this.popup.hidden) return false;
      if (event.key === 'Escape') { event.preventDefault(); this.dismissed = true; this.slashFrom = null; this.cellFrom = null; this.cellInput = null; this.fields = []; this.clear(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        this.select((this.index + (this.reverseOrder ? -direction : direction) + this.items.length) % this.items.length, true);
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        if (this.items[this.index]?.slash?.disabled) return false;
        event.preventDefault(); this.choose(this.index); return true;
      }
      return false;
    }
    destroy() {
      this.disposed = true; this.clear(); this.popup.remove();
      for (const type of ['input', 'keydown', 'select', 'pointerup', 'compositionstart', 'compositionend', 'focusout']) this.view.dom.removeEventListener(type, this.nativeEvent, type === 'keydown' || type.startsWith('composition'));
      this.view.dom.ownerDocument.removeEventListener('scroll', this.reposition, true);
      this.view.dom.ownerDocument.defaultView?.removeEventListener('resize', this.reposition);
      this.view.dom.ownerDocument.defaultView?.removeEventListener('blur', this.windowBlur);
      this.view.dom.ownerDocument.fonts.removeEventListener('loadingdone', this.reposition);
    }
  }, { eventHandlers: {
    keydown(event) { return this.keydown(event); },
    blur() { this.dismissed = true; this.htmlActivation = null; this.slashFrom = null; this.resetFields(); this.clear(); return false; },
    compositionstart() { this.composing = true; return false; },
    compositionend(event) {
      this.composing = false;
      const head = this.view.state.selection.main.head;
      // IME confirmation can move the caret without inserting the slash again.
      if (this.slashFrom === null && event.data === '/' && this.view.state.selection.main.empty && head > 0 && this.view.state.sliceDoc(head - 1, head) === '/') {
        this.slashFrom = head - 1; this.selectedCommand = ''; this.resolvedQuery = ''; this.above = null;
      }
      this.schedule(); return false;
    }
  } });
  return plugin;
}
