import { createElement, Minus, Moon, Plus, RotateCcw, Sun, TriangleAlert } from 'lucide';
import { normalizeUiColor, uiColorKeys, type UiColorKey, type UiColors } from '../../../src/foundation/uiColors';
import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import type { UiColorsResult } from '../../../src/protocol/uiColors';
import { EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, type EditorFontSizePreference } from '../../../src/foundation/editorFontSize';
import { DEFAULT_EDITOR_LINE_HEIGHT, EDITOR_LINE_HEIGHT_MIN, EDITOR_LINE_HEIGHT_MAX, normalizeEditorLineHeight } from '../../../src/foundation/editorLineHeight';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { appearanceCatalog, sectionTitles, settingsSearchMatches, settingsText } from '../application/settingsCatalog';
import { createSegmentedControl } from './segmentedControl';
import { createMenuSwitch } from './menuSwitch';

export type AppearanceSettingsOptions = {
  getColors(): UiColors;
  getFontSize(): EditorFontSizePreference;
  setFontSize(value: EditorFontSizePreference): void;
  readonly mac?: boolean;
  getMouseWheelZoom(): boolean;
  setMouseWheelZoom(enabled: boolean): void;
  getLineHeight(): number;
  setLineHeight(value: number): void;
  reportSaveError(message: string): void;
  clearSaveError(): void;
  getMode(): EditorAppearance;
  getScheme(): 'light' | 'dark';
  setMode(mode: EditorAppearance): void;
  preview(colors: UiColors | null): void;
  update(colors: UiColors): Promise<UiColorsResult['result']>;
  registerInput?: (input: HTMLInputElement) => () => void;
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element;
};
const button = (text: string, className = 'settings-button') => { const element = node('button', className, text); element.type = 'button'; return element; };
const copy = (colors: UiColors): UiColors => ({ light: { ...colors.light }, dark: { ...colors.dark } });

