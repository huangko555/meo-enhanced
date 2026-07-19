import { createElement, Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, List, ListOrdered, ListTodo, ListTree, Hash, Code, Terminal, Quote, Minus, Table2, Link, Brackets, Image, Bold, Italic, Strikethrough, Search, FileCode2, FileText, Save, GitCompare, PanelLeftRightDashed, SpellCheck2, CornerDownLeft, Settings2, UserRound, Check } from 'lucide';
import { setImageSrcResolver, initializeImageHandling, resolveImageSrc, settleImageSrcRequest, handleSavedImagePath, handleImagePaste } from './helpers/images';
import { createGitClient } from './helpers/gitClient';
import { createOutlineController } from './helpers/outline';
import { normalizeWikiTarget, replaceWikiLinkStatuses, initializeWikiLinkHandling, collectWikiLinkTargets, requestWikiLinkStatuses, scheduleWikiLinkStatusRefresh, setWikiLinkRefreshContext, cancelPendingWikiStatusRefresh, handleResolvedWikiLinks } from './helpers/wikiLinks';
import { initializeLocalLinkHandling, requestLocalLinkStatuses, scheduleLocalLinkStatusRefresh, setLocalLinkRefreshContext, cancelPendingLocalLinkStatusRefresh, handleResolvedLocalLinks } from './helpers/localLinks';
import { setGitDiffLineHighlightsEnabled } from './helpers/gitDiffLineHighlights';
import { applyThemeSettings } from './helpers/theme';
import { setShikiTheme, setShikiEnabled } from './helpers/shikiHighlighter';
import { createFailureNoticeManager, getErrorMessage, isTransientMermaidRuntimeError, shouldAutoFallbackToSourceForLiveError, logWebviewRenderError, type FailureNoticeManager } from './helpers/errors';
import { isPrimaryModifier, isShortcutKey, normalizeEol, handleEditorShortcut, type ShortcutHandlerContext } from './helpers/shortcuts';
import { createFindPanel, createFindPanelController, type FindPanelController } from './helpers/findPanel';
import { createSelectionMenu, createSelectionMenuController, type SelectionMenuController } from './helpers/selectionMenu';
import { createExportHandler, type ExportHandlerContext } from './helpers/export';
import { refreshMermaidTheme } from './helpers/mermaidDiagram';
import { isAcceptedLineJumpInput, parseLineJumpTarget } from './helpers/lineJump';
import { reconcileExternalDocument } from './helpers/documentSync';
import { createEditorNoticeController } from './helpers/notices';
import { createPreviewController } from './helpers/preview';

type CreateEditorFactory = (typeof import('./editor'))['createEditor'];

type CompatibleVsCodeWebviewApi = {
  postMessage: (message: WebviewMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

function createCompatibleVsCodeApi(): CompatibleVsCodeWebviewApi {
  const hostApi = acquireVsCodeApi();
  let fallbackState: unknown;

  const getState = (): unknown => {
    if (typeof hostApi.getState !== 'function') {
      return fallbackState;
    }

    try {
      const hostState = hostApi.getState();
      if (hostState !== undefined) {
        fallbackState = hostState;
      }
      return hostState;
    } catch {
      return fallbackState;
    }
  };

  const setState = (state: unknown): void => {
    fallbackState = state;
    if (typeof hostApi.setState !== 'function') {
      return;
    }

    try {
      hostApi.setState(state);
    } catch {
      // Keep session-local fallback state when host persistence is unavailable.
    }
  };

  return {
    postMessage: (message: WebviewMessage) => hostApi.postMessage(message),
    getState,
    setState
  };
}

const vscode = createCompatibleVsCodeApi();
initializeImageHandling(vscode);
initializeWikiLinkHandling(vscode);
initializeLocalLinkHandling(vscode);

applyThemeSettings();
setImageSrcResolver(resolveImageSrc);

const root = document.getElementById('app');

if (!root) {
  throw new Error('Webview root element not found');
}

root.classList.add('editor-root');

const existingToolbar = root.querySelector('.mode-toolbar');
const toolbar = existingToolbar instanceof HTMLElement ? existingToolbar : document.createElement('div');
toolbar.className = 'mode-toolbar';
toolbar.classList.remove('meo-preload-toolbar');
toolbar.removeAttribute('aria-hidden');
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', 'Editor toolbar');

const formatGroup = document.createElement('div');
formatGroup.className = 'format-group';
formatGroup.setAttribute('role', 'group');
formatGroup.setAttribute('aria-label', 'Formatting');

const headingBtn = document.createElement('button');
headingBtn.type = 'button';
headingBtn.className = 'format-button';
headingBtn.dataset.action = 'heading';
headingBtn.title = 'Heading';
headingBtn.appendChild(createElement(Heading, { width: 18, height: 18 }));

const headingDropdown = document.createElement('div');
headingDropdown.className = 'heading-dropdown';
headingDropdown.setAttribute('role', 'menu');
headingDropdown.setAttribute('aria-label', 'Heading levels');

const headingDropdownWrapper = document.createElement('div');
headingDropdownWrapper.className = 'heading-dropdown-wrapper';

const headingIcons = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6];

for (let level = 1; level <= 6; level++) {
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'heading-dropdown-option';
  option.dataset.level = String(level);
  option.title = `Heading ${level}`;
  option.appendChild(createElement(headingIcons[level - 1], { width: 18, height: 18 }));
  headingDropdown.appendChild(option);
}

headingDropdownWrapper.appendChild(headingDropdown);

const headingWrapper = document.createElement('div');
headingWrapper.className = 'heading-wrapper';
headingWrapper.append(headingBtn, headingDropdownWrapper);

const bulletListBtn = document.createElement('button');
bulletListBtn.type = 'button';
bulletListBtn.className = 'format-button';
bulletListBtn.dataset.action = 'bulletList';
bulletListBtn.title = 'Bullet List';
bulletListBtn.appendChild(createElement(List, { width: 18, height: 18 }));

const numberedListBtn = document.createElement('button');
numberedListBtn.type = 'button';
numberedListBtn.className = 'format-button';
numberedListBtn.dataset.action = 'numberedList';
numberedListBtn.title = 'Numbered List';
numberedListBtn.appendChild(createElement(ListOrdered, { width: 18, height: 18 }));

const taskBtn = document.createElement('button');
taskBtn.type = 'button';
taskBtn.className = 'format-button';
taskBtn.dataset.action = 'task';
taskBtn.title = 'Task';
taskBtn.appendChild(createElement(ListTodo, { width: 18, height: 18 }));

let vimModeEnabled = false;
let vimKeybindingsState: VimKeybinding[] = [];
let vimLeaderState = '\\';

let lineNumbersVisible = true;
let gitChangesGutterVisible = true;
let gitBlameEnabled = false;
let gitDiffLineHighlightsEnabled = true;
let diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head' = 'current-edit';
let spellCheckEnabled = true;
let contentMaxWidthEnabled = false;
let outlineUiState: { mode: 'floating' | 'fixed'; width: number } = { mode: 'fixed', width: 260 };

const CONTENT_MAX_WIDTH_ENABLED_VALUE = '800px';

const createOutlineButton = (position: 'left' | 'right') => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'format-button toggle-button';
  button.dataset.action = `outline-${position}`;
  button.title = `Show Outline on ${position === 'left' ? 'Left' : 'Right'}`;
  button.setAttribute('aria-label', button.title);
  button.appendChild(createElement(ListTree, { width: 18, height: 18 }));
  return button;
};

const outlineLeftBtn = createOutlineButton('left');
const previewOutlineLeftBtn = createOutlineButton('left');
previewOutlineLeftBtn.classList.add('preview-outline-button');
const outlineBtn = createOutlineButton('right');

const appendMoreToolsOptionContent = (
  button: HTMLButtonElement,
  icon: Parameters<typeof createElement>[0],
  labelText: string
) => {
  const iconElement = document.createElement('span');
  iconElement.className = 'more-tools-option-icon';
  iconElement.appendChild(createElement(icon, { width: 16, height: 16 }));
  const label = document.createElement('span');
  label.className = 'more-tools-option-label';
  label.textContent = labelText;
  const check = document.createElement('span');
  check.className = 'more-tools-option-check';
  check.appendChild(createElement(Check, { width: 14, height: 14 }));
  button.append(iconElement, label, check);
};

const contentMaxWidthBtn = document.createElement('button');
contentMaxWidthBtn.type = 'button';
contentMaxWidthBtn.className = 'more-tools-option more-tools-toggle-option';
contentMaxWidthBtn.dataset.action = 'contentMaxWidth';
contentMaxWidthBtn.title = 'Constrain Content Width';
contentMaxWidthBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(contentMaxWidthBtn, PanelLeftRightDashed, 'Constrain Width');

const lineNumbersBtn = document.createElement('button');
lineNumbersBtn.type = 'button';
lineNumbersBtn.className = 'more-tools-option more-tools-toggle-option is-active';
lineNumbersBtn.dataset.action = 'lineNumbers';
lineNumbersBtn.title = 'Hide Line Numbers';
lineNumbersBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(lineNumbersBtn, Hash, 'Line Numbers');

const gitChangesGutterBtn = document.createElement('button');
gitChangesGutterBtn.type = 'button';
gitChangesGutterBtn.className = 'format-button toggle-button is-active';
gitChangesGutterBtn.dataset.action = 'gitChangesGutter';
gitChangesGutterBtn.title = 'Hide Changes';
gitChangesGutterBtn.appendChild(createElement(GitCompare, { width: 18, height: 18 }));

const diffBaselineOptions = [
  { mode: 'current-edit', label: 'Current Edits' },
  { mode: 'recent-save', label: 'Recent Save' },
  { mode: 'git-head', label: 'Git HEAD' }
] as const;

const diffBaselineButtons: HTMLButtonElement[] = [];
for (const option of diffBaselineOptions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'more-tools-option changes-baseline-option';
  button.dataset.baselineMode = option.mode;
  button.setAttribute('role', 'menuitemradio');
  appendMoreToolsOptionContent(button, GitCompare, option.label);
  diffBaselineButtons.push(button);
}

