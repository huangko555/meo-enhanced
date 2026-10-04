import { createElement, Minus, Plus } from 'lucide';
import { createMenuSwitch } from './menuSwitch';
import { createSegmentedControl } from './segmentedControl';
import { canBindCommand, commandContext, effectiveShortcuts, shortcutConflicts, shortcutFromStroke, type ShortcutPlatform } from '../../../src/application/editingPreferences';
import type { EditingPreferences, EditingPreferencesChange, EditorCommandId } from '../../../src/foundation/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, type EditorFontSizePreference } from '../../../src/foundation/editorFontSize';
import { commandTitle, modeOptions, sectionTitles, settingsText, shortcutSections, shortcutDescriptions, tablePasteContexts, typingCatalog, typingSections, type SettingsTab } from '../application/settingsCatalog';

type Section = keyof typeof sectionTitles;
export type GeneralSetting = {
  readonly id: string; readonly section: 'display' | 'opening' | 'interface'; readonly title: string; readonly description?: string;
  readonly control: { kind: 'switch'; get: () => boolean; set: (value: boolean) => void }
    | { kind: 'choice'; get: () => string; set: (value: string) => void; options: readonly { value: string; label: string }[] }
    | { kind: 'font'; get: () => EditorFontSizePreference; set: (value: EditorFontSizePreference) => void };
};
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const button = (text: string, className = 'settings-button') => { const node = element('button', className, text); node.type = 'button'; return node; };
const searchIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0');
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.7'); svg.append(path); return svg;
};

