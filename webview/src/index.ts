import { createElement, Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, List, ListOrdered, ListTodo, ListTree, Hash, Code, Terminal, Quote, Minus, Table2, Link, Brackets, Image, Bold, Italic, Strikethrough, Search, FileCode2, FileText, Save, StickyNoteOff, GitCompare, PanelLeftRightDashed, Settings2, Check, MapPin, MapPinOff, Ellipsis, Sun, Moon } from 'lucide';
import { setImageSrcResolver, initializeImageHandling, resolveImageSrc, settleImageSrcRequest, handleSavedImagePath, handleImagePaste } from './helpers/images';
import { createGitClient } from './helpers/gitClient';
import { createOutlineController } from './helpers/outline';
import { normalizeWikiTarget, replaceWikiLinkStatuses, initializeWikiLinkHandling, collectWikiLinkTargets, requestWikiLinkStatuses, scheduleWikiLinkStatusRefresh, setWikiLinkRefreshContext, cancelPendingWikiStatusRefresh, handleResolvedWikiLinks } from './helpers/wikiLinks';
import { initializeLocalLinkHandling, requestLocalLinkStatuses, scheduleLocalLinkStatusRefresh, setLocalLinkRefreshContext, cancelPendingLocalLinkStatusRefresh, handleResolvedLocalLinks } from './helpers/localLinks';
import { setGitDiffLineHighlightsEnabled } from './helpers/gitDiffLineHighlights';
import { applyBuiltInVisualBaseline } from './helpers/theme';
import { setShikiTheme } from './helpers/shikiHighlighter';
import { createFailureNoticeManager, getErrorMessage, isTransientMermaidRuntimeError, shouldAutoFallbackToSourceForLiveError, logWebviewRenderError, type FailureNoticeManager } from './helpers/errors';
import { isPrimaryModifier, isShortcutKey, handleEditorShortcut, type ShortcutHandlerContext } from './helpers/shortcuts';
import { createFindPanel, createFindPanelController, type FindPanelController } from './helpers/findPanel';
import { createSelectionMenu, createSelectionMenuController, type SelectionMenuController } from './helpers/selectionMenu';
import {
  initializeMermaidEditorRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from './helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from './editor/mermaidDiagramRenderPool';
import { createMermaidDiagramPresentationApplication } from './application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from './adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from './editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from './editor/mermaidDiagramPresentation';
import { isAcceptedLineJumpInput, parseLineJumpTarget } from './helpers/lineJump';
import { createEditorNoticeController } from './helpers/notices';
import { createPreviewController } from './helpers/preview';
import type { ViewportAnchorToken } from './helpers/viewportController';
import { createDocumentScrollToTopController } from './helpers/scrollToTop';
import { createSegmentedControl } from './helpers/segmentedControl';
import { createCodePaletteWebviewAdapter } from './adapters/codePaletteWebviewAdapter';
import { createExportWebviewAdapter } from './adapters/exportWebviewAdapter';
import { createDocumentSessionWebviewAdapter } from './adapters/documentSessionWebviewAdapter';
import { createDocumentSaveFlushWebviewAdapter } from './adapters/documentSaveFlushWebviewAdapter';
import { createPreviewWebviewAdapter } from './adapters/previewWebviewAdapter';
import { createAppearanceWebviewAdapter } from './adapters/appearanceWebviewAdapter';
import { createEditorModeApplication, type EditorMode } from './application/editorMode';
import type { DocumentPresentationSource } from '../../src/application/documentSession';
import { createEditorModeEffectAdapter } from './adapters/editorModeEffectAdapter';
import { createEditorModeRuntime, type EditorModeRuntime } from './adapters/editorModeRuntime';
import { decodeHostToWebviewMessage } from '../../src/protocol/messages';
import type { EditorAppearance } from '../../src/protocol/editorCommands';
import type { InitMessage } from '../../src/protocol/readyInit';
import { getUiStrings, type UiLanguage } from '../../src/foundation/uiLanguage';

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

applyBuiltInVisualBaseline();
setImageSrcResolver(resolveImageSrc);

const root = document.getElementById('app');

if (!root) {
  throw new Error('Webview root element not found');
}

root.classList.add('editor-root');
let activeUiLanguage: UiLanguage = 'en';
let activeUiStrings = getUiStrings(activeUiLanguage);

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

let gitChangesGutterVisible = true;
let gitDiffLineHighlightsEnabled = true;
let diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head' = 'current-edit';
let fixedBaselinePinned = false;
let fixedBaselineActive = false;
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

const gitChangesGutterBtn = document.createElement('button');
gitChangesGutterBtn.type = 'button';
gitChangesGutterBtn.className = 'format-button toggle-button is-active';
gitChangesGutterBtn.dataset.action = 'gitChangesGutter';
gitChangesGutterBtn.title = 'Hide Changes';
gitChangesGutterBtn.appendChild(createElement(GitCompare, { width: 18, height: 18 }));

const fixedBaselineBtn = document.createElement('button');
fixedBaselineBtn.type = 'button';
fixedBaselineBtn.className = 'format-button toggle-button';
fixedBaselineBtn.dataset.action = 'fixedBaseline';
fixedBaselineBtn.appendChild(createElement(MapPin, { width: 18, height: 18 }));

const releaseFixedBaselineBtn = document.createElement('button');
releaseFixedBaselineBtn.type = 'button';
releaseFixedBaselineBtn.className = 'more-tools-option fixed-baseline-release-option';
releaseFixedBaselineBtn.dataset.action = 'releaseFixedBaseline';
releaseFixedBaselineBtn.setAttribute('role', 'menuitem');
appendMoreToolsOptionContent(releaseFixedBaselineBtn, MapPinOff, 'Release Fixed Baseline');

const diffBaselineOptions = [
  { mode: 'current-edit' },
  { mode: 'recent-save' },
  { mode: 'git-head' }
] as const;

const getDiffBaselineLabel = (mode: typeof diffBaselineOptions[number]['mode']): string => ({
  'current-edit': activeUiStrings.currentEdits,
  'recent-save': activeUiStrings.recentSave,
  'git-head': activeUiStrings.gitHead
})[mode];

const diffBaselineButtons: HTMLButtonElement[] = [];
for (const option of diffBaselineOptions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'more-tools-option changes-baseline-option';
  button.dataset.baselineMode = option.mode;
  button.setAttribute('role', 'menuitemradio');
  appendMoreToolsOptionContent(button, GitCompare, getDiffBaselineLabel(option.mode));
  diffBaselineButtons.push(button);
}

const changesControls = document.createElement('div');
changesControls.className = 'changes-controls preview-hidden-toolbar-control';
changesControls.append(fixedBaselineBtn, gitChangesGutterBtn);

const updateGitChangesGutterUI = () => {
  gitChangesGutterBtn.classList.toggle('is-active', gitChangesGutterVisible);
  gitChangesGutterBtn.setAttribute('aria-pressed', gitChangesGutterVisible ? 'true' : 'false');
  const modeLabel = fixedBaselineActive
    ? activeUiStrings.fixedBaseline
    : getDiffBaselineLabel(diffBaselineMode) ?? activeUiStrings.changes;
  gitChangesGutterBtn.title = gitChangesGutterVisible
    ? activeUiStrings.hideChanges(modeLabel)
    : activeUiStrings.showChanges(modeLabel);
  fixedBaselineBtn.classList.toggle('is-active', fixedBaselineActive);
  fixedBaselineBtn.classList.toggle('is-standby', fixedBaselinePinned && !fixedBaselineActive);
  fixedBaselineBtn.setAttribute('aria-pressed', fixedBaselineActive ? 'true' : 'false');
  fixedBaselineBtn.title = !fixedBaselinePinned
    ? activeUiStrings.pinLatestSavedBaseline
    : fixedBaselineActive
      ? activeUiStrings.showChanges(getDiffBaselineLabel(diffBaselineMode) ?? activeUiStrings.selectedMode)
      : activeUiStrings.showFixedBaseline;
  fixedBaselineBtn.setAttribute('aria-label', fixedBaselineBtn.title);
  releaseFixedBaselineBtn.disabled = !fixedBaselinePinned;
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
  const leavesFixedBaseline = fixedBaselineActive;
  diffBaselineMode = mode;
  updateGitChangesGutterUI();
  if (post && (changed || leavesFixedBaseline)) {
    vscode.postMessage({ type: 'setDiffBaselineMode', mode });
  }
};

const setFixedBaselineState = (pinned: boolean, active: boolean) => {
  fixedBaselinePinned = pinned;
  fixedBaselineActive = pinned && active;
  updateGitChangesGutterUI();
};

const updateContentMaxWidthUI = () => {
  contentMaxWidthBtn.classList.toggle('is-active', contentMaxWidthEnabled);
  contentMaxWidthBtn.setAttribute('aria-checked', contentMaxWidthEnabled ? 'true' : 'false');
  contentMaxWidthBtn.title = contentMaxWidthEnabled
    ? activeUiStrings.disableConstrainedWidth
    : activeUiStrings.constrainContentWidth;
};

const syncGitDiffLineHighlights = () => {
  if (!editor) {
    return;
  }
  setGitDiffLineHighlightsEnabled(
    editor,
    getActiveEditorMode() === 'source' && gitChangesGutterVisible && gitDiffLineHighlightsEnabled
  );
};

type PostUpdateOptions = { post?: boolean };
type PersistedPostUpdateOptions = PostUpdateOptions & { persist?: boolean };

const setGitChangesGutterVisible = (visible: boolean, { post = true }: PostUpdateOptions = {}) => {
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

const setContentMaxWidthEnabled = (
  enabled: boolean,
  { post = true, persist = true }: PersistedPostUpdateOptions = {}
) => {
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

const setOutlineVisible = (visible: boolean, { post = true }: PostUpdateOptions = {}) => {
  const nextVisible = visible === true;
  const changed = nextVisible !== outlineController.isVisible();
  outlineController.setVisible(nextVisible);
  if (post && changed) {
    vscode.postMessage({ type: 'setOutlineVisible', visible: nextVisible });
  }
};

const toggleGitChangesGutter = () => {
  setGitChangesGutterVisible(!gitChangesGutterVisible);
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

lineJumpControl.append(lineJumpInput);

let acceptedLineJumpInput = '';

const clearLineJumpError = () => {
  lineJumpControl.classList.remove('is-error');
  lineJumpInput.removeAttribute('aria-invalid');
};

const syncLineJumpInput = () => {
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

const discardBtn = document.createElement('button');
discardBtn.type = 'button';
discardBtn.className = 'format-button';
discardBtn.dataset.action = 'discard';
discardBtn.title = 'Reload disk version (double-click)';
discardBtn.setAttribute('aria-label', 'Reload disk version');
discardBtn.appendChild(createElement(StickyNoteOff, { width: 18, height: 18 }));

const preserveEditorFocusOnDocumentAction = (event: PointerEvent) => {
  if (event.button === 0 && editor?.hasFocus()) {
    // Toolbar actions must not let the browser move focus and scroll the editor
    // before the document/save synchronization starts.
    event.preventDefault();
  }
};

saveBtn.addEventListener('pointerdown', preserveEditorFocusOnDocumentAction);
discardBtn.addEventListener('pointerdown', preserveEditorFocusOnDocumentAction);

formatGroup.append(
  outlineLeftBtn,
  lineJumpControl,
  saveBtn,
  discardBtn,
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
exportHtmlOption.setAttribute('aria-label', 'Export as HTML');
const exportHtmlLabel = document.createElement('span');
exportHtmlLabel.className = 'preview-toolbar-action-label';
exportHtmlLabel.textContent = 'Export HTML';
exportHtmlOption.append(
  createElement(FileCode2, { width: 15, height: 15, 'aria-hidden': 'true' }),
  exportHtmlLabel
);

const exportPdfOption = document.createElement('button');
exportPdfOption.type = 'button';
exportPdfOption.className = 'preview-toolbar-action';
exportPdfOption.dataset.format = 'pdf';
exportPdfOption.title = 'Export as PDF';
exportPdfOption.setAttribute('aria-label', 'Export as PDF');
const exportPdfLabel = document.createElement('span');
exportPdfLabel.className = 'preview-toolbar-action-label';
exportPdfLabel.textContent = 'Export PDF';
exportPdfOption.append(
  createElement(FileText, { width: 15, height: 15, 'aria-hidden': 'true' }),
  exportPdfLabel
);

const previewAppearanceSlot = document.createElement('span');
const previewFontFamilySlot = document.createElement('span');
const previewSourceColoringSlot = document.createElement('span');
const previewFormatGroup = document.createElement('div');
previewFormatGroup.className = 'preview-format-group';
previewFormatGroup.setAttribute('role', 'group');
previewFormatGroup.setAttribute('aria-label', 'Preview tools');
previewFormatGroup.append(
  previewOutlineLeftBtn,
  previewFontFamilySlot,
  previewSourceColoringSlot,
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
const toolbarOverflowSection = document.createElement('div');
toolbarOverflowSection.className = 'more-tools-overflow-items';
toolbarOverflowSection.hidden = true;
const releaseFixedBaselineSeparator = document.createElement('div');
releaseFixedBaselineSeparator.className = 'more-tools-separator';
releaseFixedBaselineSeparator.setAttribute('role', 'separator');
const changesSeparator = document.createElement('div');
changesSeparator.className = 'more-tools-separator';
changesSeparator.setAttribute('role', 'separator');
const editorAppearanceControl = createSegmentedControl<EditorAppearance>({
  ariaLabel: 'Editor appearance',
  className: 'editor-appearance-control',
  buttonClassName: 'editor-appearance-button',
  datasetKey: 'editorAppearance',
  role: 'group',
  options: [
    {
      value: 'auto',
      label: 'Auto'
    },
    {
      value: 'light',
      label: 'Light',
      renderLeading: () => createElement(Sun, { width: 14, height: 14, 'aria-hidden': 'true' })
    },
    {
      value: 'dark',
      label: 'Dark',
      renderLeading: () => createElement(Moon, { width: 14, height: 14, 'aria-hidden': 'true' })
    }
  ]
});
editorAppearanceControl.setActive('dark');

const applyUiLanguage = (language: UiLanguage): void => {
  const strings = getUiStrings(language);
  activeUiLanguage = language;
  activeUiStrings = strings;
  document.documentElement.lang = language;
  toolbar.setAttribute('aria-label', strings.editorToolbar);
  formatGroup.setAttribute('aria-label', strings.formatting);
  headingBtn.title = strings.heading;
  headingDropdown.setAttribute('aria-label', strings.headingLevels);
  for (const option of headingDropdown.querySelectorAll<HTMLElement>('[data-level]')) {
    option.title = strings.headingLevel(Number.parseInt(option.dataset.level ?? '', 10));
  }
  bulletListBtn.title = strings.bulletList;
  numberedListBtn.title = strings.numberedList;
  taskBtn.title = strings.task;
  for (const button of [outlineLeftBtn, previewOutlineLeftBtn]) {
    button.title = strings.showOutlineLeft;
    button.setAttribute('aria-label', button.title);
  }
  outlineBtn.title = strings.showOutlineRight;
  outlineBtn.setAttribute('aria-label', outlineBtn.title);
  codeBlockBtn.title = strings.codeBlock;
  quoteBtn.title = strings.quote;
  hrBtn.title = strings.horizontalRule;
  linkBtn.title = strings.link;
  wikiLinkBtn.title = strings.wikiLink;
  imageBtn.title = strings.image;
  tableBtn.title = strings.table;
  lineJumpInput.placeholder = strings.line;
  lineJumpInput.setAttribute('aria-label', strings.goToLine);
  saveBtn.title = strings.save;
  saveBtn.setAttribute('aria-label', strings.saveDocument);
  discardBtn.title = strings.reloadDiskVersionDoubleClick;
  discardBtn.setAttribute('aria-label', strings.reloadDiskVersion);
  contentMaxWidthBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.constrainWidth;
  releaseFixedBaselineBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.releaseFixedBaseline;
  diffBaselineButtons.forEach((button) => {
    const mode = button.dataset.baselineMode as typeof diffBaselineOptions[number]['mode'];
    button.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = getDiffBaselineLabel(mode);
  });
  updateGitChangesGutterUI();
  updateContentMaxWidthUI();
  editorNotice.setUiLanguage(language);
  modeControl.element.setAttribute('aria-label', strings.markdownMode);
  modeControl.setLabels({ live: strings.live, source: strings.source, preview: strings.preview });
  selectionMenuElements.setUiLanguage(language);
  editorScrollToTopController.setUiLanguage(language);
  findToggleBtn.title = strings.findAndReplace;
  exportHtmlOption.title = strings.exportAsHtml;
  exportHtmlOption.setAttribute('aria-label', strings.exportAsHtml);
  exportHtmlLabel.textContent = strings.exportHtml;
  exportPdfOption.title = strings.exportAsPdf;
  exportPdfOption.setAttribute('aria-label', strings.exportAsPdf);
  exportPdfLabel.textContent = strings.exportPdf;
  previewFormatGroup.setAttribute('aria-label', strings.previewTools);
  moreToolsButton.title = strings.more;
  moreToolsButton.setAttribute('aria-label', strings.moreTools);
  moreToolsPanel.setAttribute('aria-label', strings.moreTools);
  editorAppearanceControl.element.setAttribute('aria-label', strings.editorAppearance);
  editorAppearanceControl.setLabels({
    auto: strings.auto,
    light: strings.light,
    dark: strings.dark
  });
  findPanelController.setUiLanguage(language);
  outlineController.setUiLanguage(language);
  previewController.setUiLanguage(language);
};
const editorAppearanceRow = document.createElement('div');
editorAppearanceRow.className = 'more-tools-appearance-row';
editorAppearanceRow.append(editorAppearanceControl.element);
moreToolsPanel.append(
  toolbarOverflowSection,
  releaseFixedBaselineBtn,
  releaseFixedBaselineSeparator,
  ...diffBaselineButtons,
  changesSeparator,
  contentMaxWidthBtn,
  editorAppearanceRow
);

const moreToolsWrapper = document.createElement('div');
moreToolsWrapper.className = 'more-tools-wrapper preview-hidden-toolbar-control';
moreToolsWrapper.append(moreToolsButton, moreToolsPanel);

const rightToolsSeparator = document.createElement('div');
rightToolsSeparator.className = 'format-separator preview-hidden-toolbar-control';
rightToolsSeparator.setAttribute('role', 'separator');

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
  changesControls,
  moreToolsWrapper,
  rightToolsSeparator,
  findToggleBtn,
  outlineBtn
);

moreToolsPanel.addEventListener('click', (event) => {
  const option = (event.target as Element).closest<HTMLElement>('.changes-baseline-option');
  const mode = option?.dataset.baselineMode;
  if (mode === 'current-edit' || mode === 'recent-save' || mode === 'git-head') {
    setDiffBaselineMode(mode);
  }
});

const modeControl = createSegmentedControl<EditorMode>({
  ariaLabel: 'Markdown mode',
  className: 'mode-group',
  buttonClassName: 'mode-button',
  datasetKey: 'mode',
  role: 'tablist',
  options: [
    { value: 'live', label: 'Live' },
    { value: 'source', label: 'Source' },
    { value: 'preview', label: 'Preview' }
  ]
});
const modeGroup = modeControl.element;
const liveButton = modeControl.getButton('live');
const sourceButton = modeControl.getButton('source');
const previewButton = modeControl.getButton('preview');

const toolbarOverflowIndicator = document.createElement('span');
toolbarOverflowIndicator.className = 'toolbar-overflow-indicator';
toolbarOverflowIndicator.setAttribute('aria-hidden', 'true');
toolbarOverflowIndicator.appendChild(createElement(Ellipsis, { width: 18, height: 18 }));

const toolbarRight = document.createElement('div');
toolbarRight.className = 'toolbar-right';
toolbarRight.append(rightGroup, modeGroup);

const findPanelElements = createFindPanel(findToggleBtn);
const findPanelController = createFindPanelController(
  findPanelElements,
  () => getActiveEditorMode() === 'preview' ? previewController.getSearchAdapter() : editor,
  toolbar,
  modeGroup,
  () => {
    if (getActiveEditorMode() === 'preview') {
      return previewController.getSelectedText();
    }
    for (const textarea of root.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea')) {
      if (textarea.selectionEnd > textarea.selectionStart) {
        return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      }
    }
    return '';
  }
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

toolbar.replaceChildren(formatGroup, previewFormatGroup, toolbarOverflowIndicator, toolbarRight, findPanelElements.panel, editorNoticeBanner);

const toolbarOverflowHomes = new Map<HTMLElement, Comment>();
let toolbarOverflowLayoutKey = '';

const restoreToolbarOverflowItems = (): void => {
  for (const [item, home] of toolbarOverflowHomes) {
    home.replaceWith(item);
    item.classList.remove('is-toolbar-overflow-item');
  }
  toolbarOverflowHomes.clear();
  toolbarOverflowSection.hidden = true;
  moreToolsWrapper.classList.remove('has-toolbar-overflow-items');
};

const moveToolbarItemToMore = (item: HTMLElement): void => {
  const home = document.createComment('toolbar overflow home');
  item.before(home);
  toolbarOverflowHomes.set(item, home);
  item.classList.add('is-toolbar-overflow-item');
  toolbarOverflowSection.append(item);
};

const syncToolbarOverflow = () => {
  const nextLayoutKey = `${toolbar.clientWidth}:${rightGroup.offsetWidth}:${root.dataset.mode ?? ''}`;
  if (nextLayoutKey === toolbarOverflowLayoutKey) return;
  toolbarOverflowLayoutKey = nextLayoutKey;
  restoreToolbarOverflowItems();

  const toolbarBounds = toolbar.getBoundingClientRect();
  const visibleLeftGroup = previewFormatGroup.getClientRects().length > 0
    ? previewFormatGroup
    : formatGroup;
  const leftItems = Array.from(visibleLeftGroup.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement && getComputedStyle(child).display !== 'none'
  ));
  let rightBoundary = toolbarRight.getBoundingClientRect().left;
  const hasOverflow = leftItems.some((item) => item.getBoundingClientRect().right > rightBoundary);

  if (!hasOverflow) {
    toolbarOverflowIndicator.hidden = true;
    if (visibleLeftGroup === previewFormatGroup) setMoreToolsVisible(false);
    return;
  }

  // Reserve the existing More button before selecting the suffix to migrate.
  // The moved controls remain the authoritative nodes and retain their state/listeners.
  moreToolsWrapper.classList.add('has-toolbar-overflow-items');
  toolbarOverflowSection.hidden = false;
  rightBoundary = toolbarRight.getBoundingClientRect().left;

  const indicatorWidth = 24;
  const indicatorGap = 4;
  let visibleCount = 0;
  for (const item of leftItems) {
    if (item.getBoundingClientRect().right + indicatorGap + indicatorWidth > rightBoundary) break;
    visibleCount += 1;
  }

  while (visibleCount > 0 && leftItems[visibleCount - 1].classList.contains('format-separator')) {
    visibleCount -= 1;
  }

  leftItems.slice(visibleCount).forEach(moveToolbarItemToMore);

  const leftGroupBounds = visibleLeftGroup.getBoundingClientRect();
  const indicatorLeft = visibleCount > 0
    ? leftItems[visibleCount - 1].getBoundingClientRect().right - toolbarBounds.left + indicatorGap
    : leftGroupBounds.left - toolbarBounds.left;
  toolbarOverflowIndicator.style.left = `${indicatorLeft}px`;
  toolbarOverflowIndicator.hidden = false;
};

const toolbarResizeObserver = new ResizeObserver(syncToolbarOverflow);
toolbarResizeObserver.observe(toolbar);
toolbarResizeObserver.observe(formatGroup);
toolbarResizeObserver.observe(previewFormatGroup);
toolbarResizeObserver.observe(rightGroup);
toolbarResizeObserver.observe(modeGroup);
requestAnimationFrame(syncToolbarOverflow);

const existingEditorWrapper = root.querySelector('.editor-wrapper');
const editorWrapper = existingEditorWrapper instanceof HTMLElement ? existingEditorWrapper : document.createElement('div');
editorWrapper.className = 'editor-wrapper';
editorWrapper.classList.remove('meo-preload-editor-shell');
editorWrapper.removeAttribute('aria-hidden');

const existingEditorHost = editorWrapper.querySelector('.editor-host');
const editorHost = existingEditorHost instanceof HTMLElement ? existingEditorHost : document.createElement('div');
editorHost.className = 'editor-host';
const editorScrollToTopController = createDocumentScrollToTopController();
editorHost.appendChild(editorScrollToTopController.button);

let editor: any = null;
let outlineController: ReturnType<typeof createOutlineController>;
const mermaidDiagramRenderPool = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
const mermaidDiagramPresentationFactory = createMermaidDiagramPresentationFactory({
  resources: mermaidDiagramRenderPool,
  createHandle(view, resources) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources,
      normalizeSource: normalizeMermaidDiagramText
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    return {
      present(source, themeKey, configKey) {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose: () => runtime.dispose()
    };
  }
});
let resolveEditorAppearanceForPreview: () => 'light' | 'dark' = () => 'dark';
const codePaletteAdapter = createCodePaletteWebviewAdapter({ setShikiTheme });
let resolveCodePaletteForPreview = (appearance: 'light' | 'dark') => (
  codePaletteAdapter.resolve(undefined, appearance).preview
);
const previewController = createPreviewController({
  vscode,
  getEditorAppearance: () => resolveEditorAppearanceForPreview(),
  getCodePalette: (appearance) => resolveCodePaletteForPreview(appearance),
  mermaidRenderResources: mermaidDiagramRenderPool,
  onFindRequested: () => findPanelController.open('find'),
  onRendered: () => {
    if (outlineController?.isVisible()) {
      outlineController.refresh();
    }
  },
  onViewportInteraction: () => editor?.markViewportInteraction?.(),
  runViewportTransaction: (mutate) => {
    const viewport = editor?.captureViewportAnchorToken?.('preview') ?? null;
    if (!editor?.runViewportAnchorTransaction) {
      mutate();
      return;
    }
    editor.runViewportAnchorTransaction(viewport, 'preview', mutate);
  }
});
const previewAdapter = createPreviewWebviewAdapter(previewController);
previewAppearanceSlot.replaceWith(previewController.appearanceControl);
previewFontFamilySlot.replaceWith(previewController.fontFamilyControl);
previewSourceColoringSlot.replaceWith(previewController.sourceColoringControl);
outlineController = createOutlineController({
  root,
  editorWrapper,
  outlineButton: outlineBtn,
  outlineLeftButton: outlineLeftBtn,
  additionalOutlineLeftButtons: [previewOutlineLeftBtn],
  getEditor: () => getActiveEditorMode() === 'preview' ? previewController.getOutlineAdapter() : editor,
  onVisibilityRequest: (visible) => {
    vscode.postMessage({ type: 'setOutlineVisible', visible });
  },
  onPositionRequest: (position) => {
    vscode.postMessage({ type: 'setOutlinePosition', position });
  },
  onResizeEnd: () => {
    if (getActiveEditorMode() === 'preview') {
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

const editorModeApplication = createEditorModeApplication();
let editorModeRuntime: EditorModeRuntime;
const getActiveEditorMode = (): EditorMode => editorModeApplication.getState().mode;
const getActiveEditableMode = (): 'live' | 'source' => {
  const state = editorModeApplication.getState();
  return state.mode === 'preview' ? state.lastEditableMode : state.mode;
};
let pendingInitialText: string | null = null;
let gitClient: any = null;
let pendingEditorFocus = false;
let pendingDiagnostics: any[] = [];
let pendingRevealSelection: { anchor: number; head: number; focus?: boolean } | null = null;
let pendingRevealDocumentFragment: string | null = null;
let pendingEditorSurfaceRecoveryRaf: number | null = null;
let createEditorFactoryPromise: Promise<CreateEditorFactory> | null = null;
const INITIAL_EDITOR_MOUNT_FALLBACK_MS = 120;

const failureNotice = createFailureNoticeManager(editorNotice);
handleEditorNoticeDismiss = failureNotice.clearFailureNotice;

editorAppearanceControl.element.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.editor-appearance-button[data-editor-appearance]')
    : null;
  const appearance = button?.dataset.editorAppearance;
  if (appearance === 'auto' || appearance === 'light' || appearance === 'dark') {
    themeAdapter.setAppearance(appearance, { post: true });
  }
});

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

const persistUiState = (
  mode = getActiveEditorMode(),
  lastEditableMode = editorModeApplication.getState().lastEditableMode
) => {
  const state: WebviewUiState = {
    mode,
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
  if (typeof pendingInitialText === 'string') {
    return pendingInitialText;
  }
  return '';
};

const commitEditorTransientEdits = () => {
  editor?.commitTransientEdits?.();
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
  editor.revealSelection(clampedAnchor, clampedHead, {
    focusEditor: focus !== false,
    align: preserveViewport === true ? 'none' : 'center'
  });
  pendingRevealSelection = null;
};

const applyRevealDocumentFragmentFromHost = (href: unknown): void => {
  if (typeof href !== 'string' || !href.startsWith('#')) {
    return;
  }
  if (!editor) {
    pendingRevealDocumentFragment = href;
    return;
  }
  editor.revealDocumentFragment(href);
  pendingRevealDocumentFragment = null;
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
  editor?.setDiagnostics?.(nextDiagnostics);
};

gitClient = createGitClient();

const discardConfirmationWindowMs = 500;
let discardConfirmationTimer: number | null = null;
let pendingReloadViewport: { handle: ViewportAnchorToken; owner: 'editor' | 'preview' } | null = null;

const clearDiscardConfirmation = () => {
  if (discardConfirmationTimer !== null) {
    window.clearTimeout(discardConfirmationTimer);
    discardConfirmationTimer = null;
  }
  discardBtn.classList.remove('is-discard-armed');
};

const discardUnsavedChanges = () => {
  const previewActive = getActiveEditorMode() === 'preview';
  const position = previewActive
    ? previewController.getTopVisiblePosition()
    : getTopVisiblePosition();
  const viewportHandle = editor?.captureViewportAnchorToken?.(previewActive ? 'preview' : 'editor') ?? null;
  pendingReloadViewport = viewportHandle
    ? { handle: viewportHandle, owner: previewActive ? 'preview' : 'editor' }
    : null;
  commitEditorTransientEdits();
  documentSessionAdapter.requestReloadFromDisk({
    topLine: position?.topLine ?? 1,
    topLineOffset: position?.topLineOffset ?? 0
  });
};

discardBtn.addEventListener('click', () => {
  if (discardConfirmationTimer !== null) {
    clearDiscardConfirmation();
    discardUnsavedChanges();
    return;
  }
  discardBtn.classList.add('is-discard-armed');
  discardConfirmationTimer = window.setTimeout(clearDiscardConfirmation, discardConfirmationWindowMs);
});

const setEditorTextSafely = async (
  text: string,
  context: string,
  resetHistory = false
): Promise<boolean> => {
  const basisManualIntentId = editorModeApplication.getState().manualIntent?.id ?? 0;
  if (!editor) {
    return false;
  }

  try {
    editor.setText(text, resetHistory);
    return true;
  } catch (error) {
    logWebviewRenderError('setText', error, { context });

    if (getActiveEditorMode() === 'live') {
      try {
        editor.setText(text, resetHistory);
        failureNotice.clearFailureNotice();
        return true;
      } catch (retryInLiveError) {
        logWebviewRenderError('setText.retryInLive', retryInLiveError, { context });
        if (!shouldAutoFallbackToSourceForLiveError(retryInLiveError)) {
          failureNotice.setFailureNotice(activeUiStrings.transientUpdateFailure, 'warning');
          return false;
        }
      }

      failureNotice.setFailureNotice(activeUiStrings.liveModeFailure, 'warning');
      await editorModeRuntime.dispatch({
        type: 'requestMode', mode: 'source', source: 'render-failure', basisManualIntentId
      });
      if (!editor || getActiveEditorMode() !== 'source') return false;
      try {
        editor.setText(text, resetHistory);
        return true;
      } catch (retryError) {
        logWebviewRenderError('setText.retryInSource', retryError, { context });
        failureNotice.setFailureNotice(activeUiStrings.editorUpdateFailure, 'error');
        return false;
      }
    }

    failureNotice.setFailureNotice(activeUiStrings.editorUpdateFailure, 'error');
    return false;
  }
};

const viewportPresentationFailed = Object.freeze({});
let pendingDocumentDerivedText = '';
const runDocumentDerivedUiRefresh = (): void => {
  const operations: ReadonlyArray<readonly [string, () => void]> = [
    ['outline', () => { if (outlineController.isVisible()) outlineController.refresh(); }],
    ['wikiLinks', () => scheduleWikiLinkStatusRefresh(pendingDocumentDerivedText)],
    ['localLinks', () => scheduleLocalLinkStatusRefresh(pendingDocumentDerivedText)],
    ['findSummary', () => findPanelController.updateFindStatusSummary()]
  ];
  for (const [name, run] of operations) {
    try {
      run();
    } catch (error) {
      logWebviewRenderError(`documentDerived.${name}`, error);
    }
  }
};
const scheduleDocumentDerivedUiRefresh = (text: string): void => {
  pendingDocumentDerivedText = text;
  editor?.requestDerivedWork(runDocumentDerivedUiRefresh);
};

const presentDocumentText = async (
  text: string,
  source: DocumentPresentationSource
): Promise<boolean> => {
  if (!editor) {
    pendingInitialText = text;
    return true;
  }

  const previewActive = getActiveEditorMode() === 'preview';
  const owner = previewActive ? 'preview' : 'editor';
  const viewport = source === 'disk-reload' && pendingReloadViewport?.owner === owner
    ? pendingReloadViewport.handle
    : editor.captureViewportAnchorToken?.(owner) ?? null;
  let presented = false;
  const present = async (isViewportCurrent: () => boolean): Promise<void> => {
    presented = await setEditorTextSafely(text, `documentSession.${source}`, source === 'disk-reload');
    if (!presented) throw viewportPresentationFailed;
    if (previewActive) {
      previewAdapter.refreshVisible(text, { preserveViewport: !isViewportCurrent() });
    }
  };
  try {
    if (editor.runViewportAnchorTransaction) {
      await editor.runViewportAnchorTransaction(viewport, owner, present);
    } else {
      await present(() => false);
    }
  } catch (error) {
    if (error === viewportPresentationFailed) return false;
    throw error;
  }
  scheduleDocumentDerivedUiRefresh(text);
  return true;
};

const documentSessionAdapter = createDocumentSessionWebviewAdapter({
  postMessage: (message) => vscode.postMessage(message),
  presentText: presentDocumentText,
  restoreReloadedView: (message) => {
    void message;
    pendingReloadViewport = null;
  },
  showFailureNotice: (message) => failureNotice.setFailureNotice(message, 'warning'),
  reportUnexpectedError: (context, error) => {
    console.error(`[MEO webview] Document Session ${context}`, error);
  }
});

const documentSaveFlushAdapter = createDocumentSaveFlushWebviewAdapter({
  postMessage: (message) => vscode.postMessage(message),
  commitTransientEdits: commitEditorTransientEdits,
  getCurrentText: getCurrentEditorText,
  whenDocumentIdle: () => documentSessionAdapter.whenIdle()
});

const requestSave = () => {
  commitEditorTransientEdits();
  documentSessionAdapter.requestSave();
};

saveBtn.addEventListener('click', () => {
  void requestSave();
});

const shortcutHandlerContext: ShortcutHandlerContext = {
  get editor() { return editor; },
  get editableMode() { return getActiveEditableMode(); },
  requestSave,
  openFindPanel: (target) => findPanelController.open(target),
  requestMode: (mode) => {
    void editorModeRuntime.dispatch({ type: 'requestMode', mode, source: 'user' });
  }
};

const handleLocalEditorChange = (nextText: string) => {
  documentSessionAdapter.localDraftChanged(nextText);
  scheduleDocumentDerivedUiRefresh(nextText);
};

const mountEditorForMode = async (mode: 'live' | 'source', signal: AbortSignal): Promise<void> => {
  if (editor) return;
  const createEditor = await loadCreateEditorFactory();
  if (signal.aborted) return;
  const initialText = pendingInitialText;
  if (signal.aborted || editor || initialText === null) return;

  editor = createEditor({
    parent: editorHost,
    text: initialText,
    initialMode: mode,
    initialGitGutter: gitChangesGutterVisible,
    initialDiagnostics: pendingDiagnostics,
    onApplyChanges: handleLocalEditorChange,
    onOpenLink: (href: string) => vscode.postMessage({ type: 'openLink', href }),
    onSelectionChange: (state: any) => selectionMenuController.update(state),
    mermaidDiagramPresentationFactory,
    uiLanguage: activeUiLanguage,
    previewViewportSurface: {
      captureTopVisiblePosition() {
        const position = previewController.getTopVisiblePosition();
        return position ? { line: position.topLine, lineOffset: position.topLineOffset } : null;
      },
      restoreTopVisiblePosition(position, isCurrent) {
        previewController.restoreTopVisiblePosition(position, isCurrent);
      }
    }
  });
  editorScrollToTopController.setScrollElement(editor.view.scrollDOM);
  gitClient?.applyBaselineToEditor(editor);
  syncGitDiffLineHighlights();
  editor.focus();
  pendingInitialText = null;
  if (mode === 'live') failureNotice.clearFailureNotice();
  requestWikiLinkStatuses(initialText);
  requestLocalLinkStatuses(initialText);
  if (pendingRevealSelection) applyRevealSelectionFromHost(pendingRevealSelection);
  if (pendingRevealDocumentFragment) applyRevealDocumentFragmentFromHost(pendingRevealDocumentFragment);
  if (pendingEditorFocus) focusEditorFromHost();
  if (outlineController.isVisible()) outlineController.refresh();
  failureNotice.updateEditorNotice();
  setWikiLinkRefreshContext({ refreshDecorations: () => editor?.refreshDecorations?.() });
  setLocalLinkRefreshContext({ refreshDecorations: () => editor?.refreshDecorations?.() });
  scheduleEditorSurfaceRecovery();
};

const editorModeEffectAdapter = createEditorModeEffectAdapter({
  commitTransientEdits: commitEditorTransientEdits,
  scheduleMount(run) {
    let active = true;
    let fallbackTimer: number | null = null;
    const finish = () => {
      if (!active) return;
      active = false;
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      run();
      findPanelController.updateFindStatusSummary();
    };
    const frame = window.requestAnimationFrame(finish);
    fallbackTimer = window.setTimeout(finish, INITIAL_EDITOR_MOUNT_FALLBACK_MS);
    return () => {
      if (!active) return;
      active = false;
      window.cancelAnimationFrame(frame);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  },
  mountEditor: mountEditorForMode,
  applyEditorMode(mode, viewport) {
    if (!editor) throw new Error('Editor is not mounted');
    editor.setMode(mode, viewport);
    syncGitDiffLineHighlights();
    if (outlineController.isVisible()) outlineController.refresh();
    if (mode === 'live') failureNotice.clearFailureNotice();
    failureNotice.updateEditorNotice();
  },
  setPreviewActive(active) {
    previewAdapter.setActive({
      active,
      text: getCurrentEditorText()
    });
    if (active && document.activeElement instanceof HTMLElement && editorHost.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    syncGitDiffLineHighlights();
  },
  setEditorVisible(visible) {
    editorHost.hidden = !visible;
  },
  presentModeControl(mode) {
    root.dataset.mode = mode;
    modeControl.setActive(mode);
  },
  closeFind: () => findPanelController.close(),
  setSearchOwner: () => findPanelController.updateFindStatusSummary(),
  setOutlineOwner: () => {
    if (outlineController.isVisible()) outlineController.refresh();
  },
  setReplaceEnabled(enabled) {
    for (const control of [
      findPanelElements.replaceInput,
      findPanelElements.replaceClearBtn,
      findPanelElements.replaceBtn,
      findPanelElements.replaceAllBtn
    ]) control.disabled = !enabled;
  },
  hideSelectionMenu: () => selectionMenuController.hide(),
  captureViewport() {
    return editor?.captureViewportAnchorToken?.(editorHost.hidden ? 'preview' : 'editor') ?? null;
  },
  restoreViewport(viewport, owner) {
    editor?.restoreViewportAnchorToken?.(viewport, owner);
  },
  focusEditor: () => editor?.focus(),
  persistMode: (mode, lastEditableMode) => persistUiState(mode, lastEditableMode),
  postMode: (mode) => vscode.postMessage({ type: 'setMode', mode }),
  showNotice(notice) {
    if (notice === 'transient-live') {
      failureNotice.setFailureNotice(activeUiStrings.transientModeFailure, 'warning');
    } else if (notice === 'live-fallback') {
      failureNotice.setFailureNotice(activeUiStrings.liveModeFailure, 'warning');
    } else if (notice === 'mount-retry') {
      failureNotice.setFailureNotice(activeUiStrings.transientLoadRetry, 'warning');
    } else if (notice === 'mount-failure') {
      failureNotice.setFailureNotice(activeUiStrings.transientLoadFailure, 'warning');
    } else {
      failureNotice.setFailureNotice(activeUiStrings.editorUpdateFailure, 'error');
    }
    failureNotice.updateEditorNotice();
  },
  reportError: (operation, error) => logWebviewRenderError(`editorMode.${operation}`, error),
  classifyError(error, operation) {
    logWebviewRenderError(`editorMode.${operation}`, error);
    if (operation === 'apply-source' || operation === 'mount-source') return 'fatal';
    return shouldAutoFallbackToSourceForLiveError(error) ? 'live-incompatible' : 'transient-live';
  },
  dispose() {
    editor?.destroy?.();
    editor = null;
  }
});

editorModeRuntime = createEditorModeRuntime(
  editorModeApplication,
  editorModeEffectAdapter,
  (error) => logWebviewRenderError('editorMode.runtime', error)
);

const handleInit = (message: InitMessage) => {
  applyUiLanguage(message.uiLanguage);
  if (typeof message.contentMaxWidthEnabled === 'boolean') {
    setContentMaxWidthEnabled(message.contentMaxWidthEnabled, { post: false });
  }
  if (!editor) {
    pendingInitialText = message.text;
  } else {
    setEditorTextSafely(message.text, 'init');
  }
  if (typeof message.gitChangesGutter === 'boolean') {
    setGitChangesGutterVisible(message.gitChangesGutter, { post: false });
  }
  if (message.diffBaselineMode === 'current-edit' || message.diffBaselineMode === 'recent-save' || message.diffBaselineMode === 'git-head') {
    setDiffBaselineMode(message.diffBaselineMode, { post: false });
  }
  if (typeof message.fixedBaselinePinned === 'boolean' && typeof message.fixedBaselineActive === 'boolean') {
    setFixedBaselineState(message.fixedBaselinePinned, message.fixedBaselineActive);
  }
  if (typeof message.gitDiffLineHighlights === 'boolean') {
    gitDiffLineHighlightsEnabled = message.gitDiffLineHighlights;
    syncGitDiffLineHighlights();
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

const exportAdapter = createExportWebviewAdapter({
  postMessage: (message) => vscode.postMessage(message),
  getCurrentText: getCurrentEditorText,
  whenDocumentIdle: () => documentSessionAdapter.whenIdle(),
  getPreviewAppearance: () => previewAdapter.getAppearance(),
  getStyleEnvironment: () => previewController.getStyleEnvironment()
});

const themeAdapter = createAppearanceWebviewAdapter({
  setAppearanceControl: (appearance) => editorAppearanceControl.setActive(appearance),
  applyAppearance: applyBuiltInVisualBaseline,
  resolveCodePalette: codePaletteAdapter.resolve,
  applyCodePalette: codePaletteAdapter.apply,
  refreshMermaidTheme: () => mermaidDiagramRenderPool.refreshTheme(),
  applyWithEditorViewportPreserved: (action) => {
    if (editor) editor.preserveViewport(action);
    else action();
  },
  refreshEditorDecorations: () => editor?.refreshDecorations(),
  refreshPreview: () => previewAdapter.refreshVisible(getCurrentEditorText()),
  syncPreviewAutoAppearance: () => previewController.syncAutoAppearance(),
  postEditorAppearance: (appearance) => {
    vscode.postMessage({ type: 'setEditorAppearance', appearance });
  },
  reportUnexpectedError: (context, error) => {
    console.error(`[MEO webview] ${context}`, error);
  }
});
resolveEditorAppearanceForPreview = () => themeAdapter.getAppearance();
resolveCodePaletteForPreview = (appearance) => themeAdapter.getCodePalette(appearance).preview;

const withMessageErrorBoundary = (context: string, action: () => void): void => {
  try {
    action();
  } catch (error) {
    console.error(`[MEO webview] ${context}`, error);
  }
};

window.addEventListener('message', (event) => {
  const rawMessage: unknown = event.data;

  if (!rawMessage || typeof rawMessage !== 'object') {
    return;
  }

  const message = decodeHostToWebviewMessage(rawMessage);
  if (!message) {
    return;
  }

  if (message.type === 'init') {
    acknowledgeReadyHandshake();
    withMessageErrorBoundary('init handler', () => {
      themeAdapter.start({
        vscodeTheme: message.vscodeTheme,
        appearance: message.editorAppearance
      });
      failureNotice.clearFailureNotice();
      documentSessionAdapter.start(message);
      previewAdapter.start({
        text: message.text,
        appearance: message.previewAppearance,
        fontFamily: message.previewFontFamily,
        sourceColoring: message.previewSourceColoring,
        active: false
      });

      handleInit(message);
      void editorModeRuntime.dispatch({ type: 'initialize', hostMode: message.mode })
        .then(() => failureNotice.updateEditorNotice());
    });
    return;
  }

  if (themeAdapter.accept(message)) {
    return;
  }


  if (message.type === 'revealSelection') {
    applyRevealSelectionFromHost(message);
    return;
  }

  if (message.type === 'revealDocumentFragment') {
    applyRevealDocumentFragmentFromHost(message.href);
    return;
  }

  if (message.type === 'focusEditor') {
    focusEditorFromHost();
    return;
  }

  if (message.type === 'toggleMode') {
    void editorModeRuntime.dispatch({ type: 'toggleMode', source: 'host-command' });
    return;
  }

  if (previewAdapter.accept(message)) {
    return;
  }

  if (documentSessionAdapter.accept(message)) {
    return;
  }

  if (documentSaveFlushAdapter.accept(message)) {
    return;
  }


  if (message.type === 'gitChangesGutterChanged') {
    setGitChangesGutterVisible(message.enabled, { post: false });
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

  if (message.type === 'fixedBaselineChanged') {
    setFixedBaselineState(message.pinned === true, message.active === true);
    return;
  }

  if (message.type === 'contentMaxWidthChanged') {
    setContentMaxWidthEnabled(message.enabled, { post: false });
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

  if (message.type === 'diagnosticsChanged') {
    applyDiagnosticsFromHost(message.diagnostics);
    return;
  }

  if (message.type === 'outlinePositionChanged') {
    outlineController.setPosition(message.position);
    return;
  }

  if (message.type === 'resolvedImageSrc') {
    settleImageSrcRequest(message);
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

  if (exportAdapter.accept(message)) {
    return;
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
    onError: (message) => failureNotice.setFailureNotice(activeUiStrings.pasteImageFailure(message), 'warning')
  });
});

window.addEventListener('blur', commitEditorTransientEdits);

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (pendingEditorSurfaceRecoveryRaf !== null) {
      window.cancelAnimationFrame(pendingEditorSurfaceRecoveryRaf);
      pendingEditorSurfaceRecoveryRaf = null;
    }
    commitEditorTransientEdits();
    return;
  }
  scheduleEditorSurfaceRecovery();
});

window.addEventListener('focus', () => {
  scheduleEditorSurfaceRecovery();
});

window.addEventListener('beforeunload', () => {
  clearReadyRetryTimers();
  cancelPendingWikiStatusRefresh();
  cancelPendingLocalLinkStatusRefresh();
  documentSessionAdapter.dispose();
  documentSaveFlushAdapter.dispose();
  previewAdapter.dispose();
  exportAdapter.dispose();
  if (pendingEditorSurfaceRecoveryRaf !== null) {
    window.cancelAnimationFrame(pendingEditorSurfaceRecoveryRaf);
    pendingEditorSurfaceRecoveryRaf = null;
  }
  commitEditorTransientEdits();
  editorModeRuntime.dispose();
  mermaidDiagramPresentationFactory.dispose();
  mermaidDiagramRenderPool.dispose();
});

window.addEventListener('resize', () => {
  findPanelController.updateAnchor();
  if (editor) {
    editor.refreshSelectionOverlay();
  }
});

const state = vscode.getState() as WebviewUiState | undefined;
if (state && (state.mode === 'live' || state.mode === 'source' || state.mode === 'preview')) {
  const restoredEditableMode = state.lastEditableMode === 'live' || state.lastEditableMode === 'source'
    ? state.lastEditableMode
    : state.mode === 'preview' ? 'live' : state.mode;
  void editorModeRuntime.dispatch({
    type: 'restoreLocal',
    mode: state.mode,
    lastEditableMode: restoredEditableMode
  });
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
updateGitChangesGutterUI();

liveButton.addEventListener('click', () => {
  void editorModeRuntime.dispatch({
    type: 'requestMode', mode: 'live', source: 'user',
    restoreEditorFocus: editor?.hasFocus() === true
  });
});

sourceButton.addEventListener('click', () => {
  void editorModeRuntime.dispatch({
    type: 'requestMode', mode: 'source', source: 'user',
    restoreEditorFocus: editor?.hasFocus() === true
  });
});

previewButton.addEventListener('click', () => {
  void editorModeRuntime.dispatch({
    type: 'requestMode', mode: 'preview', source: 'user',
    restoreEditorFocus: editor?.hasFocus() === true
  });
});

const preserveEditorFocusOnModePointerToggle = (event: PointerEvent) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('.mode-button')) {
    return;
  }
  if (!editor || !editor.hasFocus()) {
    return;
  }
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
  exportAdapter.requestExport('html');
});
exportPdfOption.addEventListener('click', () => {
  exportAdapter.requestExport('pdf');
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
gitChangesGutterBtn.addEventListener('click', toggleGitChangesGutter);
fixedBaselineBtn.addEventListener('pointerdown', (event) => {
  if (event.button === 0 && editor?.hasFocus()) {
    event.preventDefault();
  }
});
fixedBaselineBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'setFixedBaseline', enabled: !fixedBaselineActive });
});
releaseFixedBaselineBtn.addEventListener('click', () => {
  if (!fixedBaselinePinned) {
    return;
  }
  vscode.postMessage({ type: 'releaseFixedBaseline' });
  setMoreToolsVisible(false);
});
scheduleReadyHandshake();
scheduleEditorBundleWarmupAfterReady();