const changesControls = document.createElement('div');
changesControls.className = 'changes-controls';
changesControls.append(gitChangesGutterBtn);

const spellCheckBtn = document.createElement('button');
spellCheckBtn.type = 'button';
spellCheckBtn.className = 'more-tools-option more-tools-toggle-option is-active';
spellCheckBtn.dataset.action = 'spellCheck';
spellCheckBtn.title = 'Disable Spellcheck';
spellCheckBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(spellCheckBtn, SpellCheck2, 'Spellcheck');

const gitBlameBtn = document.createElement('button');
gitBlameBtn.type = 'button';
gitBlameBtn.className = 'more-tools-option more-tools-toggle-option';
gitBlameBtn.dataset.action = 'gitBlame';
gitBlameBtn.title = 'Show Line Authors';
gitBlameBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(gitBlameBtn, UserRound, 'Line Authors');

const updateLineNumbersUI = () => {
  lineNumbersBtn.classList.toggle('is-active', lineNumbersVisible);
  lineNumbersBtn.setAttribute('aria-checked', lineNumbersVisible ? 'true' : 'false');
  lineNumbersBtn.title = lineNumbersVisible ? 'Hide Line Numbers' : 'Show Line Numbers';
};

const updateGitChangesGutterUI = () => {
  gitChangesGutterBtn.classList.toggle('is-active', gitChangesGutterVisible);
  gitChangesGutterBtn.setAttribute('aria-pressed', gitChangesGutterVisible ? 'true' : 'false');
  const modeLabel = diffBaselineOptions.find((option) => option.mode === diffBaselineMode)?.label ?? 'Changes';
  gitChangesGutterBtn.title = gitChangesGutterVisible ? `Hide Changes (${modeLabel})` : `Show Changes (${modeLabel})`;
  for (const option of diffBaselineButtons) {
    const active = option.dataset.baselineMode === diffBaselineMode;
    option.classList.toggle('is-active', active);
    option.setAttribute('aria-checked', active ? 'true' : 'false');
  }
};

const setDiffBaselineMode = (
  mode: 'current-edit' | 'recent-save' | 'git-head',
  { post = true }: { post?: boolean } = {}
) => {
  if (mode !== 'current-edit' && mode !== 'recent-save' && mode !== 'git-head') {
    return;
  }
  const changed = mode !== diffBaselineMode;
  diffBaselineMode = mode;
  updateGitChangesGutterUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setDiffBaselineMode', mode });
  }
};

const updateSpellCheckUI = () => {
  spellCheckBtn.classList.toggle('is-active', spellCheckEnabled);
  spellCheckBtn.setAttribute('aria-checked', spellCheckEnabled ? 'true' : 'false');
  spellCheckBtn.title = spellCheckEnabled ? 'Disable Spellcheck' : 'Enable Spellcheck';
};

const updateGitBlameUI = () => {
  gitBlameBtn.classList.toggle('is-active', gitBlameEnabled);
  gitBlameBtn.setAttribute('aria-checked', gitBlameEnabled ? 'true' : 'false');
  gitBlameBtn.title = gitBlameEnabled ? 'Hide Line Authors' : 'Show Line Authors';
  gitBlameBtn.setAttribute('aria-label', gitBlameBtn.title);
};

const updateContentMaxWidthUI = () => {
  contentMaxWidthBtn.classList.toggle('is-active', contentMaxWidthEnabled);
  contentMaxWidthBtn.setAttribute('aria-checked', contentMaxWidthEnabled ? 'true' : 'false');
  contentMaxWidthBtn.title = contentMaxWidthEnabled ? 'Disable Constrained Width' : 'Constrain Content Width';
};

const syncGitDiffLineHighlights = () => {
  if (!editor) {
    return;
  }
  setGitDiffLineHighlightsEnabled(
    editor,
    currentMode === 'source' && gitChangesGutterVisible && gitDiffLineHighlightsEnabled
  );
};

const setLineNumbersVisible = (visible, { post = true } = {}) => {
  const nextVisible = visible !== false;
  const changed = nextVisible !== lineNumbersVisible;
  if (changed) {
    lineNumbersVisible = nextVisible;
    editor?.setLineNumbers(lineNumbersVisible);
  }
  updateLineNumbersUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setLineNumbers', visible: lineNumbersVisible });
  }
};

const setGitChangesGutterVisible = (visible, { post = true } = {}) => {
  const nextVisible = visible !== false;
  const changed = nextVisible !== gitChangesGutterVisible;
  if (changed) {
    gitChangesGutterVisible = nextVisible;
    editor?.setGitGutterVisible(gitChangesGutterVisible);
    syncGitDiffLineHighlights();
  }
  updateGitChangesGutterUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setGitChangesGutter', visible: gitChangesGutterVisible });
  }
};

const setSpellCheckEnabled = (enabled, { post = true } = {}) => {
  const nextEnabled = enabled !== false;
  const changed = nextEnabled !== spellCheckEnabled;
  if (changed) {
    spellCheckEnabled = nextEnabled;
  }
  updateSpellCheckUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setSpellCheck', enabled: spellCheckEnabled });
  }
};

const setGitBlameEnabled = (enabled, { post = true } = {}) => {
  const nextEnabled = enabled === true;
  const changed = nextEnabled !== gitBlameEnabled;
  gitBlameEnabled = nextEnabled;
  editor?.setGitBlameEnabled(gitBlameEnabled);
  if (!gitBlameEnabled) {
    clearGitBlameCache();
  }
  updateGitBlameUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setGitBlame', enabled: gitBlameEnabled });
  }
};

const setContentMaxWidthEnabled = (enabled, { post = true, persist = true } = {}) => {
  const nextEnabled = enabled === true;
  const changed = nextEnabled !== contentMaxWidthEnabled;
  if (changed) {
    contentMaxWidthEnabled = nextEnabled;
  }
  document.documentElement.classList.toggle('meo-content-max-width-enabled', contentMaxWidthEnabled);
  if (contentMaxWidthEnabled) {
    document.documentElement.style.setProperty('--meo-content-max-width', CONTENT_MAX_WIDTH_ENABLED_VALUE);
  } else {
    document.documentElement.style.removeProperty('--meo-content-max-width');
  }
  updateContentMaxWidthUI();
  if (persist) {
    persistUiState();
  }
  if (post && changed) {
    vscode.postMessage({ type: 'setContentMaxWidth', enabled: contentMaxWidthEnabled });
  }
};

const setOutlineVisible = (visible, { post = true } = {}) => {
  const nextVisible = visible === true;
  const changed = nextVisible !== outlineController.isVisible();
  outlineController.setVisible(nextVisible);
  if (post && changed) {
    vscode.postMessage({ type: 'setOutlineVisible', visible: nextVisible });
  }
};

const setVimModeEnabled = (enabled) => {
  const nextEnabled = enabled === true;
  if (nextEnabled === vimModeEnabled) {
    return;
  }
  vimModeEnabled = nextEnabled;
  editor?.setVimMode(vimModeEnabled);
};

const toggleLineNumbers = () => {
  setLineNumbersVisible(!lineNumbersVisible);
};

const toggleGitChangesGutter = () => {
  setGitChangesGutterVisible(!gitChangesGutterVisible);
};

const toggleSpellCheck = () => {
  setSpellCheckEnabled(!spellCheckEnabled);
};

const toggleGitBlame = () => {
  setGitBlameEnabled(!gitBlameEnabled);
};

const separator = document.createElement('div');
separator.className = 'format-separator';
separator.setAttribute('role', 'separator');

const codeBlockBtn = document.createElement('button');
codeBlockBtn.type = 'button';
codeBlockBtn.className = 'format-button';
codeBlockBtn.dataset.action = 'codeBlock';
codeBlockBtn.title = 'Code Block';
codeBlockBtn.appendChild(createElement(Code, { width: 18, height: 18 }));

const quoteBtn = document.createElement('button');
quoteBtn.type = 'button';
quoteBtn.className = 'format-button';
quoteBtn.dataset.action = 'quote';
quoteBtn.title = 'Quote';
quoteBtn.appendChild(createElement(Quote, { width: 18, height: 18 }));

const hrBtn = document.createElement('button');
hrBtn.type = 'button';
hrBtn.className = 'format-button';
hrBtn.dataset.action = 'hr';
hrBtn.title = 'Horizontal Rule';
hrBtn.appendChild(createElement(Minus, { width: 18, height: 18 }));

const linkBtn = document.createElement('button');
linkBtn.type = 'button';
linkBtn.className = 'format-button';
linkBtn.dataset.action = 'link';
linkBtn.title = 'Link';
linkBtn.appendChild(createElement(Link, { width: 18, height: 18 }));

const wikiLinkBtn = document.createElement('button');
wikiLinkBtn.type = 'button';
wikiLinkBtn.className = 'format-button';
wikiLinkBtn.dataset.action = 'wikiLink';
wikiLinkBtn.title = 'Wiki Link';
wikiLinkBtn.appendChild(createElement(Brackets, { width: 18, height: 18 }));

const imageBtn = document.createElement('button');
imageBtn.type = 'button';
imageBtn.className = 'format-button';
imageBtn.dataset.action = 'image';
imageBtn.title = 'Image';
imageBtn.appendChild(createElement(Image, { width: 18, height: 18 }));

const tableBtn = document.createElement('button');
tableBtn.type = 'button';
tableBtn.className = 'format-button';
tableBtn.dataset.action = 'table';
tableBtn.title = 'Table';
tableBtn.appendChild(createElement(Table2, { width: 18, height: 18 }));

const tableDropdown = document.createElement('div');
tableDropdown.className = 'table-dropdown';

const tableDropdownWrapper = document.createElement('div');
tableDropdownWrapper.className = 'table-dropdown-wrapper';

const tableGrid = document.createElement('div');
tableGrid.className = 'table-grid';

const gridSize = 5;
for (let row = 0; row < gridSize; row++) {
  for (let col = 0; col < gridSize; col++) {
    const cell = document.createElement('div');
    cell.className = 'table-grid-cell';
    cell.dataset.row = String(row + 1);
    cell.dataset.col = String(col + 1);
    if (row === 0 && col === 0) {
      cell.classList.add('is-highlighted');
    }
    tableGrid.appendChild(cell);
  }
}