/** Owns only window interaction. Values come from the authoritative settings projections. */
export function createSettingsWindow(options: {
  readonly platform: ShortcutPlatform;
  readonly getPreferences: () => EditingPreferences;
  readonly getGeneral: (language: UiLanguage) => readonly GeneralSetting[];
  readonly update: (change: EditingPreferencesChange) => Promise<{ ok: boolean; error?: { message: string } }>;
  readonly returnFocus: () => { focus(): void } | null;
  readonly initialLanguage: UiLanguage;
}) {
  let language = options.initialLanguage;
  let tab: SettingsTab = 'general';
  let recording: { command: EditorCommandId; draft: string } | null = null;
  let resetOpen = false;
  let disposed = false;
  let renderedSignature = '';
  let valuePresenters: (() => void)[] = [];
  const pending = new Set<string>();
  const scrollPositions: Record<SettingsTab, number> = { general: 0, typing: 0, shortcuts: 0 };
  const abort = new AbortController();
  const dialog = element('dialog', 'settings-window'); dialog.dataset.meoSettings = '';
  const titlebar = element('header', 'settings-titlebar');
  const title = element('h2', 'settings-title');
  const close = button('×', 'settings-close');
  const top = element('div', 'settings-top');
  const tabs = element('div', 'settings-tabs'); tabs.setAttribute('role', 'tablist');
  const tabButtons = new Map<SettingsTab, { button: HTMLButtonElement; label: HTMLSpanElement; badge: HTMLSpanElement }>();
  for (const id of ['general', 'typing', 'shortcuts'] as const) {
    const control = button('', 'settings-tab'); control.dataset.tab = id; control.setAttribute('role', 'tab');
    const label = element('span', 'settings-tab-label'); const badge = element('span', 'settings-tab-badge');
    control.append(label, badge); tabs.append(control); tabButtons.set(id, { button: control, label, badge });
    control.addEventListener('click', () => selectTab(id));
    control.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ids = [...tabButtons.keys()]; const index = ids.indexOf(id);
      const next = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids.at(-1)! : ids[(index + (event.key === 'ArrowRight' ? 1 : 2)) % ids.length];
      selectTab(next); tabButtons.get(next)!.button.focus();
    });
  }
  const searchbox = element('div', 'settings-searchbox');
  const search = element('input', 'settings-search'); search.type = 'search'; search.autocomplete = 'off';
  const clear = button('×', 'settings-search-clear'); searchbox.append(searchIcon(), search, clear); titlebar.append(title, searchbox, close); top.append(tabs);
  const layout = element('div', 'settings-layout');
  const navigation = element('nav', 'settings-navigation');
  const content = element('div', 'settings-content'); content.id = 'meo-settings-content'; content.setAttribute('role', 'tabpanel');
  const status = element('p', 'settings-status'); status.setAttribute('role', 'status'); status.hidden = true;
  layout.append(navigation, content);
  const footer = element('footer', 'settings-footer');
  const reset = button(''); const resetPopover = element('div', 'settings-reset-popover'); resetPopover.hidden = true;
  resetPopover.setAttribute('role', 'group'); const resetTitle = element('strong', 'settings-reset-title');
  const resetDescription = element('p', 'settings-reset-description'); const resetActions = element('div', 'settings-actions');
  const cancelReset = button(''); const confirmReset = button('', 'settings-button settings-primary');
  resetActions.append(cancelReset, confirmReset); resetPopover.append(resetTitle, resetDescription, resetActions); footer.append(resetPopover, reset);
  dialog.append(titlebar, top, status, layout, footer); document.body.append(dialog);
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const query = () => search.value.trim().toLocaleLowerCase();
  const matches = (...parts: (string | undefined)[]) => !query() || parts.join(' ').toLocaleLowerCase().includes(query());
  const titleFor = (section: Section) => { const labels = sectionTitles[section]; return t(labels[0], labels[1]); };
  const dismissReset = () => { resetOpen = false; resetPopover.hidden = true; reset.setAttribute('aria-expanded', 'false'); };
  const focusCommand = (command: EditorCommandId) => (content.querySelector<HTMLButtonElement>(`[data-edit-command='${command}']`) ?? search).focus();
  const finishRecording = () => { const command = recording?.command; recording = null; renderContent(); if (command) focusCommand(command); };
  async function save(change: EditingPreferencesChange, key: string): Promise<boolean> {
    if (pending.has(key) || disposed) return false;
    pending.add(key); status.hidden = true; renderContent();
    let result: { ok: boolean; error?: { message: string } };
    try { result = await options.update(change); } catch (error) { result = { ok: false, error: { message: String(error) } }; }
    pending.delete(key);
    if (disposed) return false;
    if (!result.ok) { status.textContent = t('保存失败：', 'Unable to save: ') + (result.error?.message ?? t('请重试。', 'Please retry.')); status.hidden = false; }
    renderContent(); return result.ok;
  }
  function makeSwitch(get: () => boolean, label: string, set: (next: boolean) => void, isDisabled: () => boolean = () => false) {
    const toggle = button('', 'settings-switch'); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', label); toggle.append(createMenuSwitch());
    const presentValue = () => { toggle.setAttribute('aria-checked', String(get())); toggle.disabled = isDisabled(); };
    valuePresenters.push(presentValue); presentValue();
    toggle.addEventListener('click', () => set(!get())); return toggle;
  }
  function settingRow(name: string, description?: string) {
    const row = element('div', 'settings-item'); const text = element('div', 'settings-item-text');
    text.append(element('div', 'settings-item-title', name)); if (description) text.append(element('p', 'settings-description', description));
    row.append(text); return row;
  }
  function renderGeneral(item: GeneralSetting) {
    const row = settingRow(item.title, item.description); row.dataset.setting = item.id;
    const control = item.control;
    if (control.kind === 'switch') row.append(makeSwitch(control.get, item.title, value => { control.set(value); renderContent(); }));
    else {
      const slot = element('div', 'settings-choice');
      const choices = control.kind === 'font' ? [{ value: 'auto', label: t('自动', 'Auto') }, { value: 'custom', label: t('自定义', 'Custom') }] : control.options;
      const segmented = createSegmentedControl({ ariaLabel: item.title, className: 'settings-segmented', buttonClassName: 'settings-choice-button', datasetKey: 'value', role: 'group', options: choices, buttonTitles: false });
      const presentChoice = () => segmented.setActive(control.kind === 'font' ? control.get().mode : control.get());
      valuePresenters.push(presentChoice); presentChoice(); slot.append(segmented.element); row.append(slot);
      for (const choice of choices) segmented.getButton(choice.value).addEventListener('click', () => {
        if (control.kind === 'font') control.set({ ...control.get(), mode: choice.value as 'auto' | 'custom' }); else control.set(choice.value);
        presentChoice(); if (control.kind === 'font') presentFont();
      });
      const stepper = element('div', 'editor-font-size-stepper');
      const decrease = button('', 'editor-font-size-stepper-button'); const output = element('output', 'editor-font-size-value'); const increase = button('', 'editor-font-size-stepper-button');
      const presentFont = () => {
        if (control.kind !== 'font') return;
        const value = control.get(); const custom = value.mode === 'custom';
        output.textContent = String(value.value); stepper.classList.toggle('is-disabled', !custom); stepper.setAttribute('aria-disabled', String(!custom));
        decrease.disabled = !custom || value.value <= EDITOR_FONT_SIZE_MIN; increase.disabled = !custom || value.value >= EDITOR_FONT_SIZE_MAX;
      };
      if (control.kind === 'font') {
        decrease.append(createElement(Minus, { width: 13, height: 13, 'aria-hidden': 'true' })); increase.append(createElement(Plus, { width: 13, height: 13, 'aria-hidden': 'true' }));
        decrease.setAttribute('aria-label', t('减小字号', 'Decrease font size')); increase.setAttribute('aria-label', t('增大字号', 'Increase font size'));
        const adjust = (delta: number) => { const value = control.get(); if (value.mode !== 'custom') return; control.set({ ...value, value: Math.max(EDITOR_FONT_SIZE_MIN, Math.min(EDITOR_FONT_SIZE_MAX, value.value + delta)) }); presentFont(); };
        decrease.addEventListener('click', () => adjust(-1)); increase.addEventListener('click', () => adjust(1));
        stepper.append(decrease, output, increase); slot.append(stepper); valuePresenters.push(presentFont); presentFont();
      }
    }
    return row;
  }
  function renderTyping(item: typeof typingCatalog[number]) {
    const row = settingRow(t(...item.title), t(...item.description)); row.dataset.setting = item.key;
    const value = options.getPreferences().input[item.key];
    const set = (next: boolean | 'smart' | 'always' | 'off') => { void save({ type: 'input', key: item.key, value: next }, item.key); };
    if (typeof value === 'boolean') row.append(makeSwitch(() => options.getPreferences().input[item.key] as boolean, t(...item.title), set, () => pending.has(item.key)));
    else {
      const choices = element('div', 'settings-radio-group'); choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', t(...item.title));
      for (const option of modeOptions(item.key as 'pairMode' | 'skipMode' | 'deleteMode', language)) {
        const label = element('label', 'settings-radio'); const input = element('input', 'settings-radio-input'); input.type = 'radio'; input.name = `meo-${item.key}`; input.value = option.value;
        const presentValue = () => { input.checked = options.getPreferences().input[item.key] === option.value; input.disabled = pending.has(item.key); };
        valuePresenters.push(presentValue); presentValue(); input.addEventListener('change', () => set(option.value));
        label.append(input, element('span', '', option.label)); choices.append(label);
      }
      row.classList.add('settings-item-expanded'); row.append(choices);
    }
    if (item.key === 'convertTables') {
      const notes = element('dl', 'settings-paste-contexts');
      for (const context of tablePasteContexts) notes.append(element('dt', '', t(context.title[0], context.title[1])), element('dd', '', t(context.description[0], context.description[1])));
      row.append(notes);
    }
    return row;
  }
  function renderShortcut(command: EditorCommandId) {
    const description = shortcutDescriptions[command];
    const row = settingRow(commandTitle(command, language), description ? t(...description) : undefined); row.dataset.command = command;
    const controls = element('div', 'settings-shortcut-controls'); row.append(controls);
    const keys = effectiveShortcuts(options.getPreferences().shortcuts, options.platform)[command];
    const fixed = !canBindCommand(command);
    if (recording?.command === command) {
      const recorder = recording; row.classList.add('settings-recording');
      const input = element('input', 'settings-recorder'); input.readOnly = true; input.value = recorder.draft; input.placeholder = t('按下快捷键', 'Press a shortcut'); input.setAttribute('aria-label', commandTitle(command, language));
      const confirm = button(t('确认', 'Assign')); const cancel = button(t('取消', 'Cancel'));
      const conflictLabel = element('p', 'settings-shortcut-conflict');
      const updateConflict = () => {
        const conflicts = shortcutConflicts(command, recorder.draft ? [recorder.draft] : [], options.getPreferences().shortcuts, options.platform);
        conflictLabel.textContent = conflicts.length ? t('已用于：', 'Already assigned to: ') + conflicts.map(id => commandTitle(id, language)).join(' · ') : '';
        conflictLabel.hidden = !conflicts.length; confirm.textContent = conflicts.length ? t('替换原绑定', 'Replace binding') : t('确认', 'Assign');
        confirm.classList.toggle('settings-warning', !!conflicts.length); confirm.disabled = !recorder.draft || pending.has(command) || conflicts.some(id => !canBindCommand(id));
        return conflicts;
      };
      const commit = async (replaceConflicts: boolean) => { if (confirm.disabled) return; if (await save({ type: 'bind', command, keys: [recorder.draft], replaceConflicts }, command)) finishRecording(); };
      input.addEventListener('keydown', event => {
        if (event.isComposing || event.key === 'Process') return;
        if (event.key === 'Tab') return;
        event.stopPropagation();
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
        if (event.key === 'Escape' && plain) { event.preventDefault(); finishRecording(); return; }
        if (event.key === 'Enter' && plain) { event.preventDefault(); if (!updateConflict().length) void commit(false); return; }
        event.preventDefault();
        const key = shortcutFromStroke({ key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey, composing: event.isComposing, altGraph: event.getModifierState('AltGraph') });
        if (key) { recorder.draft = key; input.value = key; updateConflict(); }
      });
      confirm.addEventListener('click', () => { void commit(true); }); cancel.addEventListener('click', finishRecording);
      controls.append(input, confirm, cancel); row.append(conflictLabel); updateConflict();
    } else {
      const nativeKeys = command === 'selection' ? 'Shift + ← / → / ↑ / ↓' : command === 'home' ? 'Home / End' : '';
      const keyGroup = element('span', 'settings-shortcut-keys');
      for (const key of keys.length ? keys : nativeKeys ? [nativeKeys] : []) keyGroup.append(element('kbd', 'settings-key', key));
      if (!keyGroup.childNodes.length) keyGroup.append(element('span', 'settings-unassigned', t('未设置', 'Unassigned')));
      controls.append(keyGroup);
      if (fixed) controls.append(element('span', 'settings-native', t('系统规则', 'Native')));
      else {
        const edit = button(keys.length ? t('修改', 'Edit') : t('设置', 'Assign')); edit.dataset.editCommand = command; edit.disabled = pending.has(command);
        edit.addEventListener('click', () => { dismissReset(); recording = { command, draft: '' }; renderContent(); content.querySelector<HTMLInputElement>('.settings-recorder')?.focus(); }); controls.append(edit);
        if (keys.length) {
          const remove = button(t('清除', 'Clear'), 'settings-button settings-subtle'); remove.disabled = pending.has(command);
          remove.addEventListener('click', async () => { await save({ type: 'bind', command, keys: [], replaceConflicts: false }, command); focusCommand(command); }); controls.append(remove);
        }
      }
    }
    if (commandContext(command) === 'table') row.querySelector('.settings-item-text')!.append(element('span', 'settings-context', t('表格内', 'In a table')));
    return row;
  }
  function filtered() {
    const general = options.getGeneral(language).filter(item => matches(item.title, item.description, titleFor(item.section)));
    const typing = typingCatalog.filter(item => matches(t(...item.title), t(...item.description), titleFor(item.section), ...(item.key === 'convertTables' ? tablePasteContexts.flatMap(context => [t(context.title[0], context.title[1]), t(context.description[0], context.description[1])]) : [])));
    const shortcuts = Object.entries(shortcutSections).flatMap(([section, commands]) => commands.filter(command => matches(commandTitle(command, language), titleFor(section as Section), ...(shortcutDescriptions[command] ? [t(...shortcutDescriptions[command]!)] : []), ...effectiveShortcuts(options.getPreferences().shortcuts, options.platform)[command])).map(command => ({ section: section as Section, command })));
    return { general, typing, shortcuts };
  }
  function renderContent() {
    if (disposed) return;
    const visible = filtered();
    for (const [id, control] of tabButtons) {
      control.button.setAttribute('aria-selected', String(id === tab)); control.button.tabIndex = id === tab ? 0 : -1;
      control.badge.textContent = String(visible[id].length); control.badge.hidden = !query();
      control.button.id = `meo-settings-tab-${id}`;
    }
    content.setAttribute('aria-labelledby', `meo-settings-tab-${tab}`);
    clear.hidden = search.value.length === 0; footer.hidden = tab !== 'shortcuts';
    const signature = JSON.stringify([language, tab, query(), recording?.command, tab === 'shortcuts' ? [options.getPreferences().shortcuts, [...pending]] : null]);
    if (renderedSignature === signature) { for (const presentValue of valuePresenters) presentValue(); return; }
    renderedSignature = signature;
    const oldScroll = content.scrollTop;
    const activeRecorder = document.activeElement?.classList.contains('settings-recorder');
    valuePresenters = []; content.replaceChildren(); navigation.replaceChildren();
    const groups = tab === 'general' ? ['display', 'opening', 'interface'] : tab === 'typing' ? typingSections : Object.keys(shortcutSections);
    for (const name of groups) {
      const section = name as Section;
      const items = tab === 'general' ? visible.general.filter(item => item.section === section).map(renderGeneral)
        : tab === 'typing' ? visible.typing.filter(item => item.section === section).map(renderTyping)
        : visible.shortcuts.filter(item => item.section === section).map(item => renderShortcut(item.command));
      if (!items.length) continue;
      const block = element('section', 'settings-section'); block.id = `meo-settings-${section}`;
      block.append(element('h3', 'settings-section-title', titleFor(section)), ...items); content.append(block);
      const jump = button(titleFor(section), 'settings-jump'); jump.dataset.section = section;
      jump.addEventListener('click', () => { content.scrollTop += block.getBoundingClientRect().top - content.getBoundingClientRect().top - 20; updateNavigation(); }); navigation.append(jump);
    }
    if (!content.childNodes.length) content.append(element('p', 'settings-empty', t('没有匹配的设置', 'No matching settings')));
    content.scrollTop = oldScroll; updateNavigation();
    if (activeRecorder && recording) content.querySelector<HTMLInputElement>('.settings-recorder')?.focus();
  }
  function updateNavigation() {
    const blocks = [...content.querySelectorAll<HTMLElement>('.settings-section')];
    const current = blocks.find(block => block.getBoundingClientRect().bottom > content.getBoundingClientRect().top + 30) ?? blocks.at(-1);
    for (const jump of navigation.querySelectorAll<HTMLButtonElement>('button')) {
      const active = current?.id === `meo-settings-${jump.dataset.section}`; jump.classList.toggle('is-active', active);
      if (active) jump.setAttribute('aria-current', 'location'); else jump.removeAttribute('aria-current');
    }
  }
  function selectTab(next: SettingsTab) {
    scrollPositions[tab] = content.scrollTop; tab = next; recording = null; dismissReset(); renderContent(); content.scrollTop = scrollPositions[next]; updateNavigation();
  }
  function present() {
    title.textContent = t('设置', 'Settings'); close.setAttribute('aria-label', t('关闭设置', 'Close settings'));
    tabs.setAttribute('aria-label', t('设置分类', 'Settings categories')); navigation.setAttribute('aria-label', t('跳转到章节', 'Jump to section'));
    for (const [id, control] of tabButtons) control.label.textContent = id === 'general' ? t('常规', 'General') : id === 'typing' ? t('输入', 'Input') : t('快捷键', 'Shortcuts');
    search.placeholder = t('搜索设置', 'Search settings'); search.setAttribute('aria-label', search.placeholder); clear.setAttribute('aria-label', t('清除搜索', 'Clear search'));
    reset.textContent = t('恢复默认快捷键', 'Reset shortcuts'); reset.setAttribute('aria-expanded', String(resetOpen));
    resetTitle.textContent = t('恢复全部快捷键？', 'Reset all shortcuts?'); resetDescription.textContent = t('自定义绑定将被替换，其他设置保持不变。', 'Custom bindings will be replaced. Other settings stay unchanged.');
    cancelReset.textContent = t('取消', 'Cancel'); confirmReset.textContent = t('恢复默认', 'Reset'); renderContent();
  }
  function closeWindow() { recording = null; dismissReset(); if (dialog.open) dialog.close(); options.returnFocus()?.focus(); }
  close.addEventListener('click', closeWindow);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (resetOpen) { dismissReset(); reset.focus(); } else if (recording) finishRecording(); else closeWindow(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeWindow(); } });
  search.addEventListener('input', () => { recording = null; dismissReset(); renderContent(); content.scrollTop = 0; updateNavigation(); });
  clear.addEventListener('click', () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus(); });
  content.addEventListener('scroll', updateNavigation, { passive: true });
  reset.addEventListener('click', () => { recording = null; renderContent(); resetOpen = true; resetPopover.hidden = false; reset.setAttribute('aria-expanded', 'true'); cancelReset.focus(); });
  cancelReset.addEventListener('click', () => { dismissReset(); reset.focus(); });
  confirmReset.addEventListener('click', async () => { confirmReset.disabled = true; if (await save({ type: 'resetShortcuts' }, 'reset')) { dismissReset(); reset.focus(); } confirmReset.disabled = false; });
  document.addEventListener('pointerdown', event => { if (resetOpen && event.target instanceof Node && !resetPopover.contains(event.target) && !reset.contains(event.target)) dismissReset(); }, { signal: abort.signal });
  document.addEventListener('focusin', event => { if (resetOpen && event.target instanceof Node && !resetPopover.contains(event.target) && !reset.contains(event.target)) dismissReset(); }, { signal: abort.signal });
  window.addEventListener('blur', dismissReset, { signal: abort.signal });
  present();
  return { open() { if (disposed || dialog.open) return; present(); dialog.showModal(); updateNavigation(); search.focus(); }, close: closeWindow,
    isOpen: () => dialog.open, present, setLanguage(next: UiLanguage) { language = next; present(); },
    dispose() { disposed = true; abort.abort(); if (dialog.open) dialog.close(); dialog.remove(); } };
}