/** Local color edits remain projected until the Host acknowledges their serialized save. */
export function createAppearanceSettings(options: AppearanceSettingsOptions) {
  let language: UiLanguage = 'zh-CN';
  let draft = copy(options.getColors());
  let saving = false;
  let savingColors: UiColors | null = null;
  let failed = false;
  let closed = true;
  let disposed = false;
  let revision = 0;
  // Track intent independently of value equality, including edits back to the saved value.
  const dirty = new Map<string, number>();
  const invalid = new Set<UiColorKey>();
  let presenters: (() => void)[] = [];
  let inputRegistrations: (() => void)[] = [];
  let scheme = options.getScheme();
  let previewFrame: number | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let projected: UiColors | null = null;
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const usesDefaultColors = () => document.documentElement.dataset.meoUiColorSource === 'default';
  const colorSourceLabel = () => usesDefaultColors()
    ? t(scheme === 'light' ? '默认浅色配色' : '默认深色配色', scheme === 'light' ? 'Default light palette' : 'Default dark palette')
    : t('跟随 VS Code 主题', 'Follow VS Code theme');
  const footer = node('div', 'appearance-footer');
  const reset = button('');
  const retry = button('', 'settings-button appearance-save-retry'); retry.hidden = true;
  footer.append(reset, retry);
  const status = node('p', 'appearance-status'); status.setAttribute('role', 'status'); status.hidden = true;
  const same = (first: UiColors | null, second: UiColors | null) => first === second || first !== null && second !== null
    && (['light', 'dark'] as const).every(mode => uiColorKeys.every(key => first[mode][key] === second[mode][key]));
  const cancelPreview = () => {
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
  };
  const cancelSaveTimer = () => { if (saveTimer !== undefined) clearTimeout(saveTimer); saveTimer = undefined; };
  const rebase = () => {
    const saved = options.getColors();
    const next = copy(saved);
    for (const mode of ['light', 'dark'] as const) for (const key of uiColorKeys) {
      if (dirty.has(mode + ':' + key)) {
        if (draft[mode][key] === undefined) delete next[mode][key]; else next[mode][key] = draft[mode][key];
      }
    }
    draft = next;
  };
  const project = () => {
    rebase();
    const preview = dirty.size && !(closed && failed) ? copy(draft) : null;
    if (!same(projected, preview)) { projected = preview; options.preview(preview); }
  };
  const present = () => {
    project();
    const nextScheme = options.getScheme();
    if (nextScheme !== scheme) { scheme = nextScheme; invalid.clear(); }
    for (const show of presenters) show();
    reset.textContent = t('恢复默认颜色', 'Reset colors');
    retry.textContent = t('重试保存', 'Retry save'); retry.hidden = !failed; retry.disabled = saving;
  };
  const flushPreview = () => { cancelPreview(); present(); };
  const save = async () => {
    cancelSaveTimer();
    if (saving || !dirty.size || disposed) return;
    flushPreview();
    const sent = new Map(dirty);
    const colors = copy(draft);
    saving = true; savingColors = colors; failed = false; status.hidden = true; present();
    let result: UiColorsResult['result'];
    try { result = await options.update(colors); }
    catch (error) { result = { ok: false, error: { code: 'operation-failed', message: String(error) } }; }
    saving = false; savingColors = null;
    if (disposed) return;
    if (result.ok) {
      options.clearSaveError();
      for (const [key, version] of sent) if (dirty.get(key) === version) dirty.delete(key);
    } else {
      failed = true;
      status.textContent = (result.error.code === 'timeout' ? t('保存未确认：', 'Save not confirmed: ') : t('保存失败：', 'Unable to save: ')) + result.error.message;
      status.hidden = false;
      options.reportSaveError(status.textContent);
    }
    present();
    if (!failed && dirty.size && saveTimer === undefined) void save();
  };
  const scheduleSave = () => { cancelSaveTimer(); saveTimer = setTimeout(() => { void save(); }, 250); };
  const change = (key: UiColorKey, value: string | undefined) => {
    rebase();
    const previous = draft[scheme][key];
    invalid.delete(key);
    if (previous === value && !failed && (!savingColors || savingColors[scheme][key] === value)) { present(); return; }
    if (value === undefined) delete draft[scheme][key]; else draft[scheme][key] = value;
    dirty.set(scheme + ':' + key, ++revision);
    failed = false; status.hidden = true;
    if (previewFrame === undefined) previewFrame = requestAnimationFrame(flushPreview);
    scheduleSave();
  };
  reset.addEventListener('click', () => {
    rebase();
    for (const mode of ['light', 'dark'] as const) for (const key of uiColorKeys) {
      if (draft[mode][key] !== undefined || dirty.has(mode + ':' + key) || savingColors?.[mode][key] !== undefined) {
        delete draft[mode][key]; dirty.set(mode + ':' + key, ++revision);
      }
    }
    invalid.clear(); failed = false; status.hidden = true; flushPreview(); void save();
  });
  retry.addEventListener('click', () => { void save(); });

  const typography = ['fontSize', 'mouseWheelZoom', 'lineHeight'];
  const sectionFor = (item: typeof appearanceCatalog[number]) => item.id === 'mode' ? 'appearanceMode' : typography.includes(item.id) ? 'appearanceTypography' : item.advanced ? 'appearanceAdvanced' : 'appearanceColors';
  const items = (query: string) => appearanceCatalog.filter(item => settingsSearchMatches(query, '外观 Appearance', ...sectionTitles[sectionFor(item)], ...item.title, ...item.description, ...item.keywords, '跟随 VS Code 主题 Follow VS Code theme', item.id === 'mode' || typography.includes(item.id) ? '' : '默认配色 默认浅色配色 默认深色配色 内置预设 Default light palette Default dark palette built-in preset', item.id));
  function render(nextLanguage: UiLanguage, query: string) {
    for (const unregister of inputRegistrations) unregister(); inputRegistrations = [];
    language = nextLanguage; scheme = options.getScheme(); presenters = []; invalid.clear();
    const visible = items(query); const container = node('div', 'appearance-settings');
    reset.hidden = !visible.some(item => item.id !== 'mode' && !typography.includes(item.id));
    const sections = new Map<string, HTMLElement>();
    for (const id of ['appearanceMode', 'appearanceTypography', 'appearanceColors', 'appearanceAdvanced'] as const) {
      if (!visible.some(item => sectionFor(item) === id)) continue;
      const section = node('section', 'settings-section appearance-section'); section.id = 'meo-settings-' + id;
      const titles = sectionTitles[id];
      const heading = node('div', 'appearance-section-heading'); heading.append(node('h3', 'settings-section-title', t(titles[0], titles[1])));
      section.append(heading); sections.set(id, section); container.append(section);
    }
    const note = node('p', 'settings-description appearance-note');
    const schemeLabel = node('span', 'appearance-scheme');
    presenters.push(() => {
      const high = document.documentElement.dataset.meoUiContrast === 'high';
      schemeLabel.textContent = t(scheme === 'light' ? '浅色配色' : '深色配色', `${scheme === 'light' ? 'Light' : 'Dark'} colors`);
      note.textContent = high ? t('高对比度模式使用 VS Code 配色。自定义颜色会保留，切回普通主题后生效。', 'High contrast uses VS Code colors. Custom colors are retained for other themes.')
        : usesDefaultColors() ? t(`留空使用${colorSourceLabel()}。颜色即时生效并自动保存。`, `Leave empty to use the ${scheme} default palette. Changes take effect and save automatically.`)
        : t('留空跟随 VS Code 主题。颜色即时生效并自动保存。', 'Leave empty to follow the VS Code theme. Changes take effect and save automatically.');
    });
    const common = sections.get('appearanceColors');
    common?.querySelector('.appearance-section-heading')?.append(schemeLabel); common?.append(note, status);
    if (!common) container.prepend(status);
    for (const item of visible) {
      const row = node('div', 'settings-item appearance-item'); row.dataset.setting = item.id;
      const title = item.id === 'mouseWheelZoom' ? t(`${options.mac ? 'Cmd' : 'Ctrl'} + 滚轮调整字号`, `${options.mac ? 'Cmd' : 'Ctrl'} + wheel font size`) : t(item.title[0], item.title[1]);
      const text = node('div', 'settings-item-text'); text.append(node('div', 'settings-item-title', title), node('p', 'settings-description', t(item.description[0], item.description[1]))); row.append(text);
      if (item.id === 'documentBackground') {
        const warning = node('p', 'appearance-background-warning');
        const icon = createElement(TriangleAlert, { width: 16, height: 16 });
        icon.setAttribute('aria-hidden', 'true');
        const message = node('span', 'appearance-background-warning-text');
        warning.setAttribute('role', 'note');
        warning.append(icon, message);
        text.append(warning);
        presenters.push(() => {
          const low = document.documentElement.dataset.meoDocumentContrast === 'low';
          const paired = document.documentElement.dataset.meoDocumentCodeSurface === 'paired';
          warning.hidden = !low && !paired;
          message.textContent = low
            ? t('此背景与当前文字或明暗模式对比不足。建议调整背景、切换模式或恢复默认。', 'This background does not suit the current text or mode. Adjust it, change mode, or reset to default.')
            : t('为保留代码文字对比，块区域暂用代码主题底色。可调整文档背景。', 'Blocks retain their code theme background for legibility. You can adjust the document background.');
        });
      }
      if (item.id === 'fontSize' || item.id === 'lineHeight') {
        const isFont = item.id === 'fontSize';
        const controls = node('div', 'settings-choice appearance-typography-controls');
        const stepper = node('div', 'editor-font-size-stepper');
        const decrease = button('', 'editor-font-size-stepper-button');
        const output = node('output', 'editor-font-size-value');
        const increase = button('', 'editor-font-size-stepper-button');
        decrease.append(createElement(Minus, { width: 13, height: 13, 'aria-hidden': 'true' }));
        increase.append(createElement(Plus, { width: 13, height: 13, 'aria-hidden': 'true' }));
        decrease.setAttribute('aria-label', t(isFont ? '减小字号' : '减小行间距', isFont ? 'Decrease font size' : 'Decrease line spacing'));
        increase.setAttribute('aria-label', t(isFont ? '增大字号' : '增大行间距', isFont ? 'Increase font size' : 'Increase line spacing'));
        if (isFont) {
          const modes = createSegmentedControl<'auto' | 'custom'>({ ariaLabel: t(...item.title), className: 'settings-segmented', buttonClassName: 'settings-choice-button', datasetKey: 'value', role: 'group', buttonTitles: false, options: [
            { value: 'auto', label: t('自动', 'Auto') }, { value: 'custom', label: t('自定义', 'Custom') }
          ] });
          for (const mode of ['auto', 'custom'] as const) modes.getButton(mode).addEventListener('click', () => { options.setFontSize({ ...options.getFontSize(), mode }); present(); });
          presenters.push(() => modes.setActive(options.getFontSize().mode)); controls.append(modes.element);
        }
        const min = isFont ? EDITOR_FONT_SIZE_MIN : EDITOR_LINE_HEIGHT_MIN;
        const max = isFont ? EDITOR_FONT_SIZE_MAX : EDITOR_LINE_HEIGHT_MAX;
        presenters.push(() => {
          const value = isFont ? options.getFontSize().value : options.getLineHeight();
          const disabled = isFont && options.getFontSize().mode !== 'custom';
          output.textContent = isFont ? String(value) : t(value.toFixed(1) + ' 倍', value.toFixed(1) + '×');
          decrease.disabled = disabled || value <= min; increase.disabled = disabled || value >= max;
          stepper.classList.toggle('is-disabled', disabled); stepper.setAttribute('aria-disabled', String(disabled));
        });
        const adjust = (delta: number) => {
          if (isFont) {
            const value = options.getFontSize();
            if (value.mode === 'custom') options.setFontSize({ ...value, value: Math.min(max, Math.max(min, value.value + delta)) });
          } else options.setLineHeight(normalizeEditorLineHeight(options.getLineHeight() + delta * 0.1));
          present();
        };
        decrease.addEventListener('click', () => adjust(-1)); increase.addEventListener('click', () => adjust(1));
        stepper.append(decrease, output, increase); controls.append(stepper);
        const restore = button('', 'settings-button settings-subtle appearance-typography-reset');
        restore.append(createElement(RotateCcw, { width: 14, height: 14, 'aria-hidden': 'true' }));
        restore.setAttribute('aria-label', t(isFont ? '恢复自动字号' : '恢复默认行间距（1.5 倍）', isFont ? 'Restore automatic font size' : 'Reset line spacing (1.5×)'));
        restore.addEventListener('click', () => { if (isFont) options.setFontSize({ ...options.getFontSize(), mode: 'auto' }); else options.setLineHeight(DEFAULT_EDITOR_LINE_HEIGHT); present(); });
        controls.append(restore); row.append(controls);
      } else if (item.id === 'mouseWheelZoom') {
        const toggle = button('', 'settings-switch');
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', title); toggle.append(createMenuSwitch());
        presenters.push(() => toggle.setAttribute('aria-checked', String(options.getMouseWheelZoom())));
        toggle.addEventListener('click', () => { options.setMouseWheelZoom(!options.getMouseWheelZoom()); present(); });
        row.append(toggle);
      } else if (item.id === 'mode') {
        row.classList.add('appearance-mode');
        const modeControl = createSegmentedControl<EditorAppearance>({ ariaLabel: t(...item.title), className: 'editor-appearance-control appearance-mode-control', buttonClassName: 'editor-appearance-button', datasetKey: 'appearanceMode', role: 'group', width: '240px', buttonTitles: false, options: [
          { value: 'auto', label: t('自动', 'Auto') },
          { value: 'light', label: t('浅色', 'Light'), renderLeading: () => createElement(Sun, { width: 12, height: 12, 'aria-hidden': 'true' }) },
          { value: 'dark', label: t('深色', 'Dark'), renderLeading: () => createElement(Moon, { width: 12, height: 12, 'aria-hidden': 'true' }) }
        ] });
        presenters.push(() => modeControl.setActive(options.getMode()));
        for (const value of ['auto', 'light', 'dark'] as const) modeControl.getButton(value).addEventListener('click', () => { flushPreview(); options.setMode(value); present(); });
        row.append(modeControl.element);
      } else {
        const key = item.id; const controls = node('div', 'appearance-color-controls');
        const field = node('div', 'appearance-color-field');
        const chip = node('label', 'appearance-color-chip');
        const swatchInput = node('input', 'appearance-color-swatch'); swatchInput.type = 'color'; swatchInput.setAttribute('aria-label', t(item.title[0], item.title[1]));
        const input = node('input', 'appearance-color-hex'); input.type = 'text'; input.setAttribute('spellcheck', 'false'); input.maxLength = 7; input.placeholder = t('跟随 VS Code 主题', 'Follow VS Code theme'); input.setAttribute('aria-label', t(item.title[0], item.title[1]) + ' HEX'); input.title = t('输入 #RGB 或 #RRGGBB；留空跟随 VS Code 主题。', 'Enter #RGB or #RRGGBB; leave empty to follow the VS Code theme.');
        const unregister = options.registerInput?.(input); if (unregister) inputRegistrations.push(unregister);
        const restore = button('', 'settings-button settings-subtle appearance-color-reset'); restore.setAttribute('aria-label', t(item.title[0], item.title[1]) + ' · ' + t('跟随 VS Code 主题', 'Follow VS Code theme'));
        restore.append(createElement(RotateCcw, { width: 14, height: 14, 'aria-hidden': 'true' }));
        chip.append(swatchInput); field.append(chip, input); controls.append(field, restore); row.append(controls);
        let shownScheme = scheme;
        presenters.push(() => {
          const color = draft[scheme][key];
          input.placeholder = colorSourceLabel();
          input.title = t(`输入 #RGB 或 #RRGGBB；留空${usesDefaultColors() ? '使用' : ''}${colorSourceLabel()}。`, `Enter #RGB or #RRGGBB; leave empty ${usesDefaultColors() ? `to use the ${scheme} default palette` : 'to follow the VS Code theme'}.`);
          restore.setAttribute('aria-label', t(item.title[0], item.title[1]) + ' · ' + colorSourceLabel());
          if ((!invalid.has(key) && document.activeElement !== input) || shownScheme !== scheme) { input.value = color ?? ''; input.removeAttribute('aria-invalid'); shownScheme = scheme; }
          restore.disabled = !color && !invalid.has(key);
          const role = key === 'textEmphasis' ? 'text-emphasis-content' : key === 'documentBackground' ? 'document-background' : key;
          const value = color ?? getComputedStyle(document.documentElement).getPropertyValue('--meo-ui-' + role).trim();
          chip.style.backgroundColor = value;
          const rgb = value.match(/^rgb\((\d+)[, ]+(\d+)[, ]+(\d+)/);
          const next = color ?? (rgb ? '#' + rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('') : undefined);
          if (next && swatchInput.value.toUpperCase() !== next.toUpperCase()) swatchInput.value = next;
        });
        swatchInput.addEventListener('input', () => { input.value = swatchInput.value.toUpperCase(); chip.style.backgroundColor = swatchInput.value; input.removeAttribute('aria-invalid'); change(key, input.value); });
        input.addEventListener('input', () => {
          const color = normalizeUiColor(input.value);
          if (!input.value.trim()) { input.removeAttribute('aria-invalid'); change(key, undefined); }
          else if (color) { input.removeAttribute('aria-invalid'); change(key, color); }
          else {
            // Do not persist a transient valid prefix (for example #123 in #1234).
            dirty.delete(scheme + ':' + key);
            invalid.add(key); input.setAttribute('aria-invalid', 'true'); present();
          }
        });
        input.addEventListener('blur', () => { if (!invalid.has(key)) { input.value = draft[scheme][key] ?? ''; } });
        restore.addEventListener('click', () => { input.value = ''; change(key, undefined); });
      }
      sections.get(sectionFor(item))!.append(row);
    }
    if (!visible.length) container.append(node('p', 'settings-empty', t('没有匹配的设置', 'No matching settings')));
    present(); return container;
  }
  return { footer, render, present, count: (query: string) => items(query).length,
    open() { closed = false; invalid.clear(); present(); },
    close() { closed = true; invalid.clear(); flushPreview(); void save(); },
    dispose() { cancelPreview(); cancelSaveTimer(); disposed = true; options.preview(null); for (const unregister of inputRegistrations) unregister(); inputRegistrations = []; presenters = []; },
  };
}