const tableSizeLabel = document.createElement('div');
tableSizeLabel.className = 'table-size-label';
tableSizeLabel.textContent = '1 x 1';

tableDropdown.append(tableGrid, tableSizeLabel);
tableDropdownWrapper.appendChild(tableDropdown);

const tableWrapper = document.createElement('div');
tableWrapper.className = 'table-wrapper';
tableWrapper.append(tableBtn, tableDropdownWrapper);

let selectedTableCols = 1;
let selectedTableRows = 1;

const updateTableGridHighlight = (hoveredCol: number, hoveredRow: number) => {
  const cells = tableGrid.querySelectorAll('.table-grid-cell');
  cells.forEach((cell) => {
    const cellCol = parseInt((cell as HTMLElement).dataset.col ?? '', 10);
    const cellRow = parseInt((cell as HTMLElement).dataset.row ?? '', 10);
    cell.classList.toggle('is-highlighted', cellCol <= hoveredCol && cellRow <= hoveredRow);
  });
  tableSizeLabel.textContent = `${hoveredCol} x ${hoveredRow}`;
  selectedTableCols = hoveredCol;
  selectedTableRows = hoveredRow;
};

tableGrid.addEventListener('mouseover', (event) => {
  const cell = (event.target as Element).closest('.table-grid-cell') as HTMLElement | null;
  if (!cell) return;
  const col = parseInt(cell.dataset.col ?? '', 10);
  const row = parseInt(cell.dataset.row ?? '', 10);
  updateTableGridHighlight(col, row);
});

tableGrid.addEventListener('mouseleave', () => {
  updateTableGridHighlight(1, 1);
});

tableGrid.addEventListener('click', (event) => {
  const cell = (event.target as Element).closest('.table-grid-cell') as HTMLElement | null;
  if (!cell || !editor) return;
  editor.insertFormat('table', { cols: selectedTableCols, rows: selectedTableRows });
  editor.focus();
});

const lineJumpControl = document.createElement('div');
lineJumpControl.className = 'line-jump-control';

const lineJumpInput = document.createElement('input');
lineJumpInput.className = 'line-jump-input';
lineJumpInput.type = 'text';
lineJumpInput.placeholder = 'Line';
lineJumpInput.inputMode = 'numeric';
lineJumpInput.autocomplete = 'off';
lineJumpInput.spellcheck = false;
lineJumpInput.setAttribute('aria-label', 'Go to line');

const lineJumpButton = document.createElement('button');
lineJumpButton.type = 'button';
lineJumpButton.className = 'line-jump-button';
lineJumpButton.title = 'Go to line';
lineJumpButton.setAttribute('aria-label', 'Go to line');
lineJumpButton.hidden = true;
lineJumpButton.appendChild(createElement(CornerDownLeft, { width: 14, height: 14 }));
lineJumpControl.append(lineJumpInput, lineJumpButton);

let acceptedLineJumpInput = '';

const clearLineJumpError = () => {
  lineJumpControl.classList.remove('is-error');
  lineJumpInput.removeAttribute('aria-invalid');
};

const syncLineJumpInput = () => {
  const hasValue = lineJumpInput.value.length > 0;
  lineJumpControl.classList.toggle('has-value', hasValue);
  lineJumpButton.hidden = !hasValue;
  clearLineJumpError();
};

const clearLineJumpInput = () => {
  acceptedLineJumpInput = '';
  lineJumpInput.value = '';
  syncLineJumpInput();
};

const failLineJump = () => {
  lineJumpControl.classList.add('is-error');
  lineJumpInput.setAttribute('aria-invalid', 'true');
  lineJumpInput.focus();
};

const submitLineJump = () => {
  const totalLines = editor?.view?.state?.doc?.lines ?? 0;
  const targetLine = parseLineJumpTarget(lineJumpInput.value, totalLines);
  if (targetLine === null || !editor) {
    failLineJump();
    return;
  }

  editor.scrollToLine(targetLine, 'upper');
  clearLineJumpInput();
  lineJumpInput.blur();
};

lineJumpInput.addEventListener('beforeinput', (event: InputEvent) => {
  if (event.inputType.startsWith('delete')) {
    return;
  }
  const selectionStart = lineJumpInput.selectionStart ?? lineJumpInput.value.length;
  const selectionEnd = lineJumpInput.selectionEnd ?? selectionStart;
  const nextValue = lineJumpInput.value.slice(0, selectionStart) +
    (event.data ?? '') +
    lineJumpInput.value.slice(selectionEnd);
  if (!isAcceptedLineJumpInput(nextValue)) {
    event.preventDefault();
  }
});

lineJumpInput.addEventListener('input', () => {
  if (!isAcceptedLineJumpInput(lineJumpInput.value)) {
    lineJumpInput.value = acceptedLineJumpInput;
    lineJumpInput.setSelectionRange(lineJumpInput.value.length, lineJumpInput.value.length);
    return;
  }
  acceptedLineJumpInput = lineJumpInput.value;
  syncLineJumpInput();
});

lineJumpInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && lineJumpInput.value) {
    event.preventDefault();
    submitLineJump();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    clearLineJumpInput();
    lineJumpInput.blur();
  }
});

lineJumpInput.addEventListener('blur', (event) => {
  if (!lineJumpControl.contains(event.relatedTarget as Node | null)) {
    clearLineJumpInput();
  }
});

lineJumpButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
});
lineJumpButton.addEventListener('click', submitLineJump);

document.addEventListener('pointerdown', (event) => {
  if (!lineJumpControl.contains(event.target as Node)) {
    clearLineJumpInput();
    lineJumpInput.blur();
  }
}, true);

const outlineLeftSeparator = document.createElement('div');
outlineLeftSeparator.className = 'format-separator';
outlineLeftSeparator.setAttribute('role', 'separator');

const saveBtn = document.createElement('button');
saveBtn.type = 'button';
saveBtn.className = 'format-button';
saveBtn.dataset.action = 'save';
saveBtn.title = 'Save (Ctrl+S)';
saveBtn.setAttribute('aria-label', 'Save document');
saveBtn.appendChild(createElement(Save, { width: 18, height: 18 }));

formatGroup.append(
  outlineLeftBtn,
  lineJumpControl,
  saveBtn,
  outlineLeftSeparator,
  headingWrapper,
  bulletListBtn,
  numberedListBtn,
  taskBtn,
  separator,
  tableWrapper,
  codeBlockBtn,
  linkBtn,
  wikiLinkBtn,
  imageBtn,
  quoteBtn,
  hrBtn
);

const rightGroup = document.createElement('div');
rightGroup.className = 'right-group';

const findToggleBtn = document.createElement('button');
findToggleBtn.type = 'button';
findToggleBtn.className = 'format-button toggle-button';
findToggleBtn.dataset.action = 'find';
findToggleBtn.title = 'Find and Replace';
findToggleBtn.appendChild(createElement(Search, { width: 18, height: 18 }));

const exportHtmlOption = document.createElement('button');
exportHtmlOption.type = 'button';
exportHtmlOption.className = 'preview-toolbar-action';
exportHtmlOption.dataset.format = 'html';
exportHtmlOption.title = 'Export as HTML';
exportHtmlOption.append(
  createElement(FileCode2, { width: 15, height: 15, 'aria-hidden': 'true' }),
  document.createTextNode('Export HTML')
);

const exportPdfOption = document.createElement('button');
exportPdfOption.type = 'button';
exportPdfOption.className = 'preview-toolbar-action';
exportPdfOption.dataset.format = 'pdf';
exportPdfOption.title = 'Export as PDF';
exportPdfOption.append(
  createElement(FileText, { width: 15, height: 15, 'aria-hidden': 'true' }),
  document.createTextNode('Export PDF')
);

const previewAppearanceSlot = document.createElement('span');
const previewFormatGroup = document.createElement('div');
previewFormatGroup.className = 'preview-format-group';
previewFormatGroup.setAttribute('role', 'group');
previewFormatGroup.setAttribute('aria-label', 'Preview tools');
previewFormatGroup.append(
  previewOutlineLeftBtn,
  previewAppearanceSlot,
  exportHtmlOption,
  exportPdfOption
);

const moreToolsButton = document.createElement('button');
moreToolsButton.type = 'button';
moreToolsButton.className = 'format-button';
moreToolsButton.title = 'More';
moreToolsButton.setAttribute('aria-label', 'More tools');
moreToolsButton.setAttribute('aria-haspopup', 'menu');
moreToolsButton.setAttribute('aria-expanded', 'false');
moreToolsButton.appendChild(createElement(Settings2, { width: 18, height: 18 }));

const moreToolsPanel = document.createElement('div');
moreToolsPanel.className = 'more-tools-panel';
moreToolsPanel.setAttribute('role', 'menu');
moreToolsPanel.setAttribute('aria-label', 'More tools');
moreToolsPanel.hidden = true;
const changesSeparator = document.createElement('div');
changesSeparator.className = 'more-tools-separator';
changesSeparator.setAttribute('role', 'separator');
moreToolsPanel.append(
  ...diffBaselineButtons,
  changesSeparator,
  contentMaxWidthBtn,
  lineNumbersBtn,
  gitBlameBtn,
  spellCheckBtn
);

const moreToolsWrapper = document.createElement('div');
moreToolsWrapper.className = 'more-tools-wrapper';
moreToolsWrapper.append(moreToolsButton, moreToolsPanel);

const setMoreToolsVisible = (visible: boolean) => {
  moreToolsPanel.hidden = !visible;
  moreToolsButton.classList.toggle('is-active', visible);
  moreToolsButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
};

moreToolsButton.addEventListener('click', () => {
  setMoreToolsVisible(moreToolsPanel.hidden);
});

document.addEventListener('pointerdown', (event) => {
  if (!moreToolsWrapper.contains(event.target as Node)) {
    setMoreToolsVisible(false);
  }
}, true);

rightGroup.append(
  findToggleBtn,
  outlineBtn,
  changesControls,
  moreToolsWrapper
);

