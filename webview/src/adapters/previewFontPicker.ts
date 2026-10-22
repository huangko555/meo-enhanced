import { createElement, Search, X } from 'lucide';

type FontPickerLabels = { search: string; clear: string; empty: string; reset: string; resetShort: string; refresh: string; refreshShort: string; missing: string };
let nextPickerId = 0;
let activePickerClose: (() => void) | undefined;

/** Search is a draft: only choosing an option changes the saved font family. */
export function createPreviewFontPicker(controlClass: string, labelText: string, onLoad: (refresh: boolean) => void) {
  const id = `preview-font-list-${++nextPickerId}`;
  const element = document.createElement('div');
  element.className = `preview-select-control ${controlClass}`;
  const label = document.createElement('span'); label.className = 'preview-select-label';
  const shell = document.createElement('span'); shell.className = 'preview-select-shell';
  const select = document.createElement('select');
  select.className = 'preview-toolbar-select preview-toolbar-native-select'; select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  const trigger = document.createElement('button'); trigger.type = 'button';
  trigger.className = `preview-toolbar-dropdown ${controlClass.replace(/-control$/, '')}-dropdown`;
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-panel`);
  const value = document.createElement('span'); value.className = 'preview-toolbar-dropdown-value';
  const chevron = document.createElement('span'); chevron.className = 'preview-toolbar-dropdown-chevron'; chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron); shell.append(select, trigger); element.append(label, shell);
  const panel = document.createElement('div');
  panel.id = `${id}-panel`; panel.className = `preview-dropdown-panel preview-font-picker ${controlClass.replace(/-control$/, '')}-dropdown-panel`;
  panel.dataset.previewControl = controlClass; panel.setAttribute('role', 'dialog'); panel.hidden = true;
  const searchRow = document.createElement('div'); searchRow.className = 'preview-font-search-row';
  const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.className = 'preview-font-search';
  searchInput.setAttribute('role', 'combobox'); searchInput.setAttribute('aria-autocomplete', 'list'); searchInput.setAttribute('aria-controls', id); searchInput.setAttribute('aria-expanded', 'true');
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'preview-font-clear'; clear.hidden = true;
  clear.append(createElement(X, { width: 12, height: 12, 'stroke-width': 1.5, 'aria-hidden': 'true' }));
  const list = document.createElement('div'); list.id = id; list.className = 'preview-font-list'; list.setAttribute('role', 'listbox');
  const actions = document.createElement('div'); actions.className = 'preview-font-actions';
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'preview-font-action preview-font-reset';
  const resetLabel = document.createElement('span');
  reset.append(resetLabel);
  const results = document.createElement('div'); results.className = 'preview-font-results'; results.setAttribute('role', 'presentation');
  const empty = document.createElement('div'); empty.className = 'preview-font-message'; empty.hidden = true;
  const status = document.createElement('div'); status.className = 'preview-font-message'; status.setAttribute('role', 'status'); status.hidden = true;
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'preview-font-action preview-font-refresh';
  const refreshLabel = document.createElement('span');
  refresh.append(refreshLabel);
  actions.append(reset, refresh);
  searchRow.append(createElement(Search, { width: 13, height: 13, 'aria-hidden': 'true' }), searchInput, clear, actions);
  list.append(results); panel.append(searchRow, list, empty, status); document.body.append(panel);
  let labels: FontPickerLabels = { search: '', clear: '', empty: '', reset: '', resetShort: '', refresh: '', refreshShort: '', missing: '' };
  let active: HTMLButtonElement | undefined;
  let panelLeft: number | undefined;
  let composing = false;
  const events = new AbortController();
  const selectedOption = () => select.selectedOptions.item(0) ?? select.options.item(0);
  const setLabel = (text: string) => { label.textContent = text; trigger.setAttribute('aria-label', text); panel.setAttribute('aria-label', text); };
  const close = (restoreFocus = false) => {
    if (panel.hidden) return;
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (activePickerClose === close) activePickerClose = undefined;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const syncFromSelect = () => {
    trigger.disabled = select.disabled;
    reset.disabled = select.disabled || select.value === '';
    if (select.disabled) close();
    value.textContent = selectedOption()?.textContent ?? '';
    if (panel.hidden) return;
    for (const option of panel.querySelectorAll<HTMLButtonElement>('[role="option"]')) {
      const selected = option.dataset.value === select.value;
      option.classList.toggle('is-selected', selected); option.setAttribute('aria-selected', String(selected));
    }
  };
  const position = () => {
    if (panel.hidden) return;
    const bounds = trigger.getBoundingClientRect();
    const below = window.innerHeight - bounds.bottom - 8;
    const above = bounds.top - 8;
    panel.style.maxHeight = `${Math.max(0, below, above)}px`;
    const openAbove = panel.offsetHeight > below && above > below;
    panel.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
    // Font labels can move the trigger; keep this opening's anchor until closed.
    panelLeft = Math.max(8, Math.min(panelLeft ?? bounds.left, window.innerWidth - panel.offsetWidth - 8));
    panel.style.left = `${panelLeft}px`;
    panel.style.top = `${openAbove ? Math.max(8, bounds.top - panel.offsetHeight - 4) : bounds.bottom + 4}px`;
  };
  const setActive = (option: HTMLButtonElement | undefined) => {
    active?.classList.remove('is-active'); active = option; active?.classList.add('is-active');
    if (active) {
      searchInput.setAttribute('aria-activedescendant', active.id);
      if (!panel.hidden && results.contains(active)) {
        // scrollIntoView can scroll clipped ancestors or the embedding Webview; only this list owns the scroll.
        const bounds = active.getBoundingClientRect();
        const top = results.getBoundingClientRect().top + results.clientTop;
        if (bounds.top < top) results.scrollTop += bounds.top - top;
        else if (bounds.bottom > top + results.clientHeight) results.scrollTop += bounds.bottom - top - results.clientHeight;
      }
    } else searchInput.removeAttribute('aria-activedescendant');
  };
  const choose = (family: string) => {
    if (select.disabled) return;
    select.value = family; syncFromSelect(); select.dispatchEvent(new Event('change', { bubbles: true }));
    // Applying preferences can rebuild the rows; keep keyboard navigation on the chosen family.
    setActive([...results.querySelectorAll<HTMLButtonElement>('button')].find(option => option.dataset.value === family));
    if (!panel.hidden) searchInput.focus({ preventScroll: true });
  };
  const refreshOptions = () => {
    // Closed popups need only their trigger value. Opening always rebuilds from
    // the current catalog, labels and preference before keyboard navigation.
    if (panel.hidden) { syncFromSelect(); return; }
    const query = searchInput.value.trim().toLocaleLowerCase();
    clear.hidden = !searchInput.value;
    const scrollTop = results.scrollTop;
    results.replaceChildren();
    for (const [index, native] of Array.from(select.options).entries()) {
      if (!native.value) continue;
      if (query && !`${native.value} ${native.dataset.aliases ?? ''}`.toLocaleLowerCase().includes(query)) continue;
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.id = `${id}-${index}`; option.className = 'preview-dropdown-option'; option.dataset.value = native.value; option.setAttribute('role', 'option');
      const name = document.createElement('span'); name.className = 'preview-font-option-name'; name.textContent = native.textContent;
      name.dataset.tooltip = native.textContent ?? ''; name.dataset.tooltipKind = 'fulltext';
      option.append(name);
      if (native.dataset.missing === 'true') { const note = document.createElement('span'); note.className = 'preview-font-missing'; note.textContent = labels.missing; name.append(note); }
      option.addEventListener('click', () => choose(native.value));
      results.append(option);
    }
    empty.hidden = results.childElementCount > 0;
    syncFromSelect();
    const selected = results.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? undefined;
    position();
    results.scrollTop = scrollTop;
    setActive(selected ?? (query ? results.querySelector<HTMLButtonElement>('button') ?? undefined : undefined));
  };
  const open = () => {
    if (select.disabled) return;
    activePickerClose?.(); activePickerClose = close;
    panelLeft = undefined;
    panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    searchInput.value = ''; refreshOptions(); searchInput.focus({ preventScroll: true }); onLoad(false);
  };
  trigger.addEventListener('click', () => panel.hidden ? open() : close(), { signal: events.signal });
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } }, { signal: events.signal });
  searchInput.addEventListener('input', refreshOptions, { signal: events.signal });
  searchInput.addEventListener('compositionstart', () => { composing = true; }, { signal: events.signal });
  searchInput.addEventListener('compositionend', () => { composing = false; refreshOptions(); }, { signal: events.signal });
  clear.addEventListener('click', () => {
    searchInput.value = ''; refreshOptions(); searchInput.focus({ preventScroll: true });
  }, { signal: events.signal });
  panel.addEventListener('keydown', event => {
    if (event.isComposing || composing) { event.stopPropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.target !== searchInput) return;
    if (event.key === 'Enter') { event.preventDefault(); if (active) choose(active.dataset.value ?? ''); return; }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const options = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const index = active ? options.indexOf(active) : event.key === 'ArrowDown' ? -1 : 0;
    setActive(options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]);
  }, { signal: events.signal });
  reset.addEventListener('click', () => choose(''), { signal: events.signal });
  refresh.addEventListener('click', () => onLoad(true), { signal: events.signal });
  select.addEventListener('change', syncFromSelect, { signal: events.signal });
  window.addEventListener('pointerdown', event => { if (event.target instanceof Node && !element.contains(event.target) && !panel.contains(event.target)) close(); }, { capture: true, signal: events.signal });
  // Refresh temporarily disables its button, which can move focus to body. Escape
  // still belongs to the visible child popup before its parent options panel.
  window.addEventListener('keydown', event => {
    if (panel.hidden || event.key !== 'Escape') return;
    event.stopPropagation();
    if (event.isComposing || composing) return;
    event.preventDefault(); close(true);
  }, { capture: true, signal: events.signal });
  window.addEventListener('resize', position, { signal: events.signal });
  window.addEventListener('scroll', event => { if (!(event.target instanceof Node) || !panel.contains(event.target)) position(); }, { capture: true, signal: events.signal });
  setLabel(labelText);
  return {
    element, label, select, trigger, panel, searchInput, setLabel, close, refreshOptions, syncFromSelect,
    setLabels(next: FontPickerLabels) {
      labels = next; searchInput.placeholder = next.search; searchInput.setAttribute('aria-label', next.search);
      clear.setAttribute('aria-label', next.clear); clear.dataset.tooltip = next.clear;
      resetLabel.textContent = next.resetShort; reset.setAttribute('aria-label', next.reset); reset.dataset.tooltip = next.reset;
      refreshLabel.textContent = next.refreshShort;
      empty.textContent = next.empty; refresh.setAttribute('aria-label', next.refresh); refresh.dataset.tooltip = next.refresh; refreshOptions();
    },
    setStatus(message: string, loading = false) { status.textContent = message; status.hidden = !message; refresh.disabled = loading; position(); },
    setAppearance(appearance: 'light' | 'dark') { element.dataset.previewAppearance = appearance; panel.dataset.previewAppearance = appearance; },
    dispose() { close(); events.abort(); panel.remove(); }
  };
}
