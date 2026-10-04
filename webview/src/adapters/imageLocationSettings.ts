import { defaultImageStorage, type ImageLocationState, type ImageStoragePreferences } from '../../../src/foundation/imageStorage';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import type { ImageLocationRequest, ImageLocationResponse } from '../../../src/protocol/imageStorage';

type Request = Omit<Extract<ImageLocationRequest, { action: 'read' | 'selectFolder' }>, 'type' | 'requestId'>
  | Omit<Extract<ImageLocationRequest, { action: 'preview' | 'save' }>, 'type' | 'requestId'>;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};

/** Owns a temporary draft; destinations and persisted values always come from Host responses. */
export function createImageLocationSettings(options: {
  language: UiLanguage; request: (request: Request) => Promise<ImageLocationResponse['result']>;
}) {
  let language = options.language;
  let preferences = { ...defaultImageStorage };
  let state: ImageLocationState | null = null;
  let loaded = false;
  let dirty = false;
  let disposed = false;
  let version = 0;
  let readSequence = 0;
  let savedVersion = -1;
  let savingVersion = -1;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let status: 'loading' | 'ready' | 'editing' | 'saving' | 'saved' | 'failed' = 'loading';
  let previewPending = false;
  let selecting = false;
  let composing = false;
  let failure = '';
  const t = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const element = node('div', 'settings-item image-location-settings'); element.dataset.setting = 'imageStorage';
  const title = node('div', 'settings-item-title');
  const description = node('p', 'settings-description');
  const heading = node('div', 'settings-item-text'); heading.append(title, description);
  const preview = node('dl', 'image-location-preview');
  const documentLabel = node('dt', ''); const documentValue = node('dd', '');
  const targetLabel = node('dt', ''); const targetValue = node('dd', '');
  preview.append(documentLabel, documentValue, targetLabel, targetValue);
  const modes = node('div', 'settings-radio-group image-location-modes'); modes.setAttribute('role', 'radiogroup');
  const modeControls = (['default', 'perDocument', 'advanced'] as const).map(mode => {
    const option = node('div', 'image-location-option'); option.dataset.imageMode = mode;
    const label = node('label', 'settings-radio');
    const input = node('input', 'settings-radio-input'); input.type = 'radio'; input.name = 'meo-image-storage'; input.value = mode;
    const text = node('span', 'image-location-mode-title');
    const summary = node('span', 'settings-description image-location-mode-description');
    const caption = node('span', 'image-location-mode-caption'); caption.append(text, summary);
    const details = node('div', 'image-location-details');
    label.append(input, caption); option.append(label, details); modes.append(option);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      preferences = { ...preferences, mode }; fields(); edit(true);
    });
    return { mode, input, text, summary, details };
  });
  const folderLabel = node('label', 'image-location-field-label');
  const folderBox = node('div', 'image-location-path');
  const prefix = node('span', 'image-location-prefix', './');
  const folder = node('input', 'image-location-input'); folder.type = 'text'; folder.autocomplete = 'off';
  const suffix = node('span', 'image-location-suffix');
  folderBox.append(prefix, folder, suffix);
  const basic = node('div', 'image-location-basic');
  const basicHint = node('p', 'settings-description'); basic.append(folderLabel, folderBox, basicHint);
  modeControls[0].details.append(basic);
  const ruleLabel = node('label', 'image-location-field-label');
  const rule = node('input', 'image-location-input image-location-rule'); rule.type = 'text'; rule.autocomplete = 'off';
  const picker = node('button', 'settings-button image-location-picker'); picker.type = 'button';
  const ruleBox = node('div', 'image-location-rule-box'); ruleBox.append(rule, picker);
  const advancedHint = node('p', 'settings-description');
  const variables = node('div', 'image-location-variables');
  const tokens = [
    ['fileDirname', '当前文档目录', 'Document directory'],
    ['fileBasename', '文档名，含扩展名', 'File name with extension'],
    ['fileBasenameNoExtension', '文档名，不含扩展名', 'File name without extension'],
    ['fileExtname', '扩展名，含点号', 'Extension including the dot']
  ].map(([name, zh, en]) => {
    const value = '${' + name + '}';
    const button = node('button', 'settings-button image-location-token', value); button.type = 'button';
    const tooltip = node('span', 'more-tools-option-tooltip'); tooltip.id = 'meo-image-variable-' + name;
    tooltip.setAttribute('role', 'tooltip');
    button.setAttribute('aria-label', value); button.setAttribute('aria-describedby', tooltip.id); button.append(tooltip);
    const positionHint = () => {
      const bounds = button.getBoundingClientRect();
      tooltip.style.left = (bounds.left + bounds.width / 2) + 'px';
      tooltip.style.top = (bounds.bottom + 7) + 'px';
    };
    button.addEventListener('mouseenter', positionHint); button.addEventListener('focus', positionHint);
    button.addEventListener('click', () => {
      rule.setRangeText(value, rule.selectionStart ?? rule.value.length, rule.selectionEnd ?? rule.value.length, 'end');
      preferences = { ...preferences, rule: rule.value }; rule.focus(); edit();
    });
    variables.append(button); return { button, tooltip, zh, en, positionHint };
  });
  // Fixed positioning lets one-line hints escape the settings scroll area's clipping.
  const positionHints = () => {
    for (const token of tokens) if (token.button.matches(':hover, :focus-visible')) token.positionHint();
  };
  window.addEventListener('resize', positionHints);
  window.addEventListener('scroll', positionHints, { capture: true, passive: true });
  const advanced = node('div', 'image-location-advanced'); advanced.append(ruleLabel, ruleBox, advancedHint, variables);
  modeControls[2].details.append(advanced);
  const legacy = node('p', 'settings-description image-location-legacy');
  const notice = node('p', 'settings-description image-location-note');
  const feedback = node('p', 'image-location-feedback'); feedback.setAttribute('role', 'status');
  const retry = node('button', 'settings-button image-location-retry'); retry.type = 'button'; retry.hidden = true;
  element.append(heading, preview, modes, legacy, notice, feedback, retry);
  folder.maxLength = rule.maxLength = 4096;
  basicHint.id = 'meo-image-folder-hint'; folder.setAttribute('aria-describedby', basicHint.id);
  advancedHint.id = 'meo-image-rule-hint'; rule.setAttribute('aria-describedby', advancedHint.id);
  folderLabel.htmlFor = folder.id = 'meo-image-folder';
  ruleLabel.htmlFor = rule.id = 'meo-image-rule';

  function fields() {
    basic.hidden = preferences.mode === 'advanced';
    const selected = modeControls.find(item => item.mode === preferences.mode)!;
    if (preferences.mode !== 'advanced' && basic.parentElement !== selected.details) selected.details.append(basic);
    advanced.hidden = preferences.mode !== 'advanced';
    suffix.hidden = preferences.mode !== 'perDocument';
    suffix.textContent = '/' + (state?.documentName || t('文档名', 'document-name'));
    if (!composing && folder.value !== preferences.folder) folder.value = preferences.folder;
    if (!composing && rule.value !== preferences.rule) rule.value = preferences.rule;
    for (const item of modeControls) {
      item.input.checked = preferences.mode === item.mode; item.input.disabled = !loaded;
      item.details.hidden = preferences.mode !== item.mode;
    }
    folder.disabled = rule.disabled = !loaded;
  }
  function errorText(message: string) {
    if (language !== 'zh-CN') return message;
    if (message.startsWith('Unknown image path variable: ')) return '不支持的路径变量：' + message.slice('Unknown image path variable: '.length);
    const translations: Record<string, string> = {
      'Use a folder inside the document directory; use Advanced for other locations.': '请填写当前文档中的子文件夹；其他位置请选择“自定义路径（高级）”。',
      'Enter an image folder path.': '请填写图片目录。',
      'Enter a valid folder path.': '请填写有效的目录路径。',
      'Invalid image path variable.': '路径变量格式不完整。',
      'Home-directory paths (~) are not supported; use a path relative to the document or an absolute path.': '暂不支持用 ~ 表示用户主目录；请填写相对当前文档的路径或绝对路径。',
      'The folder path contains a name that Windows cannot use.': '目录包含 Windows 不支持的名称或字符。',
      'Image settings request timed out.': '请求超时，请重试。'
    };
    return translations[message] ?? message;
  }
  function present(nextLanguage = language) {
    language = nextLanguage;
    title.textContent = t('图片保存位置', 'Image save location');
    description.textContent = t('截图粘贴后，自动保存图片并插入文档。', 'Save pasted screenshots and insert them into the document.');
    documentLabel.textContent = t('当前文档', 'Current document');
    targetLabel.textContent = t('图片将保存到', 'Images will be saved to');
    documentValue.textContent = state?.documentPath ?? t('未保存的文档', 'Unsaved document');
    targetValue.textContent = status === 'loading' ? t('正在读取…', 'Loading…')
      : !state?.documentPath ? t('先保存文档，再粘贴图片。', 'Save the document before pasting images.')
      : previewPending ? t('正在计算…', 'Calculating…')
      : state.error ? t('路径无效，请检查下方输入。', 'Invalid path. Check the input below.')
      : state.targetDirectory ?? '—';
    modes.setAttribute('aria-label', title.textContent);
    modeControls[0].text.textContent = t('文档旁的文件夹（默认）', 'Beside document (default)');
    modeControls[0].summary.textContent = t('同一目录下的文档共用这个图片文件夹。', 'Documents in the same directory share this image folder.');
    modeControls[1].text.textContent = t('文档旁，按文档名分开', 'Beside document, by name');
    modeControls[1].summary.textContent = t('图片仍在文档旁，并按文档名分别存放。', 'Keep images beside the document, in a subfolder named after it.');
    modeControls[2].text.textContent = t('自定义路径（高级）', 'Custom path (advanced)');
    modeControls[2].summary.textContent = t('选择其他文件夹，或用文档名等变量组合路径。', 'Choose another folder or build a path using file-name variables.');
    folderLabel.textContent = t('文件夹名称', 'Folder name');
    basicHint.textContent = preferences.mode === 'perDocument'
      ? t('./ 表示当前 Markdown 文档所在目录；末尾文档名自动生成，不含扩展名。', './ starts in the current Markdown directory. The file name is added without its extension.')
      : t('./ 表示当前 Markdown 文档所在目录。', './ starts in the current Markdown directory.');
    ruleLabel.textContent = t('图片目录或路径规则', 'Image folder or path rule');
    advancedHint.textContent = t('支持绝对路径、相对当前文档的路径及下方变量。点击变量可插入。', 'Use an absolute path, a path relative to the document, or the variables below. Click a variable to insert it.');
    picker.textContent = t('选择文件夹…', 'Choose folder…');
    picker.disabled = !loaded || selecting;
    for (const token of tokens) token.tooltip.textContent = t(token.zh, token.en);
    legacy.hidden = !state?.legacy || dirty;
    legacy.textContent = t('沿用原有目录配置；主动修改后使用这里的新规则。', 'Your previous folder configuration is preserved until you change it here.');
    notice.textContent = t('有效修改自动保存，既有图片不会移动。', 'Valid changes save automatically. Existing images stay where they are.');
    feedback.textContent = status === 'failed' ? t('未保存：', 'Not saved: ') + errorText(failure)
      : state?.error ? t('路径无效：', 'Invalid path: ') + errorText(state.error)
      : status === 'saving' ? t('正在保存…', 'Saving…')
      : status === 'saved' ? t('已自动保存', 'Saved automatically') : '';
    feedback.classList.toggle('is-error', status === 'failed' || !!state?.error);
    retry.textContent = t('重试保存', 'Retry saving');
    retry.hidden = status !== 'failed' || !!state?.error;
    fields();
  }
  async function refresh() {
    if (disposed || dirty || composing) return;
    const sequence = ++readSequence; const current = version;
    const result = await options.request({ action: 'read' });
    if (disposed || dirty || composing || current !== version || sequence !== readSequence) return;
    if (!result.ok) { status = 'failed'; failure = result.error.message; present(); return; }
    state = result.value.state; preferences = { ...state.preferences }; loaded = true; status = 'ready'; present();
  }
  async function previewDraft(current: number) {
    const result = await options.request({ action: 'preview', preferences: { ...preferences } });
    if (disposed || composing || current !== version || savedVersion === current) return;
    previewPending = false;
    if (result.ok) { state = result.value.state; }
    else { status = 'failed'; failure = result.error.message; }
    present();
  }
  async function save() {
    if (disposed || composing || !loaded || !dirty || savedVersion === version || savingVersion === version) return;
    clearTimeout(saveTimer); saveTimer = undefined;
    const current = version; savingVersion = current; status = 'saving'; present();
    const result = await options.request({ action: 'save', preferences: { ...preferences } });
    if (savingVersion === current) savingVersion = -1;
    if (disposed || current !== version) return;
    if (!result.ok) { status = 'failed'; failure = result.error.message; present(); return; }
    state = result.value.state; preferences = { ...state.preferences }; previewPending = false;
    savedVersion = current; dirty = false; status = 'saved'; present();
  }
  function edit(immediate = false) {
    ++version; dirty = true; previewPending = true; status = 'editing'; failure = ''; present();
    clearTimeout(previewTimer); clearTimeout(saveTimer);
    const current = version;
    previewTimer = setTimeout(() => { void previewDraft(current); }, 80);
    saveTimer = setTimeout(() => { void save(); }, immediate ? 0 : 400);
  }
  folder.addEventListener('input', event => { if (composing || (event as InputEvent).isComposing) return; preferences = { ...preferences, folder: folder.value }; edit(); });
  rule.addEventListener('input', event => { if (composing || (event as InputEvent).isComposing) return; preferences = { ...preferences, rule: rule.value }; edit(); });
  for (const input of [folder, rule]) {
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      input.dispatchEvent(new Event('input'));
    });
    input.addEventListener('blur', () => { void save(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void save(); } });
  }
  retry.addEventListener('click', () => { if (loaded && dirty) void save(); else void refresh(); });
  picker.addEventListener('click', async () => {
    selecting = true; picker.disabled = true; const current = version;
    const result = await options.request({ action: 'selectFolder' });
    selecting = false;
    if (disposed) return;
    if (current !== version) { present(); return; }
    if (!result.ok) { status = 'failed'; failure = result.error.message; present(); return; }
    if (result.value.selectedFolder !== null) {
      preferences = { ...preferences, mode: 'advanced', rule: result.value.selectedFolder }; fields(); edit(true);
    }
    present();
  });
  present();
  return { element, present, refresh, flush: () => { void save(); },
    dispose() {
      void save(); disposed = true; clearTimeout(previewTimer); clearTimeout(saveTimer);
      window.removeEventListener('resize', positionHints); window.removeEventListener('scroll', positionHints, true);
      element.remove();
    } };
}