moreToolsPanel.addEventListener('click', (event) => {
  const option = (event.target as Element).closest<HTMLElement>('.changes-baseline-option');
  const mode = option?.dataset.baselineMode;
  if (mode === 'current-edit' || mode === 'recent-save' || mode === 'git-head') {
    setDiffBaselineMode(mode);
  }
});

const modeGroup = document.createElement('div');
modeGroup.className = 'mode-group';
modeGroup.setAttribute('role', 'tablist');
modeGroup.setAttribute('aria-label', 'Markdown mode');

const liveButton = document.createElement('button');
liveButton.type = 'button';
liveButton.className = 'mode-button';
liveButton.dataset.mode = 'live';
liveButton.textContent = 'Live';
liveButton.setAttribute('role', 'tab');
liveButton.title = 'Live';

const sourceButton = document.createElement('button');
sourceButton.type = 'button';
sourceButton.className = 'mode-button';
sourceButton.dataset.mode = 'source';
sourceButton.textContent = 'Source';
sourceButton.setAttribute('role', 'tab');
sourceButton.title = 'Source';

const previewButton = document.createElement('button');
previewButton.type = 'button';
previewButton.className = 'mode-button';
previewButton.dataset.mode = 'preview';
previewButton.textContent = 'Preview';
previewButton.setAttribute('role', 'tab');
previewButton.title = 'Preview';

modeGroup.append(liveButton, sourceButton, previewButton);

const findPanelElements = createFindPanel(findToggleBtn);
const findPanelController = createFindPanelController(
  findPanelElements,
  () => currentMode === 'preview' ? previewController.getSearchAdapter() : editor,
  toolbar,
  modeGroup
);

const selectionMenuElements = createSelectionMenu();
const selectionMenuController = createSelectionMenuController(selectionMenuElements, () => editor);

const editorNoticeBanner = document.createElement('div');
editorNoticeBanner.className = 'editor-notice';
editorNoticeBanner.setAttribute('role', 'status');
editorNoticeBanner.setAttribute('aria-live', 'polite');
editorNoticeBanner.hidden = true;
let handleEditorNoticeDismiss = (): void => {};
const editorNotice = createEditorNoticeController(editorNoticeBanner, () => handleEditorNoticeDismiss());

toolbar.replaceChildren(formatGroup, previewFormatGroup, rightGroup, modeGroup, findPanelElements.panel, editorNoticeBanner);

const existingEditorWrapper = root.querySelector('.editor-wrapper');
const editorWrapper = existingEditorWrapper instanceof HTMLElement ? existingEditorWrapper : document.createElement('div');
editorWrapper.className = 'editor-wrapper';
editorWrapper.classList.remove('meo-preload-editor-shell');
editorWrapper.removeAttribute('aria-hidden');

const existingEditorHost = editorWrapper.querySelector('.editor-host');
const editorHost = existingEditorHost instanceof HTMLElement ? existingEditorHost : document.createElement('div');
editorHost.className = 'editor-host';

let editor: any = null;
let outlineController: ReturnType<typeof createOutlineController>;
const previewController = createPreviewController({
  vscode,
  onFindRequested: () => findPanelController.open('find'),
  onRendered: () => {
    if (outlineController?.isVisible()) {
      outlineController.refresh();
    }
  }
});
previewAppearanceSlot.replaceWith(previewController.appearanceControl);
outlineController = createOutlineController({
  root,
  editorWrapper,
  outlineButton: outlineBtn,
  outlineLeftButton: outlineLeftBtn,
  additionalOutlineLeftButtons: [previewOutlineLeftBtn],
  getEditor: () => currentMode === 'preview' ? previewController.getOutlineAdapter() : editor,
  canReorder: () => currentMode !== 'preview',
  onVisibilityRequest: (visible) => {
    vscode.postMessage({ type: 'setOutlineVisible', visible });
  },
  onPositionRequest: (position) => {
    vscode.postMessage({ type: 'setOutlinePosition', position });
  },
  onResizeEnd: () => {
    if (currentMode === 'preview') {
      previewController.focus();
    } else {
      editor?.focus();
    }
  },
  onUiStateChange: (state) => {
    const widthChanged = state.width !== outlineUiState.width;
    outlineUiState = state;
    persistUiState();
    if (widthChanged) {
      vscode.postMessage({ type: 'setOutlineWidth', width: state.width });
    }
  }
});

editorWrapper.replaceChildren(editorHost, previewController.host, outlineController.sidebar, selectionMenuElements.menu);
root.replaceChildren(toolbar, editorWrapper);

let documentVersion = 0;
let pendingDebounce: number | null = null;
let pendingText: string | null = null;
let syncedText = '';
let inFlight = false;
let inFlightText: string | null = null;
let saveAfterSync = false;
let currentMode: 'live' | 'source' | 'preview' = 'live';
let lastEditableMode: 'live' | 'source' = 'live';
let hasLocalModePreference = false;
let pendingInitialText: string | null = null;
let initialEditorMountQueued = false;
let initialMountRecoveryAttempted = false;
let modeToggleShouldRestoreEditorFocus = false;
let gitClient: any = null;
let pendingEditorFocus = false;
let pendingDiagnostics: any[] = [];
let diagnosticSuggestionRequestCounter = 0;
const pendingDiagnosticSuggestionRequests = new Map<string, { from: number; to: number }>();
let pendingRevealSelection: { anchor: number; head: number; focus?: boolean } | null = null;
let pendingRestoreTopLine: number | null = null;
let pendingRestoreTopLineOffset = 0;
let pendingViewPositionTimer: number | null = null;
let lastSentTopLine: number | null = null;
let lastSentTopLineOffset: number | null = null;
let lastSentDraftText: string | null = null;
let hasSentDraftText = false;
let initialEditorMountInFlight = false;
let initialEditorMountFallbackTimer: number | null = null;
let pendingEditorSurfaceRecoveryRaf: number | null = null;
let createEditorFactoryPromise: Promise<CreateEditorFactory> | null = null;
const VIEW_POSITION_DEBOUNCE_MS = 250;
const INITIAL_EDITOR_MOUNT_FALLBACK_MS = 120;

const failureNotice = createFailureNoticeManager(editorNotice);
handleEditorNoticeDismiss = failureNotice.clearFailureNotice;

const clearGitBlameCache = ({ hideTooltip = true } = {}) => {
  gitClient?.clearBlameCache({ hideTooltip });
};

const bumpLocalEditGeneration = () => {
  gitClient?.bumpLocalEditGeneration();
};

const loadCreateEditorFactory = async (): Promise<CreateEditorFactory> => {
  if (!createEditorFactoryPromise) {
    createEditorFactoryPromise = import('./editor')
      .then((mod) => mod.createEditor)
      .catch((error) => {
        createEditorFactoryPromise = null;
        throw error;
      });
  }

  return createEditorFactoryPromise;
};

let editorBundleWarmupScheduled = false;

const scheduleEditorBundleWarmupAfterReady = () => {
  if (editorBundleWarmupScheduled) {
    return;
  }
  editorBundleWarmupScheduled = true;

  const warm = () => {
    // Wait one frame after full document readiness before warming the heavy editor bundle.
    window.requestAnimationFrame(() => {
      void loadCreateEditorFactory().catch((error) => {
        logWebviewRenderError('warmEditorBundleAfterReady', error);
      });
    });
  };

  if (document.readyState === 'complete') {
    warm();
    return;
  }

  window.addEventListener('load', warm, { once: true });
};

const READY_RETRY_DELAYS_MS = [120, 300, 700, 1300] as const;
let readyHandshakeAcknowledged = false;
const readyRetryTimers = new Set<number>();

const clearReadyRetryTimers = () => {
  for (const timer of readyRetryTimers) {
    window.clearTimeout(timer);
  }
  readyRetryTimers.clear();
};

const postReadyMessage = () => {
  if (readyHandshakeAcknowledged) {
    return;
  }
  vscode.postMessage({ type: 'ready' });
};

const scheduleReadyHandshake = () => {
  postReadyMessage();
  for (const delayMs of READY_RETRY_DELAYS_MS) {
    const timer = window.setTimeout(() => {
      readyRetryTimers.delete(timer);
      postReadyMessage();
    }, delayMs);
    readyRetryTimers.add(timer);
  }
};

const acknowledgeReadyHandshake = () => {
  readyHandshakeAcknowledged = true;
  clearReadyRetryTimers();
};

type WebviewUiState = {
  mode?: 'live' | 'source' | 'preview';
  lastEditableMode?: 'live' | 'source';
  contentMaxWidthEnabled?: boolean;
  outlineMode?: 'floating' | 'fixed';
  outlineWidth?: number;
};

const persistUiState = () => {
  const state: WebviewUiState = {
    mode: currentMode,
    lastEditableMode,
    contentMaxWidthEnabled,
    outlineMode: outlineUiState.mode,
    outlineWidth: outlineUiState.width
  };
  vscode.setState(state);
};

const postFindOptions = () => {
  vscode.postMessage({
    type: 'setFindOptions',
    findOptions: findPanelController.getSearchOptions()
  });
};

const getCurrentEditorText = () => {
  if (editor) {
    return editor.getText();
  }
  if (typeof pendingText === 'string') {
    return pendingText;
  }
  if (typeof pendingInitialText === 'string') {
    return pendingInitialText;
  }
  return syncedText;
};

const commitEditorTransientEdits = () => {
  editor?.commitTransientEdits?.();
};

const syncPendingDraftState = () => {
  const draftText = pendingText ?? inFlightText;
  const nextDraftText =
    draftText === null || (!inFlight && normalizeEol(draftText) === syncedText)
      ? null
      : draftText;

  if (hasSentDraftText && nextDraftText === lastSentDraftText) {
    return;
  }

  hasSentDraftText = true;
  lastSentDraftText = nextDraftText;
  vscode.postMessage({ type: 'draftChanged', text: nextDraftText });
};

const normalizeLineNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.floor(value));
};

const normalizeLineOffset = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value * 100) / 100);
};

