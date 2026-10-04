import { createRequestPrefix } from '../adapters/requestIdentity';
import { EditorSelection, Transaction, type Extension, type TransactionSpec, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { parser } from '@lezer/markdown';
import { isolateHistory } from '@codemirror/commands';
import type { LinkCandidate } from '../../../src/protocol/editorServices';
import { detectSuggestionContext, emojiSuggestions, type SuggestionContext } from '../application/inputSuggestions';
import { inputAssistanceFacet } from './typingAssistance';
import { isCodeInput } from './pasteAssistance';
import { uiLanguageFacet } from './uiLanguage';
import { readSlashQuery, slashCommandSuggestions, type SlashCommand } from '../application/slashCommands';
import { sourceTableAt } from './sourceTableCommands';
import { blockInsertion, type MarkdownInputContext } from './blockInsertion';

type Suggestion = LinkCandidate & { readonly caret?: number; readonly slash?: SlashCommand };
export function createInputSuggestions(options: {
  readonly inputContext: (state: EditorState, position: number) => MarkdownInputContext;
  readonly requestLinks?: (context: { kind: 'documents' | 'paths' | 'headings'; query: string; target: string }) => Promise<readonly LinkCandidate[]>;
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
    cellFrom: number | null = null; cellInput: HTMLTextAreaElement | null = null;
    fieldInput: HTMLTextAreaElement | null = null; fieldValue = '';
    selectedCommand = ''; resolvedQuery = '';
    positionFrame: number | null = null; above: boolean | null = null;
    readonly nativeEvent = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLTextAreaElement) || !input.closest('.meo-md-html-table-wrap') || !this.view.dom.contains(input)) return;
      if (event.type === 'keydown') {
        if (this.keydown(event as KeyboardEvent)) event.stopImmediatePropagation();
        return;
      }
      if (event.type === 'compositionstart') { this.composing = true; if (this.context?.type !== 'slash') this.clear(); return; }
      if (event.type === 'compositionend') this.composing = false;
      if (event.type === 'focusout') {
        queueMicrotask(() => { if (input !== this.view.dom.ownerDocument.activeElement) { this.cellFrom = null; this.cellInput = null; this.fields = []; this.clear(); } }); return;
      }
      if (event.type === 'input') {
        const typed = event as InputEvent;
        if (this.cellFrom === null && typed.inputType === 'insertText' && typed.data === '/') { this.cellInput = input; this.cellFrom = input.selectionStart - 1; this.selectedCommand = ''; this.resolvedQuery = ''; this.above = null; }
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
    composing = false;
    items: readonly Suggestion[] = []; context: SuggestionContext | null = null; head = 0;
    constructor(readonly view: EditorView) {
      this.popup.className = 'meo-input-suggestions'; this.popup.hidden = true; this.popup.setAttribute('role', 'listbox');
      this.popup.id = 'meo-input-suggestions-' + createRequestPrefix();
      view.dom.ownerDocument.body.append(this.popup);
      for (const type of ['input', 'keydown', 'select', 'pointerup', 'compositionstart', 'compositionend', 'focusout']) view.dom.addEventListener(type, this.nativeEvent, type === 'keydown' || type.startsWith('composition'));
      view.dom.ownerDocument.addEventListener('scroll', this.reposition, true);
      view.dom.ownerDocument.defaultView?.addEventListener('resize', this.reposition);
      this.popup.addEventListener('pointerdown', event => event.preventDefault());
      // EditorView initializes composition/focus state after constructing plugins.
      queueMicrotask(() => { if (!this.disposed) this.schedule(); });
    }
    update(update: ViewUpdate) {
      if (this.slashFrom !== null && update.docChanged) this.slashFrom = update.changes.mapPos(this.slashFrom, -1);
      if (!this.fieldInput && this.fields.length && update.docChanged) {
        this.fields = this.fields.map(field => ({ from: update.changes.mapPos(field.from, -1), to: update.changes.mapPos(field.to, 1) }));
        this.templateEnd = update.changes.mapPos(this.templateEnd, 1);
      }
      for (const transaction of update.transactions) {
        if (transaction.isUserEvent('input.complete')) { this.slashFrom = null; this.clear(); return; }
        if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.reconfigured) { this.slashFrom = null; this.fields = []; }
        if (transaction.isUserEvent('input.type')) transaction.changes.iterChanges((_from, _to, from, to, inserted) => {
          if (this.slashFrom === null && inserted.toString() === '/' && to === update.state.selection.main.head) { this.slashFrom = from; this.selectedCommand = ''; this.resolvedQuery = ''; this.above = null; }
        });
      }
      if (update.selectionSet && !update.docChanged && !this.composing) this.slashFrom = null;
      if (!this.fieldInput && this.fields.length && update.selectionSet) {
        const selection = update.state.selection.main, field = this.fields[this.fieldIndex];
        if (!field || selection.from < field.from || selection.to > field.to) this.fields = [];
      }
      if (update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some(transaction => transaction.reconfigured)) this.schedule();
      else if (update.geometryChanged || update.viewportChanged) this.reposition();
    }
    getContext() {
      const selection = this.view.state.selection;
      const active = this.view.dom.ownerDocument.activeElement;
      if (active instanceof HTMLTextAreaElement && this.cellInput === active && this.cellFrom !== null) {
        const from = this.cellFrom, value = active.value.slice(from, this.composing ? active.selectionEnd : active.selectionStart), query = readSlashQuery(value), before = active.value.slice(0, from);
        let node = parser.parse(active.value).resolveInner(from + 1, -1), inCode = false;
        for (;;) {
          if (/^(?:InlineCode|FencedCode|CodeBlock)$/.test(node.name)) inCode = true;
          if (!node.parent) break;
          node = node.parent;
        }
        if (!inCode && !this.disposed && !this.view.state.readOnly && this.view.state.facet(inputAssistanceFacet).slash && (this.composing || active.selectionStart === active.selectionEnd) && query !== null && before.slice(-1) !== '/' &&
            !/\]\([^)]*$|<[^>]*$|(?:[a-z][a-z0-9+.-]*:\/+|www\.)[^\s]*$|\$[^$]*$/.test(before))
          return { type: 'slash', query, target: '', length: value.length, wiki: false } as SuggestionContext;
        this.cellFrom = null; this.cellInput = null; return null;
      }
      if (this.disposed || this.view.state.readOnly || !selection.main.empty && !this.composing || selection.ranges.length !== 1 || !this.view.hasFocus || active !== this.view.contentDOM) {
        this.slashFrom = null; return null;
      }
      const range = selection.main, line = this.view.state.doc.lineAt(this.composing ? range.to : range.head), preferences = this.view.state.facet(inputAssistanceFacet);
      if (this.slashFrom !== null) {
        const from = this.slashFrom;
        const head = this.composing ? range.to : range.head;
        const value = from >= line.from && from < head ? this.view.state.sliceDoc(from, head) : '';
        const query = readSlashQuery(value);
        if (preferences.slash && query !== null && this.view.state.sliceDoc(from - (from > 0 ? 1 : 0), from) !== '/' && options.inputContext(this.view.state, from + 1) !== 'excluded')
          return { type: 'slash', query, target: '', length: value.length, wiki: false } as SuggestionContext;
        this.slashFrom = null;
      }
      if (this.composing || this.view.compositionStarted || isCodeInput(this.view)) return null;
      const context = detectSuggestionContext(this.view.state.sliceDoc(line.from, range.head), preferences);
      return context?.type === 'slash' ? null : context;
    }
    schedule() {
      if (this.items[this.index]?.slash) this.selectedCommand = this.items[this.index].slash!.id;
      const context = this.getContext();
      if (context?.type === 'slash' && this.context?.type === 'slash' && !this.popup.hidden) {
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
      this.popup.hidden = true; this.items = []; this.context = null;
      this.ariaInput?.removeAttribute('aria-controls'); this.ariaInput?.removeAttribute('aria-activedescendant'); this.ariaInput = null;
    }
    async resolve(context: SuggestionContext, generation: number) {
      const language = this.view.state.facet(uiLanguageFacet);
      let items: readonly Suggestion[];
      if (context.type === 'emoji') items = emojiSuggestions.filter(item => item.name.startsWith(context.query.toLowerCase())).map(item => ({ label: ':' + item.name + ':', insert: item.value, detail: item.value }));
      else if (context.type === 'slash') {
        const scope = this.cellFrom !== null ? 'inline' : options.inputContext(this.view.state, this.slashFrom! + 1);
        items = scope === 'excluded' ? [] : slashCommandSuggestions(context.query, scope).map(slash => ({ label: slash.label, insert: slash.insert, detail: language === 'zh-CN' ? slash.zh : slash.en, caret: slash.caret, slash }));
      } else if (context.type === 'headings' && !context.target) items = options.currentHeadings().filter(item => item.label.toLocaleLowerCase().includes(context.query.toLocaleLowerCase())).slice(0, 50);
      else {
        try { items = await options.requestLinks?.({ kind: context.type, query: context.query, target: context.target }) ?? []; }
        catch { items = []; }
      }
      if (this.disposed || generation !== this.generation || JSON.stringify(context) !== JSON.stringify(this.getContext())) return;
      if (!items.length) { this.clear(); return; }
      const unchanged = context.type === 'slash' && !this.popup.hidden && this.ariaInput === (this.cellInput ?? this.view.contentDOM) &&
        JSON.stringify(context) === JSON.stringify(this.context) && JSON.stringify(items) === JSON.stringify(this.items);
      if (this.context?.type !== context.type) this.above = null;
      this.context = context; this.items = items; const exact = context.type === 'slash' ? items.findIndex(item => [item.slash!.id.toLowerCase(), ...item.slash!.aliases].includes(context.query.toLowerCase())) : -1;
      this.index = context.query !== this.resolvedQuery && exact >= 0 ? exact : Math.max(0, items.findIndex(item => item.slash?.id === this.selectedCommand));
      this.resolvedQuery = context.query;
      this.head = this.cellInput && this.cellFrom !== null ? this.cellInput.selectionStart : this.view.state.selection.main.head;
      if (unchanged) {
        // Automatic cell commits must not replace a candidate pressed by the pointer.
        this.popup.querySelectorAll('[role="option"]').forEach((row, index) => row.setAttribute('aria-disabled', String(!!this.items[index]?.slash?.disabled || this.composing || this.view.compositionStarted)));
        this.reposition();
      } else this.render();
    }
    render() {
      this.popup.replaceChildren();
      const slash = this.context?.type === 'slash';
      this.popup.classList.toggle('meo-slash-suggestions', slash);
      this.popup.style.removeProperty('--meo-suggestion-max-height'); this.popup.style.removeProperty('max-width');
      const list = document.createElement('div'); list.className = 'meo-suggestion-list';
      if (slash) list.classList.add('meo-slash-list');
      this.popup.append(list);
      const font = getComputedStyle(this.view.contentDOM);
      this.popup.style.setProperty('--meo-suggestion-font', font.fontFamily);
      this.popup.style.setProperty('--meo-suggestion-font-size', font.fontSize);
      const appendMatched = (element: HTMLElement, value: string, query: string) => {
        const match = query ? value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
        if (match < 0) { element.append(value); return; }
        const matched = document.createElement('span'); matched.className = 'meo-suggestion-match'; matched.textContent = value.slice(match, match + query.length);
        element.append(value.slice(0, match), matched, value.slice(match + query.length));
      };
      this.items.forEach((item, index) => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'meo-input-suggestion'; row.setAttribute('role', 'option');
        row.id = this.popup.id + '-' + index; row.setAttribute('aria-selected', String(index === this.index)); row.tabIndex = -1; row.setAttribute('aria-disabled', String(!!item.slash?.disabled || this.composing || this.view.compositionStarted));
        const marker = document.createElement('span'); marker.className = 'meo-suggestion-marker'; marker.setAttribute('aria-hidden', 'true');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 20 16');
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path'); chevron.setAttribute('d', 'M3 3L8 8L3 13M10 3L15 8L10 13');
        icon.append(chevron); marker.append(icon); row.append(marker);
        const label = document.createElement('span'); label.className = 'meo-suggestion-label';
        if (item.slash) {
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
          appendMatched(label, item.label, this.context?.query ?? ''); label.title = item.label;
        }
        row.append(label);
        const detailValue = this.context?.type === 'headings' && item.anchor ? '#' + item.anchor : item.detail;
        if (detailValue && (item.slash || detailValue !== item.label)) {
          const detail = document.createElement('span'); detail.className = 'meo-input-suggestion-detail';
          if (item.slash) detail.textContent = detailValue;
          else { appendMatched(detail, detailValue, this.context?.query ?? ''); detail.title = [item.detail, detailValue].filter((value, index, values) => value && values.indexOf(value) === index).join(' · '); }
          row.append(detail);
        }
        row.addEventListener('click', () => this.choose(index));
        row.addEventListener('pointermove', () => {
          if (this.index === index) return;
          this.select(index, false);
        });
        list.append(row);
      });
      this.popup.hidden = false; this.ariaInput = this.cellInput ?? this.view.contentDOM;
      this.ariaInput.setAttribute('aria-controls', this.popup.id); this.ariaInput.setAttribute('aria-activedescendant', this.popup.id + '-' + this.index);
      this.position();
      if (!this.popup.hidden) { this.scrollSelection(); this.position(); }
    }
    select(index: number, scroll: boolean) {
      this.index = index;
      if (this.items[index]?.slash) this.selectedCommand = this.items[index].slash!.id;
      this.popup.querySelectorAll('[role="option"]').forEach((row, selected) => row.setAttribute('aria-selected', String(selected === index)));
      this.ariaInput?.setAttribute('aria-activedescendant', this.popup.id + '-' + index);
      if (scroll) this.scrollSelection();
      this.position();
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
    position() {
      const slash = this.context?.type === 'slash', document = this.view.dom.ownerDocument;
      const close = () => {
        if (slash) { this.slashFrom = null; this.cellFrom = null; this.cellInput = null; }
        this.clear();
      };
      const native = this.cellInput && this.cellFrom !== null ? options.cellCoords?.(this.cellInput, this.cellFrom) : null;
      const coords = native ? {
        left: native.left - this.cellInput!.scrollLeft,
        right: native.left - this.cellInput!.scrollLeft + this.view.defaultCharacterWidth,
        top: native.top - this.cellInput!.scrollTop,
        bottom: native.top - this.cellInput!.scrollTop + (parseFloat(getComputedStyle(this.cellInput!).lineHeight) || this.view.defaultLineHeight)
      } : this.view.coordsAtPos(slash ? this.slashFrom! : this.head);
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
          if (outline.classList.contains('outline-left')) left = Math.max(left, bounds.right + 8);
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
      const list = this.popup.querySelector<HTMLElement>('.meo-suggestion-list')!, previous = list.getBoundingClientRect();
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]'), selectedBefore = selected?.getBoundingClientRect();
      const selectedVisible = selectedBefore && selectedBefore.top >= previous.top - 1 && selectedBefore.bottom <= previous.bottom + 1;
      const first = list.firstElementChild!.getBoundingClientRect(), last = list.lastElementChild!.getBoundingClientRect();
      const chrome = this.popup.getBoundingClientRect().height - previous.height;
      // Measure content without enlarging the list: a temporary resize clamps its scroll position.
      const preferred = Math.min(parseFloat(getComputedStyle(this.popup).getPropertyValue('--meo-suggestion-preferred-height')), last.bottom - first.top + chrome);
      const below = Math.max(0, bottom - coords.bottom - 4), above = Math.max(0, coords.top - top - 4);
      if (this.above === null) this.above = below < preferred && above > below;
      else if ((this.above ? above : below) < preferred && (this.above ? below : above) >= preferred) this.above = !this.above;
      else if (above < preferred && below < preferred) this.above = above > below;
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
    }
    choose(index: number) {
      if (this.composing || this.view.compositionStarted) return;
      const context = this.context, item = this.items[index];
      if (item?.slash?.disabled) return;
      if (!context || !item || this.head !== (this.cellInput && this.cellFrom !== null ? this.cellInput.selectionStart : this.view.state.selection.main.head) || JSON.stringify(context) !== JSON.stringify(this.getContext())) { this.clear(); return; }
      if (this.cellInput && this.cellFrom !== null && item.slash) {
        const input = this.cellInput, from = this.cellFrom, command = item.slash;
        const insert = command.id === 'lineBreak' ? '<br>\n' : command.insert;
        const caret = from + (command.id === 'lineBreak' ? insert.length : command.caret);
        const value = input.value.slice(0, from) + insert + input.value.slice(this.head);
        this.cellFrom = null; this.cellInput = null; this.clear(); this.fields = [];
        if (!options.replaceCell?.(input, value, caret)) return;
        if (command.fields) {
          this.fieldInput = input; this.fieldValue = value; this.fieldIndex = 0; this.templateEnd = from + insert.length;
          this.fields = command.fields.map(([start, end]) => ({ from: from + start, to: from + end }));
          input.setSelectionRange(this.fields[0].from, this.fields[0].to);
        }
        return;
      }
      const tableBreak = item.slash?.id === 'lineBreak' && !!sourceTableAt(this.view.state, this.head);
      let insert = tableBreak ? '<br>' : item.insert;
      if (context.type === 'documents') insert = insert.replace(/\.(?:md|markdown|mdx|mdc)$/i, '');
      if (context.type === 'paths') insert = insert.split('/').map(part => encodeURIComponent(part)).join('/');
      if (context.type === 'headings' && !context.wiki) insert = item.anchor ?? insert;
      const from = this.head - context.length;
      const caret = from + (tableBreak ? insert.length : item.caret ?? insert.length);
      const command = item.slash;
      let fields = command?.fields?.map(([start, end]) => ({ from: from + start, to: from + end }));
      let templateEnd = from + insert.length;
      let transaction: TransactionSpec = { changes: { from, to: this.head, insert }, selection: EditorSelection.cursor(caret) };
      if (item.slash?.scope === 'block') {
        const plan = blockInsertion(this.view.state, from, this.head, insert, item.caret!, options.inputContext(this.view.state, from));
        if (!plan) { this.slashFrom = null; this.clear(); return; }
        transaction = plan.transaction;
        fields = command?.fields?.map(([start, end]) => ({ from: plan.positionAt(start), to: plan.positionAt(end) }));
        templateEnd = plan.positionAt(insert.length);
      }
      this.slashFrom = null; this.clear();
      this.view.dispatch({ ...transaction, annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] });
      if (fields) {
        this.fieldInput = null;
        this.fields = fields; this.fieldIndex = 0; this.templateEnd = templateEnd;
        const field = this.fields[0]; this.view.dispatch({ selection: EditorSelection.range(field.from, field.to) });
      }
      this.view.focus();
      if (command?.id === 'blockMath') options.focusMath?.();
      if (command?.id === 'table') options.focusTable?.();
    }
    keydown(event: KeyboardEvent) {
      if (event.isComposing || this.composing || this.view.compositionStarted || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.key === 'Tab' && this.fields.length) {
        event.preventDefault();
        const index = this.fieldIndex + (event.shiftKey ? -1 : 1), field = this.fields[index];
        if (field) {
          this.fieldIndex = index;
          if (this.fieldInput) this.fieldInput.setSelectionRange(field.from, field.to);
          else this.view.dispatch({ selection: EditorSelection.range(field.from, field.to) });
        } else {
          const end = this.templateEnd; this.fields = [];
          if (this.fieldInput) this.fieldInput.setSelectionRange(end, end);
          else this.view.dispatch({ selection: EditorSelection.cursor(end) });
        }
        return true;
      }
      if (event.key === 'Escape' && (this.slashFrom !== null || this.cellFrom !== null || !this.popup.hidden || this.fields.length)) { event.preventDefault(); this.slashFrom = null; this.cellFrom = null; this.cellInput = null; this.fields = []; this.clear(); return true; }
      if (this.popup.hidden) return false;
      if (event.key === 'Escape') { event.preventDefault(); this.slashFrom = null; this.cellFrom = null; this.cellInput = null; this.fields = []; this.clear(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.select((this.index + (event.key === 'ArrowDown' ? 1 : this.items.length - 1)) % this.items.length, true); return true; }
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
    }
  }, { eventHandlers: {
    keydown(event) { return this.keydown(event); },
    blur() { this.slashFrom = null; this.fields = []; this.clear(); return false; },
    compositionstart() { this.composing = true; if (this.context?.type !== 'slash') this.clear(); return false; },
    compositionend() { this.composing = false; this.schedule(); return false; }
  } });
  return plugin;
}