const getTopVisiblePosition = (): { topLine: number; topLineOffset: number } | null => {
  if (!editor) {
    return null;
  }
  if (typeof editor.getTopVisiblePosition === 'function') {
    const position = editor.getTopVisiblePosition();
    const topLine = normalizeLineNumber(position?.line);
    if (topLine === null) {
      return null;
    }
    return {
      topLine,
      topLineOffset: normalizeLineOffset(position?.lineOffset)
    };
  }
  if (typeof editor.getTopVisibleLine !== 'function') {
    return null;
  }
  const topLine = normalizeLineNumber(editor.getTopVisibleLine());
  if (topLine === null) {
    return null;
  }
  return {
    topLine,
    topLineOffset: 0
  };
};

const postTopVisiblePositionIfChanged = (position: { topLine: number; topLineOffset: number } | null): void => {
  if (!position) {
    return;
  }
  if (position.topLine === lastSentTopLine && position.topLineOffset === lastSentTopLineOffset) {
    return;
  }
  lastSentTopLine = position.topLine;
  lastSentTopLineOffset = position.topLineOffset;
  vscode.postMessage({
    type: 'viewPositionChanged',
    topLine: position.topLine,
    topLineOffset: position.topLineOffset
  });
};

const flushViewPositionNow = (): void => {
  if (pendingViewPositionTimer !== null) {
    window.clearTimeout(pendingViewPositionTimer);
    pendingViewPositionTimer = null;
  }
  postTopVisiblePositionIfChanged(getTopVisiblePosition());
};

const scheduleViewPositionCapture = (): void => {
  if (pendingViewPositionTimer !== null) {
    window.clearTimeout(pendingViewPositionTimer);
  }
  pendingViewPositionTimer = window.setTimeout(() => {
    pendingViewPositionTimer = null;
    postTopVisiblePositionIfChanged(getTopVisiblePosition());
  }, VIEW_POSITION_DEBOUNCE_MS);
};

const applyPendingRestoreTopLine = (): void => {
  if (!editor || pendingRestoreTopLine === null || pendingRevealSelection !== null) {
    return;
  }
  if (typeof editor.restoreTopLine === 'function') {
    editor.restoreTopLine(pendingRestoreTopLine, pendingRestoreTopLineOffset);
    pendingRestoreTopLine = null;
    pendingRestoreTopLineOffset = 0;
  }
};

const refreshEditorSurface = (): void => {
  if (!editor) {
    return;
  }
  if (typeof editor.refreshLayout === 'function') {
    editor.refreshLayout();
  }
};

const runEditorSurfaceRecovery = (): void => {
  pendingEditorSurfaceRecoveryRaf = null;
  refreshEditorSurface();
  applyPendingRestoreTopLine();
  scheduleViewPositionCapture();
};

const scheduleEditorSurfaceRecovery = (): void => {
  if (pendingEditorSurfaceRecoveryRaf !== null) {
    return;
  }
  pendingEditorSurfaceRecoveryRaf = window.requestAnimationFrame(runEditorSurfaceRecovery);
};

const clampRevealOffset = (value: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(value), max));
};

const applyRevealSelectionFromHost = (revealMessage: any) => {
  if (!revealMessage || typeof revealMessage !== 'object') {
    return;
  }

  const { anchor, head, focus, preserveViewport } = revealMessage;
  if (typeof anchor !== 'number' || typeof head !== 'number') {
    return;
  }

  if (!editor) {
    pendingRevealSelection = { anchor, head, focus };
    return;
  }

  const max = editor.getText().length;
  const clampedAnchor = clampRevealOffset(anchor, max);
  const clampedHead = clampRevealOffset(head, max);
  pendingRestoreTopLine = null;
  pendingRestoreTopLineOffset = 0;
  editor.revealSelection(clampedAnchor, clampedHead, {
    focusEditor: focus !== false,
    align: preserveViewport === true ? 'none' : 'center'
  });
  pendingRevealSelection = null;
  scheduleViewPositionCapture();
};

const focusEditorFromHost = () => {
  if (!editor) {
    pendingEditorFocus = true;
    return;
  }

  scheduleEditorSurfaceRecovery();
  editor.focus();
  pendingEditorFocus = false;
};

const applyDiagnosticsFromHost = (diagnostics: unknown): void => {
  const nextDiagnostics = Array.isArray(diagnostics) ? diagnostics : [];
  pendingDiagnostics = nextDiagnostics;
  pendingDiagnosticSuggestionRequests.clear();
  selectionMenuController.hide();
  editor?.setDiagnostics?.(nextDiagnostics);
};

const requestDiagnosticSuggestions = (diagnostic: {
  from: number;
  to: number;
  message: string;
  source?: string;
  code?: string;
}): string => {
  const requestId = `diagnostic-suggestions-${Date.now()}-${diagnosticSuggestionRequestCounter += 1}`;
  pendingDiagnosticSuggestionRequests.set(requestId, { from: diagnostic.from, to: diagnostic.to });
  vscode.postMessage({
    type: 'requestDiagnosticSuggestions',
    requestId,
    from: diagnostic.from,
    to: diagnostic.to,
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code
  });
  return requestId;
};

gitClient = createGitClient({
  vscode,
  getCurrentEditorText: () => getCurrentEditorText(),
  getSyncedText: () => syncedText,
  clearTransientUi: () => editor?.clearGitUiTransientState?.()
});

const requestGitBlameForLine = ({ lineNumber }: { lineNumber: number }) => {
  if (!gitBlameEnabled || !gitClient) {
    return Promise.resolve({ kind: 'unavailable', reason: 'error' });
  }
  return gitClient.requestBlameForLine({ lineNumber });
};

const openGitRevisionForLine = ({ lineNumber }: { lineNumber: number }) => {
  gitClient?.openRevisionForLine({ lineNumber });
};

const openGitWorktreeForLine = ({ lineNumber }: { lineNumber: number }) => {
  gitClient?.openWorktreeForLine({ lineNumber });
};

const flushChanges = () => {
  commitEditorTransientEdits();
  if (!editor || inFlight || pendingText === null || normalizeEol(pendingText) === syncedText) {
    return;
  }

  const nextText = pendingText;
  const message: WebviewMessage = {
    type: 'applyChanges',
    baseVersion: documentVersion,
    changes: [
      {
        from: 0,
        to: syncedText.length,
        insert: nextText
      }
    ]
  };

  inFlight = true;
  inFlightText = nextText;
  syncPendingDraftState();
  vscode.postMessage(message);
};

const flushPendingChangesNow = () => {
  commitEditorTransientEdits();
  if (pendingDebounce !== null) {
    window.clearTimeout(pendingDebounce);
    pendingDebounce = null;
  }

  flushChanges();
};

const maybeSaveAfterSync = () => {
  if (!saveAfterSync) {
    return;
  }

  if (inFlight) {
    return;
  }

  if (pendingText !== null && normalizeEol(pendingText) !== syncedText) {
    flushChanges();
    return;
  }

  saveAfterSync = false;
  vscode.postMessage({ type: 'saveDocument' });
};

const requestSave = async () => {
  commitEditorTransientEdits();
  saveAfterSync = true;
  flushPendingChangesNow();

  let retries = 0;
  while (inFlight && retries < 50) {
    await new Promise(resolve => window.setTimeout(resolve, 20));
    retries++;
  }

  maybeSaveAfterSync();
};

saveBtn.addEventListener('click', () => {
  void requestSave();
});

const setEditorTextSafely = (text: string, context: string): boolean => {
  if (!editor) {
    return false;
  }

  try {
    editor.setText(text);
    return true;
  } catch (error) {
    logWebviewRenderError('setText', error, { context });

    if (currentMode === 'live') {
      try {
        editor.setText(text);
        failureNotice.clearFailureNotice();
        return true;
      } catch (retryInLiveError) {
        logWebviewRenderError('setText.retryInLive', retryInLiveError, { context });
        if (!shouldAutoFallbackToSourceForLiveError(retryInLiveError)) {
          failureNotice.setFailureNotice('Live mode hit a transient render error while updating. Try again.', 'warning');
          return false;
        }
      }

      failureNotice.setFailureNotice(failureNotice.liveModeFailureMessage, 'warning');
      applyMode('source', { post: true, persist: false, reason: 'render-failure' });
      if (!editor) {
        return false;
      }
      try {
        editor.setText(text);
        return true;
      } catch (retryError) {
        logWebviewRenderError('setText.retryInSource', retryError, { context });
        failureNotice.setFailureNotice(failureNotice.editorUpdateFailureMessage, 'error');
        return false;
      }
    }

    failureNotice.setFailureNotice(failureNotice.editorUpdateFailureMessage, 'error');
    return false;
  }
};

const shortcutHandlerContext: ShortcutHandlerContext = {
  get editor() { return editor; },
  get currentMode() { return currentMode === 'preview' ? lastEditableMode : currentMode; },
  get vimModeEnabled() { return vimModeEnabled; },
  get pendingText() { return pendingText; },
  get syncedText() { return syncedText; },
  requestSave,
  openFindPanel: (target) => findPanelController.open(target),
  applyMode: (mode, options) => applyMode(mode, options),
  flushPendingChangesNow
};

const queueChanges = (nextText: string) => {
  bumpLocalEditGeneration();
  pendingText = nextText;
  syncPendingDraftState();

  if (pendingDebounce !== null) {
    window.clearTimeout(pendingDebounce);
  }

  pendingDebounce = window.setTimeout(() => {
    pendingDebounce = null;
    flushChanges();
  }, 100);

  if (outlineController.isVisible()) {
    outlineController.refresh();
  }
  scheduleWikiLinkStatusRefresh(nextText);
  scheduleLocalLinkStatusRefresh(nextText);
  findPanelController.updateFindStatusSummary();
};

const updateModeUI = () => {
  root.dataset.mode = currentMode;
  const replaceDisabled = currentMode === 'preview';
  for (const control of [
    findPanelElements.replaceInput,
    findPanelElements.replaceClearBtn,
    findPanelElements.replaceBtn,
    findPanelElements.replaceAllBtn
  ]) {
    control.disabled = replaceDisabled;
  }
  const buttons = [liveButton, sourceButton, previewButton];
  for (const button of buttons) {
    const selected = button.dataset.mode === currentMode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
};

const applyMode = (mode: 'live' | 'source' | 'preview', { post = true, persist = true, userTriggered = false, reason = 'user' } = {}): boolean => {
  if (mode !== 'live' && mode !== 'source' && mode !== 'preview') {
    return false;
  }

  commitEditorTransientEdits();
  const previousMode = currentMode;
  const transitionViewPosition = previousMode === 'preview'
    ? previewController.getTopVisiblePosition()
    : getTopVisiblePosition();
  const shouldRestoreEditorFocus = modeToggleShouldRestoreEditorFocus;
  modeToggleShouldRestoreEditorFocus = false;
  currentMode = mode;
  if (mode === 'live' || mode === 'source') {
    lastEditableMode = mode;
  }
  clearGitBlameCache();
  if (userTriggered) {
    hasLocalModePreference = true;
  }
  updateModeUI();

  previewController.setVisible(mode === 'preview');
  editorHost.hidden = mode === 'preview';

  if (mode === 'preview') {
    if (document.activeElement instanceof HTMLElement && editorHost.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    selectionMenuController.hide();
    findPanelController.close();
    previewController.requestRender(getCurrentEditorText(), {
      restoreLine: transitionViewPosition?.topLine ?? null
    });
    syncGitDiffLineHighlights();
    if (outlineController.isVisible()) {
      outlineController.refresh();
    }
  } else if (editor) {
    try {
      editor.setMode(mode);
      if (previousMode === 'preview' && transitionViewPosition) {
        editor.restoreTopLine?.(transitionViewPosition.topLine, transitionViewPosition.topLineOffset);
      }
      syncGitDiffLineHighlights();
      if (outlineController.isVisible()) {
        outlineController.refresh();
      }
      if (shouldRestoreEditorFocus) {
        editor.focus();
      }
      if (mode === 'live') {
        failureNotice.clearFailureNotice();
      }
    } catch (error) {
      logWebviewRenderError('applyMode', error, { requestedMode: mode, reason });

      if (mode === 'live') {
        if (!shouldAutoFallbackToSourceForLiveError(error)) {
          failureNotice.setFailureNotice('Live mode hit a transient render error. Staying in current mode; try again.', 'warning');
          currentMode = previousMode;
          updateModeUI();
          failureNotice.updateEditorNotice();
          return false;
        }

        failureNotice.setFailureNotice(failureNotice.liveModeFailureMessage, 'warning');

        try {
          editor.setMode('source');
          currentMode = 'source';
          updateModeUI();
          if (outlineController.isVisible()) {
            outlineController.refresh();
          }
          failureNotice.updateEditorNotice();
          if (shouldRestoreEditorFocus) {
            editor.focus();
          }
          if (post) {
            vscode.postMessage({ type: 'setMode', mode: 'source' });
          }
          return false;
        } catch (fallbackError) {
          logWebviewRenderError('applyMode.fallbackSource', fallbackError, { requestedMode: mode, reason });
          failureNotice.setFailureNotice(failureNotice.editorUpdateFailureMessage, 'error');
        }
      }

      currentMode = previousMode;
      previewController.setVisible(previousMode === 'preview');
      editorHost.hidden = previousMode === 'preview';
      updateModeUI();
      failureNotice.updateEditorNotice();
      return false;
    }
  }

  if (persist) {
    persistUiState();
  }

  if (post) {
    vscode.postMessage({ type: 'setMode', mode });
  }

  failureNotice.updateEditorNotice();
  return true;
};

const mountInitialEditor = async () => {
  if (editor || pendingInitialText === null || initialEditorMountInFlight) {
    return;
  }
  initialEditorMountInFlight = true;
  try {
    const createEditor = await loadCreateEditorFactory();
    const initialText = pendingInitialText;
    const initialTopLine = pendingRevealSelection === null ? pendingRestoreTopLine : null;
    const initialTopLineOffset = pendingRevealSelection === null ? pendingRestoreTopLineOffset : 0;
    if (editor || initialText === null) {
      return;
    }
    editor = createEditor({
      parent: editorHost,
      text: initialText,
      initialMode: lastEditableMode,
      initialTopLine,
      initialTopLineOffset,
      initialLineNumbers: lineNumbersVisible,
      initialGitGutter: gitChangesGutterVisible,
      initialGitBlame: gitBlameEnabled,
      initialVimMode: vimModeEnabled,
      initialVimKeybindings: vimKeybindingsState,
      initialVimLeader: vimLeaderState,
      initialDiagnostics: pendingDiagnostics,
      onApplyChanges: queueChanges,
      onOpenLink: (href: string) => {
        vscode.postMessage({ type: 'openLink', href });
      },
      onSelectionChange: (state: any) => selectionMenuController.update(state),
      onRequestDiagnosticSuggestions: requestDiagnosticSuggestions,
      onViewportChange: () => scheduleViewPositionCapture(),
      onRequestGitBlame: requestGitBlameForLine,
      onOpenGitRevisionForLine: openGitRevisionForLine,
      onOpenGitWorktreeForLine: openGitWorktreeForLine
    });
    gitClient?.applyBaselineToEditor(editor);
    syncGitDiffLineHighlights();
    if (initialTopLine !== null) {
      pendingRestoreTopLine = null;
      pendingRestoreTopLineOffset = 0;
    }
    editor.focus();
    pendingInitialText = null;
    initialMountRecoveryAttempted = false;
    if (currentMode === 'live') {
      failureNotice.clearFailureNotice();
    }
    requestWikiLinkStatuses(initialText);
    requestLocalLinkStatuses(initialText);
    if (pendingRevealSelection) {
      applyRevealSelectionFromHost(pendingRevealSelection);
    }
    if (pendingEditorFocus) {
      focusEditorFromHost();
    }
    if (outlineController.isVisible()) {
      outlineController.refresh();
    }
    failureNotice.updateEditorNotice();

    setWikiLinkRefreshContext({
      refreshDecorations: () => editor?.refreshDecorations?.()
    });
    setLocalLinkRefreshContext({
      refreshDecorations: () => editor?.refreshDecorations?.()
    });
    scheduleEditorSurfaceRecovery();
  } catch (error) {
    logWebviewRenderError('mountInitialEditor', error);

    if (currentMode === 'live') {
      if (!shouldAutoFallbackToSourceForLiveError(error)) {
        if (!initialMountRecoveryAttempted) {
          initialMountRecoveryAttempted = true;
          failureNotice.setFailureNotice('Live mode hit a transient render error while loading. Retrying...', 'warning');
          scheduleInitialEditorMount();
          return;
        }
        failureNotice.setFailureNotice('Live mode hit a transient render error while loading. Try reopening or switching modes.', 'warning');
        return;
      }

      if (!initialMountRecoveryAttempted) {
        initialMountRecoveryAttempted = true;
        failureNotice.setFailureNotice(failureNotice.liveModeFailureMessage, 'warning');
        applyMode('source', { post: true, persist: false, reason: 'render-failure' });
        scheduleInitialEditorMount();
        return;
      }
    }

    failureNotice.setFailureNotice(failureNotice.editorUpdateFailureMessage, 'error');
  } finally {
    initialEditorMountInFlight = false;
  }
};

const scheduleInitialEditorMount = () => {
  if (editor || initialEditorMountQueued) {
    return;
  }

  const runScheduledMount = () => {
    if (!initialEditorMountQueued) {
      return;
    }
    initialEditorMountQueued = false;
    if (initialEditorMountFallbackTimer !== null) {
      window.clearTimeout(initialEditorMountFallbackTimer);
      initialEditorMountFallbackTimer = null;
    }
    void mountInitialEditor();
    findPanelController.updateFindStatusSummary();
  };

  initialEditorMountQueued = true;
  window.requestAnimationFrame(runScheduledMount);
  initialEditorMountFallbackTimer = window.setTimeout(
    runScheduledMount,
    INITIAL_EDITOR_MOUNT_FALLBACK_MS
  );
};

const handleInit = (message: any) => {
  pendingRestoreTopLine = normalizeLineNumber(message.restoreTopLine);
  pendingRestoreTopLineOffset = normalizeLineOffset(message.restoreTopLineOffset);
  lastSentTopLine = null;
  lastSentTopLineOffset = null;
  if (typeof message.contentMaxWidthEnabled === 'boolean') {
    setContentMaxWidthEnabled(message.contentMaxWidthEnabled, { post: false });
  }
  if (!editor) {
    pendingInitialText = message.text;
    scheduleInitialEditorMount();
  } else {
    setEditorTextSafely(message.text, 'init');
  }
  if (typeof message.lineNumbers === 'boolean') {
    setLineNumbersVisible(message.lineNumbers, { post: false });
  }
  if (typeof message.gitChangesGutter === 'boolean') {
    setGitChangesGutterVisible(message.gitChangesGutter, { post: false });
  }
  if (typeof message.gitBlameEnabled === 'boolean') {
    setGitBlameEnabled(message.gitBlameEnabled, { post: false });
  }
  if (message.diffBaselineMode === 'current-edit' || message.diffBaselineMode === 'recent-save' || message.diffBaselineMode === 'git-head') {
    setDiffBaselineMode(message.diffBaselineMode, { post: false });
  }
  if (typeof message.spellCheckEnabled === 'boolean') {
    setSpellCheckEnabled(message.spellCheckEnabled, { post: false });
  }
  if (typeof message.gitDiffLineHighlights === 'boolean') {
    gitDiffLineHighlightsEnabled = message.gitDiffLineHighlights;
    syncGitDiffLineHighlights();
  }
  if (typeof message.vimMode === 'boolean') {
    setVimModeEnabled(message.vimMode);
  }
  if (Array.isArray(message.vimKeybindings)) {
    vimKeybindingsState = message.vimKeybindings;
    vimLeaderState = typeof message.vimLeader === 'string' ? message.vimLeader : '\\';
    editor?.setVimKeybindings(vimKeybindingsState, vimLeaderState);
  }
  if (message.findOptions && typeof message.findOptions === 'object') {
    findPanelController.setSearchOptions(message.findOptions);
  }
  applyDiagnosticsFromHost(message.diagnostics);
  outlineController.setPosition(message.outlinePosition);
  outlineController.setWidth(message.outlineWidth);
  if (typeof message.outlineVisible === 'boolean') {
    setOutlineVisible(message.outlineVisible, { post: false });
  }
  if (editor && outlineController.isVisible()) {
    outlineController.refresh();
  }
  scheduleEditorSurfaceRecovery();
  scheduleWikiLinkStatusRefresh(message.text);
  scheduleLocalLinkStatusRefresh(message.text);
  findPanelController.updateFindStatusSummary();
};

const exportHandlerContext: ExportHandlerContext = {
  vscode,
  getEditor: () => editor,
  get pendingText() { return pendingText; },
  get pendingInitialText() { return pendingInitialText; },
  get syncedText() { return syncedText; },
  get pendingDebounce() { return pendingDebounce; },
  get inFlight() { return inFlight; },
  flushChanges,
  normalizeEol,
  setPendingDebounce: (value) => { pendingDebounce = value; },
  getPreviewAppearance: () => previewController.getAppearance()
};

const exportHandler = createExportHandler(exportHandlerContext);

const withMessageErrorBoundary = (context: string, action: () => void): void => {
  try {
    action();
  } catch (error) {
    console.error(`[MEO webview] ${context}`, error);
  }
};

window.addEventListener('message', (event) => {
  const message = event.data;

  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'init') {
    acknowledgeReadyHandshake();
    withMessageErrorBoundary('init handler', () => {
      applyThemeSettings(message.theme);
      setShikiEnabled(message.shikiCodeBlocks === true);
      setShikiTheme(message.codeTheme);
      initialMountRecoveryAttempted = false;
      failureNotice.clearFailureNotice();
      gitClient?.resetForInit({ hideTooltip: false });
      const nextMode = hasLocalModePreference ? currentMode : message.mode;
      documentVersion = message.version;
      syncedText = normalizeEol(message.text);
      pendingText = null;
      inFlight = false;
      inFlightText = null;
      saveAfterSync = false;
      syncPendingDraftState();
      previewController.setAppearance(message.previewAppearance === 'light' ? 'light' : 'dark');

      handleInit(message);
      if (hasLocalModePreference) {
        applyMode(nextMode, {
          post: true,
          persist: true,
          reason: 'init'
        });
      } else {
        applyMode(nextMode, {
          post: false,
          persist: false,
          reason: 'init'
        });
      }
      if (nextMode !== 'preview') {
        previewController.preload(message.text);
      }
      failureNotice.updateEditorNotice();
    });
    return;
  }

  if (message.type === 'themeChanged') {
    withMessageErrorBoundary('themeChanged handler', () => {
      const applyThemeChange = () => {
        applyThemeSettings(message.theme);
        refreshMermaidTheme();
        setShikiTheme(message.codeTheme);
        editor?.refreshDecorations();
        if (currentMode === 'preview') {
          previewController.requestRender(getCurrentEditorText(), {
            restoreLine: previewController.getTopVisiblePosition()?.topLine ?? null
          });
        }
      };
      if (editor) editor.preserveViewport(applyThemeChange);
      else applyThemeChange();
    });
    return;
  }

  if (message.type === 'shikiCodeBlocksChanged') {
    withMessageErrorBoundary('shikiCodeBlocksChanged handler', () => {
      setShikiTheme(message.codeTheme);
      setShikiEnabled(message.enabled === true);
    });
    return;
  }


  if (message.type === 'revealSelection') {
    applyRevealSelectionFromHost(message);
    return;
  }

  if (message.type === 'focusEditor') {
    focusEditorFromHost();
    return;
  }

  if (message.type === 'toggleMode') {
    const nextMode = currentMode === 'preview'
      ? lastEditableMode
      : currentMode === 'live' ? 'source' : 'live';
    applyMode(nextMode, { userTriggered: true, reason: 'command' });
    return;
  }

  if (message.type === 'previewAppearanceChanged') {
    previewController.setAppearance(message.appearance === 'light' ? 'light' : 'dark');
    return;
  }

  if (message.type === 'previewRendered') {
    previewController.handleRendered(message);
    return;
  }

  if (message.type === 'previewRenderError') {
    previewController.handleRenderError(message);
    return;
  }

  if (message.type === 'docChanged' && currentMode === 'preview') {
    const restoreLine = previewController.getTopVisiblePosition()?.topLine ?? null;
    window.setTimeout(() => previewController.requestRender(getCurrentEditorText(), { restoreLine }), 0);
  }

  if (message.type === 'docChanged' && !editor && pendingInitialText !== null) {
    clearGitBlameCache({ hideTooltip: false });
    documentVersion = message.version;
    syncedText = normalizeEol(message.text);
    pendingInitialText = message.text;
    return;
  }

  if (message.type === 'docChanged' && editor) {
    clearGitBlameCache();
    const incomingText = normalizeEol(message.text);
    const currentText = normalizeEol(editor.getText());
    const pendingNormalized = pendingText === null ? null : normalizeEol(pendingText);
    const inFlightNormalized = inFlightText === null ? null : normalizeEol(inFlightText);
    const localDraftText = pendingText ?? inFlightText;
    const localDraftNormalized = localDraftText === null ? null : normalizeEol(localDraftText);

    documentVersion = message.version;

    if (incomingText === currentText) {
      syncedText = currentText;

      if (pendingNormalized === incomingText) {
        pendingText = null;
      }

      if (inFlight && inFlightNormalized === incomingText) {
        inFlight = false;
        inFlightText = null;
      }

      flushChanges();
      maybeSaveAfterSync();
      syncPendingDraftState();
      return;
    }

    if (inFlight && inFlightNormalized === incomingText) {
      syncedText = incomingText;
      inFlight = false;
      inFlightText = null;
      flushChanges();
      maybeSaveAfterSync();
      syncPendingDraftState();
      return;
    }

    if (pendingNormalized === incomingText) {
      syncedText = incomingText;
      pendingText = null;
      inFlight = false;
      inFlightText = null;
      flushChanges();
      maybeSaveAfterSync();
      syncPendingDraftState();
      return;
    }

    if (localDraftText !== null && localDraftNormalized !== incomingText) {
      const reconciled = reconcileExternalDocument(syncedText, localDraftNormalized, incomingText);
      syncedText = incomingText;
      pendingText = reconciled.pendingText;
      inFlight = false;
      inFlightText = null;

      if (pendingDebounce !== null) {
        window.clearTimeout(pendingDebounce);
        pendingDebounce = null;
      }

      if (!setEditorTextSafely(reconciled.text, 'docChanged.reconcile')) {
        return;
      }
      flushChanges();
      maybeSaveAfterSync();
      syncPendingDraftState();
      return;
    }

    syncedText = incomingText;
    pendingText = null;
    inFlight = false;
    inFlightText = null;
    saveAfterSync = false;

    if (pendingDebounce !== null) {
      window.clearTimeout(pendingDebounce);
      pendingDebounce = null;
    }

    syncPendingDraftState();
    if (!setEditorTextSafely(message.text, 'docChanged')) {
      return;
    }
    if (outlineController.isVisible()) {
      outlineController.refresh();
    }
    scheduleWikiLinkStatusRefresh(message.text);
    scheduleLocalLinkStatusRefresh(message.text);
    findPanelController.updateFindStatusSummary();
    return;
  }

  if (message.type === 'applied') {
    documentVersion = message.version;
    if (inFlightText !== null) {
      syncedText = normalizeEol(inFlightText);
    }
    if (pendingText !== null && normalizeEol(pendingText) === syncedText) {
      pendingText = null;
    }
    inFlight = false;
    inFlightText = null;
    flushChanges();
    maybeSaveAfterSync();
    syncPendingDraftState();
    return;
  }

  if (message.type === 'lineNumbersChanged') {
    setLineNumbersVisible(message.enabled, { post: false });
    return;
  }

  if (message.type === 'gitChangesGutterChanged') {
    setGitChangesGutterVisible(message.enabled, { post: false });
    return;
  }

  if (message.type === 'gitBlameChanged') {
    setGitBlameEnabled(message.enabled, { post: false });
    return;
  }

  if (message.type === 'gitDiffLineHighlightsChanged') {
    gitDiffLineHighlightsEnabled = message.enabled;
    syncGitDiffLineHighlights();
    return;
  }

  if (message.type === 'diffBaselineModeChanged') {
    setDiffBaselineMode(message.mode, { post: false });
    return;
  }

  if (message.type === 'spellCheckChanged') {
    setSpellCheckEnabled(message.enabled, { post: false });
    return;
  }

  if (message.type === 'contentMaxWidthChanged') {
    setContentMaxWidthEnabled(message.enabled, { post: false });
    return;
  }

  if (message.type === 'vimModeChanged') {
    setVimModeEnabled(message.enabled);
    return;
  }

  if (message.type === 'vimKeybindingsChanged') {
    vimKeybindingsState = message.keybindings;
    vimLeaderState = message.leaderKey;
    editor?.setVimKeybindings(vimKeybindingsState, vimLeaderState);
    return;
  }

  if (message.type === 'findOptionsChanged') {
    if (message.findOptions && typeof message.findOptions === 'object') {
      findPanelController.setSearchOptions(message.findOptions);
      findPanelController.updateFindStatusSummary();
    }
    return;
  }

  if (message.type === 'outlineVisibilityChanged') {
    setOutlineVisible(message.visible, { post: false });
    return;
  }

  if (message.type === 'gitBaselineChanged') {
    gitClient?.handleMessage(message, { editor });
    return;
  }

  if (message.type === 'gitBlameResult') {
    gitClient?.handleMessage(message, { editor });
    return;
  }

  if (message.type === 'diagnosticsChanged') {
    applyDiagnosticsFromHost(message.diagnostics);
    return;
  }

  if (message.type === 'diagnosticSuggestionsResult') {
    const request = pendingDiagnosticSuggestionRequests.get(message.requestId);
    pendingDiagnosticSuggestionRequests.delete(message.requestId);
    if (!request || !Array.isArray(message.suggestions) || message.suggestions.length === 0) {
      return;
    }
    editor?.showDiagnosticSuggestions?.(message.requestId, {
      from: message.from,
      to: message.to,
      suggestions: message.suggestions
    });
    return;
  }

  if (message.type === 'outlinePositionChanged') {
    outlineController.setPosition(message.position);
    return;
  }

  if (message.type === 'resolvedImageSrc') {
    settleImageSrcRequest(message.requestId, message.resolvedUrl);
    return;
  }

  if (message.type === 'resolvedWikiLinks') {
    if (handleResolvedWikiLinks(message)) {
      editor?.refreshDecorations();
    }
    return;
  }

  if (message.type === 'resolvedLocalLinks') {
    if (handleResolvedLocalLinks(message)) {
      editor?.refreshDecorations();
    }
    return;
  }

  if (message.type === 'savedImagePath') {
    handleSavedImagePath(message);
    return;
  }

  if (message.type === 'requestExportSnapshot') {
    if (typeof message.requestId !== 'string' || !message.requestId) {
      return;
    }
    void exportHandler.handleExportSnapshotRequest(message.requestId);
  }
});

window.addEventListener('keydown', (event) => {
  handleEditorShortcut(event, shortcutHandlerContext);
}, { capture: true });

window.addEventListener('paste', async (event) => {
  if (!editor) {
    return;
  }

  const stateAtPaste = editor.view.state;
  const selectionAtPaste = stateAtPaste.selection.main;
  const lineAtPaste = stateAtPaste.doc.lineAt(selectionAtPaste.head);
  const lineNumberAtPaste = lineAtPaste.number;
  const lineOffsetAtPaste = selectionAtPaste.head - lineAtPaste.from;

  await handleImagePaste(event, editor, {
    lineNumber: lineNumberAtPaste,
    lineOffset: lineOffsetAtPaste,
    onError: (message) => failureNotice.setFailureNotice(`Could not paste image: ${message}`, 'warning')
  });
});

window.addEventListener('blur', () => {
  flushPendingChangesNow();
  flushViewPositionNow();
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (pendingEditorSurfaceRecoveryRaf !== null) {
      window.cancelAnimationFrame(pendingEditorSurfaceRecoveryRaf);
      pendingEditorSurfaceRecoveryRaf = null;
    }
    forceFlushChanges();
    return;
  }
  scheduleEditorSurfaceRecovery();
});

window.addEventListener('focus', () => {
  scheduleEditorSurfaceRecovery();
});

const forceFlushChanges = () => {
  commitEditorTransientEdits();
  flushChanges();
  flushViewPositionNow();
};

window.addEventListener('beforeunload', () => {
  clearReadyRetryTimers();
  cancelPendingWikiStatusRefresh();
  cancelPendingLocalLinkStatusRefresh();
  clearGitBlameCache({ hideTooltip: false });

  if (initialEditorMountFallbackTimer !== null) {
    window.clearTimeout(initialEditorMountFallbackTimer);
    initialEditorMountFallbackTimer = null;
  }
  if (pendingEditorSurfaceRecoveryRaf !== null) {
    window.cancelAnimationFrame(pendingEditorSurfaceRecoveryRaf);
    pendingEditorSurfaceRecoveryRaf = null;
  }
  if (pendingDebounce !== null) {
    window.clearTimeout(pendingDebounce);
    pendingDebounce = null;
  }

  forceFlushChanges();
});

window.addEventListener('resize', () => {
  findPanelController.updateAnchor();
  if (editor) {
    editor.refreshSelectionOverlay();
  }
});

const state = vscode.getState() as WebviewUiState | undefined;
if (state?.lastEditableMode === 'live' || state?.lastEditableMode === 'source') {
  lastEditableMode = state.lastEditableMode;
}
if (state && (state.mode === 'live' || state.mode === 'source' || state.mode === 'preview')) {
  applyMode(state.mode, { post: false, persist: false });
  hasLocalModePreference = true;
} else {
  updateModeUI();
}
if (typeof state?.contentMaxWidthEnabled === 'boolean') {
  setContentMaxWidthEnabled(state.contentMaxWidthEnabled, { post: false, persist: false });
}
if (state?.outlineMode === 'floating' || state?.outlineMode === 'fixed') {
  outlineUiState.mode = state.outlineMode;
  outlineController.setMode(state.outlineMode);
}
if (typeof state?.outlineWidth === 'number') {
  outlineUiState.width = state.outlineWidth;
  outlineController.setWidth(state.outlineWidth);
}
outlineController.setPosition('right');
updateLineNumbersUI();
updateGitChangesGutterUI();

liveButton.addEventListener('click', () => {
  applyMode('live', { userTriggered: true });
});

sourceButton.addEventListener('click', () => {
  applyMode('source', { userTriggered: true });
});

previewButton.addEventListener('click', () => {
  applyMode('preview', { userTriggered: true });
});

const preserveEditorFocusOnModePointerToggle = (event: PointerEvent) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('.mode-button')) {
    return;
  }
  if (!editor || !editor.hasFocus()) {
    modeToggleShouldRestoreEditorFocus = false;
    return;
  }
  modeToggleShouldRestoreEditorFocus = true;
  event.preventDefault();
};

modeGroup.addEventListener('pointerdown', preserveEditorFocusOnModePointerToggle);

const handleFormatAction = (action: string) => {
  if (!editor) return;
  editor.insertFormat(action);
  editor.focus();
};

findPanelElements.findInput.addEventListener('input', () => {
  findPanelController.updateFindStatusSummary();
});

findPanelElements.findClearBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
});

findPanelElements.findClearBtn.addEventListener('click', () => {
  findPanelController.clearFind();
});

findPanelElements.replaceClearBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
});

findPanelElements.replaceClearBtn.addEventListener('click', () => {
  findPanelController.clearReplace();
});

findPanelElements.wholeWordBtn.addEventListener('click', () => {
  findPanelController.toggleWholeWord();
  postFindOptions();
});

findPanelElements.caseSensitiveBtn.addEventListener('click', () => {
  findPanelController.toggleCaseSensitive();
  postFindOptions();
});

findPanelElements.panel.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !findPanelController.isVisible()) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  findPanelController.close();
});

findPanelElements.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    findPanelController.runFind(event.shiftKey, { focusEditor: false });
    return;
  }
});

findPanelElements.replaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    findPanelController.runReplace();
    return;
  }
});

findPanelElements.findPrevBtn.addEventListener('click', () => {
  findPanelController.runFind(true);
});

findPanelElements.findNextBtn.addEventListener('click', () => {
  findPanelController.runFind(false);
});

findPanelElements.closeBtn.addEventListener('click', () => {
  findPanelController.close();
});

findPanelElements.replaceBtn.addEventListener('click', () => {
  findPanelController.runReplace();
});

findPanelElements.replaceAllBtn.addEventListener('click', () => {
  findPanelController.runReplaceAll();
});

findToggleBtn.addEventListener('click', () => {
  if (findPanelController.isVisible()) {
    findPanelController.close();
    return;
  }
  findPanelController.open('find');
});

selectionMenuElements.menu.addEventListener('pointerdown', (event) => {
  event.preventDefault();
});

selectionMenuElements.menu.addEventListener('click', (event) => {
  const suggestionButton = (event.target as Element).closest('.selection-inline-suggestion') as HTMLElement | null;
  if (suggestionButton) {
    const index = parseInt(suggestionButton.dataset.suggestionIndex ?? '', 10);
    if (Number.isFinite(index)) {
      selectionMenuController.handleSuggestion(index);
    }
    return;
  }

  const button = (event.target as Element).closest('.selection-inline-button') as HTMLElement | null;
  if (!button) return;
  const { action } = button.dataset;
  if (!action) return;
  selectionMenuController.handleAction(action);
});

headingDropdown.addEventListener('click', (event) => {
  const option = (event.target as Element).closest('.heading-dropdown-option') as HTMLElement | null;
  if (!option || !editor) return;
  const level = parseInt(option.dataset.level ?? '', 10);
  editor.insertFormat('heading', level);
  editor.focus();
});

bulletListBtn.addEventListener('click', () => handleFormatAction('bulletList'));
numberedListBtn.addEventListener('click', () => handleFormatAction('numberedList'));
taskBtn.addEventListener('click', () => handleFormatAction('task'));
codeBlockBtn.addEventListener('click', () => handleFormatAction('codeBlock'));
quoteBtn.addEventListener('click', () => handleFormatAction('quote'));
hrBtn.addEventListener('click', () => handleFormatAction('hr'));
linkBtn.addEventListener('click', () => handleFormatAction('link'));
wikiLinkBtn.addEventListener('click', () => handleFormatAction('wikiLink'));
imageBtn.addEventListener('click', () => handleFormatAction('image'));
exportHtmlOption.addEventListener('click', () => {
  exportHandler.requestExport('html');
});
exportPdfOption.addEventListener('click', () => {
  exportHandler.requestExport('pdf');
});
const showOutlineAt = (position: 'left' | 'right') => {
  if (outlineController.isVisible() && outlineController.getPosition() === position) {
    setOutlineVisible(false);
    return;
  }
  outlineController.requestPosition(position);
  setOutlineVisible(true);
};

outlineLeftBtn.addEventListener('click', () => showOutlineAt('left'));
previewOutlineLeftBtn.addEventListener('click', () => showOutlineAt('left'));
outlineBtn.addEventListener('click', () => showOutlineAt('right'));
contentMaxWidthBtn.addEventListener('click', () => {
  setContentMaxWidthEnabled(!contentMaxWidthEnabled);
});
lineNumbersBtn.addEventListener('click', toggleLineNumbers);
gitChangesGutterBtn.addEventListener('click', toggleGitChangesGutter);
spellCheckBtn.addEventListener('click', toggleSpellCheck);
gitBlameBtn.addEventListener('click', toggleGitBlame);

persistUiState();
if (hasLocalModePreference) {
  vscode.postMessage({ type: 'setMode', mode: currentMode });
}
scheduleReadyHandshake();
scheduleEditorBundleWarmupAfterReady();
