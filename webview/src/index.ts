import { createElement, Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, List, ListOrdered, SquareCheck, ListTree, Hash, Code, SquareCode, Terminal, Quote, Minus, Plus, Table2, Link, Unlink, Brackets, Image, Bold, Italic, Strikethrough, Search, FileCode2, FileText, Save, HardDriveUpload, PanelLeftRightDashed, SquareSplitHorizontal, Settings, Check, Ellipsis, Sun, Moon, ExternalLink, History } from 'lucide';
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
import {
  createEditorModeApplication,
  type EditorMode,
  type EditorModeViewportToken
} from './application/editorMode';
import type { DocumentPresentationSource } from '../../src/application/documentSession';
import { createEditorModeEffectAdapter } from './adapters/editorModeEffectAdapter';
import { createEditorModeRuntime, type EditorModeRuntime } from './adapters/editorModeRuntime';
import { decodeHostToWebviewMessage } from '../../src/protocol/messages';
import type { EditorAppearance } from '../../src/protocol/editorCommands';
import type { GitBaselinePayload } from '../../src/protocol/git';
import type { InitMessage } from '../../src/protocol/readyInit';
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  normalizeEditorFontSize,
  type EditorFontSizeMode,
  type EditorFontSizePreference
} from '../../src/foundation/editorFontSize';
import type { UiLanguagePreference } from '../../src/foundation/uiLanguage';
import { getUiStrings, type UiLanguage } from './application/uiLanguage';
import { createChangesReviewControl } from './adapters/changesReviewControl';
import type { ChangesReviewDiffSummary } from './application/changesReview';
import { setGitDiffDetailsVisible } from './helpers/gitDiffDetails';
import { createReadingPositionLifecycle, type ReadingPositionLifecycle } from './application/readingPositionLifecycle';

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
let activeUiLanguagePreference: UiLanguagePreference = 'auto';
let automaticUiLanguage: UiLanguage = 'en';

const existingToolbar = root.querySelector('.mode-toolbar');
const toolbar = existingToolbar instanceof HTMLElement ? existingToolbar : document.createElement('div');
toolbar.classList.add('mode-toolbar', 'meo-preload-toolbar');
toolbar.setAttribute('aria-hidden', 'true');
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', activeUiStrings.editorToolbar);

const formatGroup = document.createElement('div');
formatGroup.className = 'format-group';
formatGroup.setAttribute('role', 'group');
formatGroup.setAttribute('aria-label', activeUiStrings.formatting);

const headingBtn = document.createElement('button');
headingBtn.type = 'button';
headingBtn.className = 'format-button';
headingBtn.dataset.action = 'heading';
headingBtn.title = activeUiStrings.heading;
headingBtn.appendChild(createElement(Heading, { width: 18, height: 18 }));

const headingDropdown = document.createElement('div');
headingDropdown.className = 'heading-dropdown';
headingDropdown.setAttribute('role', 'menu');
headingDropdown.setAttribute('aria-label', activeUiStrings.headingLevels);

const headingDropdownWrapper = document.createElement('div');
headingDropdownWrapper.className = 'heading-dropdown-wrapper';

const headingIcons = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6];

for (let level = 1; level <= 6; level++) {
  const option = document.createElement('button');
  option.type = 'button';
  option.className = 'heading-dropdown-option';
  option.dataset.level = String(level);
  option.title = activeUiStrings.headingLevel(level);
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
bulletListBtn.title = activeUiStrings.bulletList;
bulletListBtn.appendChild(createElement(List, { width: 18, height: 18 }));

const numberedListBtn = document.createElement('button');
numberedListBtn.type = 'button';
numberedListBtn.className = 'format-button';
numberedListBtn.dataset.action = 'numberedList';
numberedListBtn.title = activeUiStrings.numberedList;
numberedListBtn.appendChild(createElement(ListOrdered, { width: 18, height: 18 }));

const taskBtn = document.createElement('button');
taskBtn.type = 'button';
taskBtn.className = 'format-button';
taskBtn.dataset.action = 'task';
taskBtn.title = activeUiStrings.task;
taskBtn.appendChild(createElement(SquareCheck, { width: 18, height: 18 }));

let gitChangesGutterVisible = false;
let gitDiffLineHighlightsEnabled = false;
let diffBaselineMode: 'current-edit' | 'recent-save' | 'git-head' = 'current-edit';
let fixedBaselinePinned = false;
let fixedBaselineActive = false;
let fixedBaselineUpdatedAt: number | null = null;
let gitDiffDetailsVisible = false;
// Baseline selection events arrive before the matching editor transaction. Keep
// this projection until the editor updates markers and counts from the same state.
let gitDiffSummary: ChangesReviewDiffSummary = { status: 'pending', added: 0, deleted: 0 };
let gitBaselineState: GitBaselinePayload | null = null;
let changesReviewMode: 'live' | 'source' | 'preview' = 'live';
let contentMaxWidthEnabled = false;
let tableStickyHeaderEnabled = true;
let restoreReadingPositionOnOpen = true;
let outlineUiState: { mode: 'floating' | 'fixed'; width: number } = { mode: 'fixed', width: 260 };

const CONTENT_MAX_WIDTH_ENABLED_VALUE = '800px';

const createOutlineButton = (position: 'left' | 'right') => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'format-button toggle-button';
  button.dataset.action = `outline-${position}`;
  button.title = position === 'left' ? activeUiStrings.showOutlineLeft : activeUiStrings.showOutlineRight;
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
  const toggle = document.createElement('span');
  toggle.className = 'menu-switch';
  toggle.setAttribute('aria-hidden', 'true');
  button.append(iconElement, label, toggle);
};

const contentMaxWidthBtn = document.createElement('button');
contentMaxWidthBtn.type = 'button';
contentMaxWidthBtn.className = 'more-tools-option more-tools-toggle-option';
contentMaxWidthBtn.dataset.action = 'contentMaxWidth';
contentMaxWidthBtn.title = activeUiStrings.constrainContentWidth;
contentMaxWidthBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(contentMaxWidthBtn, PanelLeftRightDashed, activeUiStrings.constrainContentWidth);

const sourceLineNumbersBtn = document.createElement('button');
sourceLineNumbersBtn.type = 'button';
sourceLineNumbersBtn.className = 'more-tools-option more-tools-toggle-option is-active';
sourceLineNumbersBtn.dataset.action = 'sourceLineNumbers';
sourceLineNumbersBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(sourceLineNumbersBtn, Hash, activeUiStrings.showLineNumbers);

const longCodeBlockFoldingBtn = document.createElement('button');
longCodeBlockFoldingBtn.type = 'button';
longCodeBlockFoldingBtn.className = 'more-tools-option more-tools-toggle-option is-active';
longCodeBlockFoldingBtn.dataset.action = 'longCodeBlockFolding';
longCodeBlockFoldingBtn.setAttribute('role', 'menuitemcheckbox');
appendMoreToolsOptionContent(longCodeBlockFoldingBtn, Code, activeUiStrings.foldLongCodeBlocks);

const tableStickyHeaderBtn = document.createElement('button');
tableStickyHeaderBtn.type = 'button';
tableStickyHeaderBtn.className = 'more-tools-option more-tools-toggle-option is-active';
tableStickyHeaderBtn.dataset.action = 'tableStickyHeader';
tableStickyHeaderBtn.setAttribute('role', 'menuitemcheckbox');
tableStickyHeaderBtn.setAttribute('aria-checked', 'true');
appendMoreToolsOptionContent(tableStickyHeaderBtn, Table2, activeUiStrings.stickyTableHeader);

const restoreReadingPositionBtn = document.createElement('button');
restoreReadingPositionBtn.type = 'button';
restoreReadingPositionBtn.className = 'more-tools-option more-tools-toggle-option is-active';
restoreReadingPositionBtn.dataset.action = 'restoreReadingPosition';
restoreReadingPositionBtn.setAttribute('role', 'menuitemcheckbox');
restoreReadingPositionBtn.setAttribute('aria-checked', 'true');
appendMoreToolsOptionContent(restoreReadingPositionBtn, History, activeUiStrings.resumeFromLastPosition);

const changesReviewControl = createChangesReviewControl({
  uiLanguage: activeUiLanguage,
  onIntent(intent) {
    if (intent.type === 'selectBaseline') {
      if (intent.baseline === 'none') {
        setGitChangesGutterVisible(false);
      } else {
        setDiffBaselineMode(intent.baseline);
        setGitChangesGutterVisible(true);
      }
    }
    if (intent.type === 'selectManualSnapshot' && fixedBaselinePinned && (!fixedBaselineActive || !gitChangesGutterVisible)) {
      vscode.postMessage({ type: 'setFixedBaseline', enabled: true });
      setGitChangesGutterVisible(true);
    }
    if (intent.type === 'createManualSnapshot') {
      vscode.postMessage({ type: 'setFixedBaseline', enabled: true });
      setGitChangesGutterVisible(true);
    }
    if (intent.type === 'updateManualSnapshot') {
      vscode.postMessage({ type: 'updateFixedBaseline' });
    }
    if (intent.type === 'setBeforeContentVisible') setGitDiffDetailsVisibleState(intent.visible);
  }
});
const changesControls = changesReviewControl.element;
changesControls.classList.add('changes-controls', 'preview-hidden-toolbar-control');

const presentChangesReview = () => {
  changesReviewControl.present({
    mode: changesReviewMode,
    baseline: fixedBaselineActive ? 'manual' : diffBaselineMode,
    summary: gitDiffSummary,
    markersVisible: gitChangesGutterVisible,
    beforeContentVisible: gitDiffDetailsVisible,
    gitBaseline: gitBaselineState,
    manualSnapshot: { exists: fixedBaselinePinned, updatedAt: fixedBaselineUpdatedAt }
  });
};

const updateGitChangesGutterUI = () => {
  presentChangesReview();
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
  if (post && (changed || leavesFixedBaseline || !gitChangesGutterVisible)) {
    vscode.postMessage({ type: 'setDiffBaselineMode', mode });
  }
};

const setFixedBaselineState = (pinned: boolean, active: boolean, updatedAt?: number | null) => {
  const nextActive = pinned && active;
  const nextUpdatedAt = pinned ? updatedAt ?? fixedBaselineUpdatedAt : null;
  fixedBaselinePinned = pinned;
  fixedBaselineActive = nextActive;
  fixedBaselineUpdatedAt = nextUpdatedAt;
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
    getActiveEditorMode() === 'source'
      && gitChangesGutterVisible && (gitDiffDetailsVisible || gitDiffLineHighlightsEnabled)
  );
};

const syncGitDiffDetails = () => {
  if (!editor) return;
  setGitDiffDetailsVisible(editor, getActiveEditorMode() === 'source' && gitChangesGutterVisible && gitDiffDetailsVisible);
};

const setGitDiffDetailsVisibleState = (
  visible: boolean,
  { post = true }: PostUpdateOptions = {}
) => {
  gitDiffDetailsVisible = visible === true;
  syncGitDiffDetails();
  syncGitDiffLineHighlights();
  presentChangesReview();
  if (post) vscode.postMessage({ type: 'setGitDiffDetailsVisible', visible: gitDiffDetailsVisible });
};

const updateTableStickyHeaderUI = () => {
  tableStickyHeaderBtn.classList.toggle('is-active', tableStickyHeaderEnabled);
  tableStickyHeaderBtn.setAttribute('aria-checked', tableStickyHeaderEnabled ? 'true' : 'false');
};

const updateRestoreReadingPositionUI = () => {
  restoreReadingPositionBtn.classList.toggle('is-active', restoreReadingPositionOnOpen);
  restoreReadingPositionBtn.setAttribute('aria-checked', restoreReadingPositionOnOpen ? 'true' : 'false');
  restoreReadingPositionBtn.title = activeUiStrings.resumeFromLastPosition;
};

type PostUpdateOptions = { post?: boolean };
type PersistedPostUpdateOptions = PostUpdateOptions & { persist?: boolean };

const setGitChangesGutterVisible = (visible: boolean, { post = true }: PostUpdateOptions = {}) => {
  const nextVisible = visible !== false;
  const changed = nextVisible !== gitChangesGutterVisible;
  if (changed) {
    gitChangesGutterVisible = nextVisible;
    editor?.setGitGutterVisible(gitChangesGutterVisible);
    if (!nextVisible) {
      editor?.setGitBaseline({ available: false, tracked: false, baseText: null });
    }
    syncGitDiffDetails();
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
  // Reading-area padding can rewrap lines/widgets without resizing the outer
  // scroller. Refresh their height map together before gutter paint.
  if (changed) refreshEditorSurface();
  updateContentMaxWidthUI();
  if (persist) {
    persistUiState();
  }
  if (post && changed) {
    vscode.postMessage({ type: 'setContentMaxWidth', enabled: contentMaxWidthEnabled });
  }
};

const setTableStickyHeaderEnabled = (
  enabled: boolean,
  { post = true }: PostUpdateOptions = {}
) => {
  const nextEnabled = enabled === true;
  const changed = nextEnabled !== tableStickyHeaderEnabled;
  tableStickyHeaderEnabled = nextEnabled;
  updateTableStickyHeaderUI();
  if (changed) editor?.setTableStickyHeaderEnabled(tableStickyHeaderEnabled);
  if (post && changed) {
    vscode.postMessage({ type: 'setTableStickyHeader', enabled: tableStickyHeaderEnabled });
  }
};

const setRestoreReadingPositionOnOpen = (
  enabled: boolean,
  { post = true }: PostUpdateOptions = {}
) => {
  const nextEnabled = enabled === true;
  const changed = nextEnabled !== restoreReadingPositionOnOpen;
  restoreReadingPositionOnOpen = nextEnabled;
  readingPositionLifecycle?.setEnabled(nextEnabled);
  updateRestoreReadingPositionUI();
  if (post && changed) {
    vscode.postMessage({ type: 'setRestoreReadingPositionOnOpen', enabled: nextEnabled });
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

const separator = document.createElement('div');
separator.className = 'format-separator';
separator.setAttribute('role', 'separator');

const codeBlockBtn = document.createElement('button');
codeBlockBtn.type = 'button';
codeBlockBtn.className = 'format-button';
codeBlockBtn.dataset.action = 'codeBlock';
codeBlockBtn.title = activeUiStrings.codeBlock;
codeBlockBtn.appendChild(createElement(SquareCode, { width: 18, height: 18 }));

const quoteBtn = document.createElement('button');
quoteBtn.type = 'button';
quoteBtn.className = 'format-button';
quoteBtn.dataset.action = 'quote';
quoteBtn.title = activeUiStrings.quote;
quoteBtn.appendChild(createElement(Quote, { width: 18, height: 18 }));

const hrBtn = document.createElement('button');
hrBtn.type = 'button';
hrBtn.className = 'format-button';
hrBtn.dataset.action = 'hr';
hrBtn.title = activeUiStrings.horizontalRule;
hrBtn.appendChild(createElement(Minus, { width: 18, height: 18 }));

const linkBtn = document.createElement('button');
linkBtn.type = 'button';
linkBtn.className = 'format-button';
linkBtn.dataset.action = 'link';
linkBtn.title = activeUiStrings.link;
linkBtn.appendChild(createElement(Link, { width: 18, height: 18 }));

const wikiLinkBtn = document.createElement('button');
wikiLinkBtn.type = 'button';
wikiLinkBtn.className = 'format-button';
wikiLinkBtn.dataset.action = 'wikiLink';
wikiLinkBtn.title = activeUiStrings.wikiLink;
wikiLinkBtn.appendChild(createElement(Brackets, { width: 18, height: 18 }));

const imageBtn = document.createElement('button');
imageBtn.type = 'button';
imageBtn.className = 'format-button';
imageBtn.dataset.action = 'image';
imageBtn.title = activeUiStrings.image;
imageBtn.appendChild(createElement(Image, { width: 18, height: 18 }));

const tableBtn = document.createElement('button');
tableBtn.type = 'button';
tableBtn.className = 'format-button';
tableBtn.dataset.action = 'table';
tableBtn.title = activeUiStrings.table;
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
lineJumpInput.placeholder = activeUiStrings.line;
lineJumpInput.inputMode = 'numeric';
lineJumpInput.autocomplete = 'off';
lineJumpInput.spellcheck = false;
lineJumpInput.setAttribute('aria-label', activeUiStrings.goToLine);

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
saveBtn.title = activeUiStrings.save;
saveBtn.setAttribute('aria-label', activeUiStrings.saveDocument);
saveBtn.appendChild(createElement(Save, { width: 18, height: 18 }));

const discardBtn = document.createElement('button');
discardBtn.type = 'button';
discardBtn.className = 'format-button';
discardBtn.dataset.action = 'discard';
discardBtn.title = activeUiStrings.reloadDiskVersion;
discardBtn.setAttribute('aria-label', activeUiStrings.reloadDiskVersion);
discardBtn.appendChild(createElement(HardDriveUpload, { width: 18, height: 18 }));

toolbar.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (
    event.button === 0 &&
    target instanceof Element &&
    target.closest('button') &&
    editor?.hasFocus()
  ) {
    // Toolbar commands operate on the current editor context. Retaining focus
    // prevents native blur from committing embedded editors and changing layout
    // before the command establishes its own viewport/document transaction.
    event.preventDefault();
  }
}, true);

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
findToggleBtn.title = activeUiStrings.findAndReplace;
findToggleBtn.appendChild(createElement(Search, { width: 18, height: 18 }));

const exportHtmlOption = document.createElement('button');
exportHtmlOption.type = 'button';
exportHtmlOption.className = 'preview-toolbar-action';
exportHtmlOption.dataset.format = 'html';
exportHtmlOption.title = activeUiStrings.exportAsHtml;
exportHtmlOption.setAttribute('aria-label', activeUiStrings.exportAsHtml);
const exportHtmlLabel = document.createElement('span');
exportHtmlLabel.className = 'preview-toolbar-action-label';
exportHtmlLabel.textContent = activeUiStrings.exportHtml;
exportHtmlOption.append(
  createElement(FileCode2, { width: 15, height: 15, 'aria-hidden': 'true' }),
  exportHtmlLabel
);

const exportPdfOption = document.createElement('button');
exportPdfOption.type = 'button';
exportPdfOption.className = 'preview-toolbar-action';
exportPdfOption.dataset.format = 'pdf';
exportPdfOption.title = activeUiStrings.exportAsPdf;
exportPdfOption.setAttribute('aria-label', activeUiStrings.exportAsPdf);
const exportPdfLabel = document.createElement('span');
exportPdfLabel.className = 'preview-toolbar-action-label';
exportPdfLabel.textContent = activeUiStrings.exportPdf;
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
previewFormatGroup.setAttribute('aria-label', activeUiStrings.previewTools);
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
moreToolsButton.dataset.action = 'settings';
moreToolsButton.title = activeUiStrings.more;
moreToolsButton.setAttribute('aria-label', activeUiStrings.moreTools);
moreToolsButton.setAttribute('aria-haspopup', 'menu');
moreToolsButton.setAttribute('aria-expanded', 'false');
moreToolsButton.appendChild(createElement(Settings, { width: 18, height: 18 }));

const moreToolsPanel = document.createElement('div');
moreToolsPanel.className = 'more-tools-panel';
moreToolsPanel.setAttribute('role', 'menu');
moreToolsPanel.setAttribute('aria-label', activeUiStrings.moreTools);
moreToolsPanel.hidden = true;
const toolbarOverflowSection = document.createElement('div');
toolbarOverflowSection.className = 'toolbar-overflow-panel';
toolbarOverflowSection.id = 'toolbar-overflow-panel';
toolbarOverflowSection.setAttribute('role', 'group');
toolbarOverflowSection.setAttribute('aria-label', activeUiStrings.toolbarOverflow);
toolbarOverflowSection.hidden = true;
const displaySettingsHeading = document.createElement('div');
displaySettingsHeading.className = 'more-tools-section-label';
displaySettingsHeading.textContent = activeUiStrings.editorSettings;
const editorAppearanceControl = createSegmentedControl<EditorAppearance>({
  ariaLabel: activeUiStrings.editorAppearance,
  className: 'editor-appearance-control',
  buttonClassName: 'editor-appearance-button',
  datasetKey: 'editorAppearance',
  role: 'group',
  options: [
    {
      value: 'auto',
      label: activeUiStrings.auto
    },
    {
      value: 'light',
      label: activeUiStrings.light,
      renderLeading: () => createElement(Sun, { width: 14, height: 14, 'aria-hidden': 'true' })
    },
    {
      value: 'dark',
      label: activeUiStrings.dark,
      renderLeading: () => createElement(Moon, { width: 14, height: 14, 'aria-hidden': 'true' })
    }
  ]
});
editorAppearanceControl.setActive('auto');

const uiLanguageControl = createSegmentedControl<UiLanguagePreference>({
  ariaLabel: activeUiStrings.interfaceLanguage,
  className: 'ui-language-control',
  buttonClassName: 'ui-language-button',
  datasetKey: 'uiLanguage',
  role: 'group',
  options: [
    { value: 'auto', label: activeUiStrings.auto },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en', label: 'English' }
  ]
});
uiLanguageControl.setActive('auto');

const editorFontSizeModeControl = createSegmentedControl<EditorFontSizeMode>({
  ariaLabel: activeUiStrings.editorFontSize,
  className: 'editor-font-size-mode-control',
  buttonClassName: 'editor-font-size-mode-button',
  datasetKey: 'editorFontSizeMode',
  role: 'group',
  options: [
    { value: 'auto', label: activeUiStrings.auto },
    { value: 'custom', label: activeUiStrings.custom }
  ]
});
editorFontSizeModeControl.setActive('auto');

const editorFontSizeStepper = document.createElement('div');
editorFontSizeStepper.className = 'editor-font-size-stepper';
const decreaseEditorFontSizeBtn = document.createElement('button');
decreaseEditorFontSizeBtn.type = 'button';
decreaseEditorFontSizeBtn.className = 'editor-font-size-stepper-button';
decreaseEditorFontSizeBtn.appendChild(createElement(Minus, { width: 13, height: 13, 'aria-hidden': 'true' }));
const editorFontSizeValue = document.createElement('output');
editorFontSizeValue.className = 'editor-font-size-value';
editorFontSizeValue.textContent = '14';
const increaseEditorFontSizeBtn = document.createElement('button');
increaseEditorFontSizeBtn.type = 'button';
increaseEditorFontSizeBtn.className = 'editor-font-size-stepper-button';
increaseEditorFontSizeBtn.appendChild(createElement(Plus, { width: 13, height: 13, 'aria-hidden': 'true' }));
editorFontSizeStepper.append(decreaseEditorFontSizeBtn, editorFontSizeValue, increaseEditorFontSizeBtn);

const applyUiLanguage = (language: UiLanguage): void => {
  const strings = getUiStrings(language);
  activeUiLanguage = language;
  activeUiStrings = strings;
  editor?.setUiLanguage?.(language);
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
  discardBtn.title = discardBtn.classList.contains('is-discard-armed')
    ? strings.reloadDiskVersionDoubleClick
    : strings.reloadDiskVersion;
  discardBtn.setAttribute('aria-label', strings.reloadDiskVersion);
  contentMaxWidthBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.constrainContentWidth;
  sourceLineNumbersBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.showLineNumbers;
  longCodeBlockFoldingBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.foldLongCodeBlocks;
  tableStickyHeaderBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.stickyTableHeader;
  restoreReadingPositionBtn.querySelector<HTMLElement>('.more-tools-option-label')!.textContent = strings.resumeFromLastPosition;
  changesReviewControl.setUiLanguage(language);
  updateGitChangesGutterUI();
  updateContentMaxWidthUI();
  updateRestoreReadingPositionUI();
  editorNotice.setUiLanguage(language);
  modeControl.element.setAttribute('aria-label', strings.markdownMode);
  modeControl.setLabels({ live: strings.live, source: strings.source, preview: strings.preview });
  presentSourcePreviewControls();
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
  displaySettingsHeading.textContent = strings.editorSettings;
  feedbackPrompt.textContent = strings.feedbackPrompt;
  reportIssueButton.title = strings.reportIssue;
  reportIssueButton.setAttribute('aria-label', strings.reportIssue);
  reportIssueLabel.textContent = strings.reportIssue;
  toolbarOverflowIndicator.title = strings.toolbarOverflow;
  toolbarOverflowIndicator.setAttribute('aria-label', strings.toolbarOverflow);
  toolbarOverflowSection.setAttribute('aria-label', strings.toolbarOverflow);
  editorAppearanceControl.element.setAttribute('aria-label', strings.editorAppearance);
  editorAppearanceControl.setLabels({
    auto: strings.auto,
    light: strings.light,
    dark: strings.dark
  });
  editorAppearanceLabel.textContent = strings.editorAppearance;
  editorFontSizeLabel.textContent = strings.editorFontSize;
  editorFontSizeModeControl.element.setAttribute('aria-label', strings.editorFontSize);
  editorFontSizeModeControl.setLabels({ auto: strings.auto, custom: strings.custom });
  decreaseEditorFontSizeBtn.title = strings.decreaseFontSize;
  decreaseEditorFontSizeBtn.setAttribute('aria-label', strings.decreaseFontSize);
  increaseEditorFontSizeBtn.title = strings.increaseFontSize;
  increaseEditorFontSizeBtn.setAttribute('aria-label', strings.increaseFontSize);
  uiLanguageLabel.textContent = strings.interfaceLanguage;
  uiLanguageControl.element.setAttribute('aria-label', strings.interfaceLanguage);
  uiLanguageControl.setLabels({ auto: strings.auto, 'zh-CN': '简体中文', en: 'English' });
  findPanelController.setUiLanguage(language);
  outlineController.setUiLanguage(language);
  previewController.setUiLanguage(language);
  toolbarOverflowLayoutKey = '';
  syncToolbarOverflow();
};
const editorAppearanceRow = document.createElement('div');
editorAppearanceRow.className = 'more-tools-appearance-row';
const editorAppearanceLabel = document.createElement('span');
editorAppearanceLabel.className = 'more-tools-control-label';
editorAppearanceLabel.textContent = activeUiStrings.editorAppearance;
editorAppearanceRow.append(editorAppearanceLabel, editorAppearanceControl.element);
const uiLanguageRow = document.createElement('div');
uiLanguageRow.className = 'more-tools-appearance-row';
const uiLanguageLabel = document.createElement('span');
uiLanguageLabel.className = 'more-tools-control-label';
uiLanguageLabel.textContent = activeUiStrings.interfaceLanguage;
uiLanguageRow.append(uiLanguageLabel, uiLanguageControl.element);
const editorFontSizeRow = document.createElement('div');
editorFontSizeRow.className = 'more-tools-appearance-row editor-font-size-row';
const editorFontSizeLabel = document.createElement('span');
editorFontSizeLabel.className = 'more-tools-control-label';
editorFontSizeLabel.textContent = activeUiStrings.editorFontSize;
const editorFontSizeControls = document.createElement('div');
editorFontSizeControls.className = 'editor-font-size-controls';
editorFontSizeControls.append(editorFontSizeModeControl.element, editorFontSizeStepper);
editorFontSizeRow.append(editorFontSizeLabel, editorFontSizeControls);
const feedbackSeparator = document.createElement('div');
feedbackSeparator.className = 'more-tools-separator';
feedbackSeparator.setAttribute('role', 'separator');
const feedbackRow = document.createElement('div');
feedbackRow.className = 'more-tools-feedback';
const feedbackPrompt = document.createElement('span');
feedbackPrompt.className = 'more-tools-feedback-prompt';
feedbackPrompt.textContent = activeUiStrings.feedbackPrompt;
const reportIssueButton = document.createElement('button');
reportIssueButton.type = 'button';
reportIssueButton.className = 'more-tools-feedback-link';
reportIssueButton.title = activeUiStrings.reportIssue;
reportIssueButton.setAttribute('aria-label', activeUiStrings.reportIssue);
const reportIssueLabel = document.createElement('span');
reportIssueLabel.textContent = activeUiStrings.reportIssue;
reportIssueButton.append(reportIssueLabel, createElement(ExternalLink, { width: 13, height: 13 }));
feedbackRow.append(feedbackPrompt, reportIssueButton);
moreToolsPanel.append(
  displaySettingsHeading,
  sourceLineNumbersBtn,
  longCodeBlockFoldingBtn,
  contentMaxWidthBtn,
  tableStickyHeaderBtn,
  restoreReadingPositionBtn,
  editorAppearanceRow,
  uiLanguageRow,
  editorFontSizeRow,
  feedbackSeparator,
  feedbackRow
);

const moreToolsWrapper = document.createElement('div');
moreToolsWrapper.className = 'more-tools-wrapper';
moreToolsWrapper.append(moreToolsButton, moreToolsPanel);

const rightToolsSeparator = document.createElement('div');
rightToolsSeparator.className = 'format-separator preview-hidden-toolbar-control';
rightToolsSeparator.setAttribute('role', 'separator');

const setMoreToolsVisible = (visible: boolean) => {
  moreToolsPanel.hidden = !visible;
  moreToolsPanel.style.transform = '';
  if (visible) {
    const bounds = moreToolsPanel.getBoundingClientRect();
    const viewportPadding = 8;
    const shift = bounds.left < viewportPadding
      ? viewportPadding - bounds.left
      : bounds.right > window.innerWidth - viewportPadding
        ? window.innerWidth - viewportPadding - bounds.right
        : 0;
    if (shift !== 0) moreToolsPanel.style.transform = `translateX(${shift}px)`;
  }
  moreToolsButton.classList.toggle('is-active', visible);
  moreToolsButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
};

moreToolsButton.addEventListener('click', () => {
  setMoreToolsVisible(moreToolsPanel.hidden);
});

reportIssueButton.addEventListener('click', () => {
  vscode.postMessage({
    type: 'openLink',
    href: 'https://github.com/huangko555/meo-enhanced/issues/new'
  });
  setMoreToolsVisible(false);
});

document.addEventListener('pointerdown', (event) => {
  if (!moreToolsWrapper.contains(event.target as Node)) {
    setMoreToolsVisible(false);
  }
}, true);

rightGroup.append(
  changesControls,
  rightToolsSeparator,
  findToggleBtn,
  outlineBtn,
  moreToolsWrapper
);

moreToolsPanel.addEventListener('click', (event) => {
  const option = (event.target as Element).closest<HTMLElement>('.changes-baseline-option');
  const mode = option?.dataset.baselineMode;
  if (mode === 'current-edit' || mode === 'recent-save' || mode === 'git-head') {
    setDiffBaselineMode(mode);
  }
});

const modeControl = createSegmentedControl<EditorMode>({
  ariaLabel: activeUiStrings.markdownMode,
  className: 'mode-group',
  buttonClassName: 'mode-button',
  datasetKey: 'mode',
  role: 'tablist',
  options: [
    { value: 'live', label: activeUiStrings.live },
    { value: 'source', label: activeUiStrings.source },
    { value: 'preview', label: activeUiStrings.preview }
  ]
});
const modeGroup = modeControl.element;
const liveButton = modeControl.getButton('live');
const sourceButton = modeControl.getButton('source');
const previewButton = modeControl.getButton('preview');

const sourcePreviewButton = document.createElement('button');
sourcePreviewButton.type = 'button';
sourcePreviewButton.className = 'format-button source-preview-button';
sourcePreviewButton.title = activeUiStrings.showSidePreview;
sourcePreviewButton.setAttribute('aria-label', activeUiStrings.showSidePreview);
sourcePreviewButton.setAttribute('aria-pressed', 'false');
const sourcePreviewButtonLabel = document.createElement('span');
sourcePreviewButtonLabel.className = 'source-preview-button-label';
sourcePreviewButtonLabel.textContent = activeUiStrings.sidePreview;
sourcePreviewButton.append(
  createElement(SquareSplitHorizontal, {
    width: 16,
    height: 16,
    'aria-hidden': 'true',
    'data-icon': 'square-split-horizontal'
  }),
  sourcePreviewButtonLabel
);
rightGroup.insertBefore(sourcePreviewButton, changesControls);

const sourcePreviewScrollSyncButton = document.createElement('button');
sourcePreviewScrollSyncButton.type = 'button';
sourcePreviewScrollSyncButton.className = 'format-button source-preview-scroll-sync-button';
sourcePreviewScrollSyncButton.setAttribute('aria-pressed', 'true');

const toolbarOverflowIndicator = document.createElement('button');
toolbarOverflowIndicator.type = 'button';
toolbarOverflowIndicator.className = 'format-button toolbar-overflow-indicator';
toolbarOverflowIndicator.title = activeUiStrings.toolbarOverflow;
toolbarOverflowIndicator.setAttribute('aria-label', activeUiStrings.toolbarOverflow);
toolbarOverflowIndicator.setAttribute('aria-expanded', 'false');
toolbarOverflowIndicator.setAttribute('aria-controls', toolbarOverflowSection.id);
toolbarOverflowIndicator.hidden = true;
toolbarOverflowIndicator.appendChild(createElement(Ellipsis, { width: 18, height: 18 }));

const setToolbarOverflowVisible = (visible: boolean): void => {
  toolbarOverflowSection.hidden = !visible;
  toolbarOverflowIndicator.setAttribute('aria-expanded', String(visible));
  toolbarOverflowIndicator.classList.toggle('is-active', visible);
  if (visible) {
    const toolbarLeft = toolbar.getBoundingClientRect().left;
    const buttonLeft = toolbarOverflowIndicator.getBoundingClientRect().left;
    const panelWidth = toolbarOverflowSection.getBoundingClientRect().width;
    toolbarOverflowSection.style.left = `${Math.max(8, Math.min(buttonLeft, window.innerWidth - panelWidth - 8)) - toolbarLeft}px`;
  }
};
toolbarOverflowIndicator.addEventListener('click', () => {
  setToolbarOverflowVisible(toolbarOverflowSection.hidden);
});
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  if (!toolbarOverflowIndicator.contains(target) && !toolbarOverflowSection.contains(target)) {
    setToolbarOverflowVisible(false);
  }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !toolbarOverflowSection.hidden) {
    setToolbarOverflowVisible(false);
    toolbarOverflowIndicator.focus();
  }
});

const toolbarRight = document.createElement('div');
toolbarRight.className = 'toolbar-right';
toolbarRight.append(rightGroup, modeGroup);

const findPanelElements = createFindPanel(findToggleBtn, activeUiLanguage);
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
  },
  activeUiLanguage
);

const selectionMenuElements = createSelectionMenu();
const selectionMenuController = createSelectionMenuController(selectionMenuElements, () => editor);

const editorNoticeBanner = document.createElement('div');
editorNoticeBanner.className = 'editor-notice';
editorNoticeBanner.setAttribute('role', 'status');
editorNoticeBanner.setAttribute('aria-live', 'polite');
editorNoticeBanner.hidden = true;
let handleEditorNoticeDismiss = (): void => {};
const editorNotice = createEditorNoticeController(
  editorNoticeBanner,
  activeUiLanguage,
  () => handleEditorNoticeDismiss()
);

toolbar.replaceChildren(formatGroup, previewFormatGroup, toolbarOverflowIndicator, toolbarOverflowSection, toolbarRight, findPanelElements.panel, editorNoticeBanner);

const toolbarOverflowHomes = new Map<HTMLElement, Comment>();
let toolbarOverflowLayoutKey = '';

const restoreToolbarOverflowItems = (): void => {
  for (const [item, home] of toolbarOverflowHomes) {
    home.replaceWith(item);
    item.classList.remove('is-toolbar-overflow-item');
  }
  toolbarOverflowHomes.clear();
  setToolbarOverflowVisible(false);
};

const moveToolbarItemToOverflow = (item: HTMLElement): void => {
  const home = document.createComment('toolbar overflow home');
  item.before(home);
  toolbarOverflowHomes.set(item, home);
  item.classList.add('is-toolbar-overflow-item');
  toolbarOverflowSection.append(item);
};

const syncToolbarOverflow = () => {
  const nextLayoutKey = `${toolbar.clientWidth}:${rightGroup.offsetWidth}:${root.dataset.mode ?? ''}:${activeUiLanguage}`;
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

  // The moved controls remain the authoritative nodes and retain their state/listeners.

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

  leftItems.slice(visibleCount).forEach(moveToolbarItemToOverflow);

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
editorWrapper.classList.add('editor-wrapper', 'meo-preload-editor-shell');
editorWrapper.setAttribute('aria-hidden', 'true');

const existingEditorHost = editorWrapper.querySelector('.editor-host');
const editorHost = existingEditorHost instanceof HTMLElement ? existingEditorHost : document.createElement('div');
editorHost.className = 'editor-host';
const editorScrollToTopController = createDocumentScrollToTopController(activeUiLanguage, () => {
  if (!isSidePreviewVisible() || !editor?.navigateLinkedViewportToTop?.('editor')) return false;
  readingPositionLifecycle?.userInteracted();
  return true;
});
editorHost.appendChild(editorScrollToTopController.button);

let editor: any = null;
let readingPositionLifecycle: ReadingPositionLifecycle | null = null;
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
let applyCodeThemeForPreview = (appearance: 'light' | 'dark') => {
  setShikiTheme(codePaletteAdapter.resolve(undefined, appearance).sourceTheme, 'preview');
};
let previewPaintReady = false;
let previewViewportInteractionGeneration = 0;
const previewController = createPreviewController({
  vscode,
  uiLanguage: activeUiLanguage,
  getEditorAppearance: () => resolveEditorAppearanceForPreview(),
  isCurrentText: (text) => getCurrentEditorText() === text,
  getCodePalette: (appearance) => resolveCodePaletteForPreview(appearance),
  applyCodeTheme: (appearance) => applyCodeThemeForPreview(appearance),
  mermaidRenderResources: mermaidDiagramRenderPool,
  onFindRequested: () => findPanelController.open('find'),
  onNavigateToTop: () => {
    if (!isSidePreviewVisible() || !editor?.navigateLinkedViewportToTop?.('preview')) return false;
    readingPositionLifecycle?.userInteracted();
    return true;
  },
  onPaintReady: () => {
    previewPaintReady = true;
    editorHost.removeAttribute('data-preview-cover');
    markSourcePreviewSurfaceReady();
  },
  onRendered: (options) => {
    if (outlineController?.isVisible()) {
      outlineController.refresh();
    }
    if (options?.skipLinkedViewportProjection !== true) {
      editor?.linkedPreviewReady?.();
    }
    readingPositionLifecycle?.surfaceReady();
  },
  onViewportInteraction: () => {
    previewViewportInteractionGeneration += 1;
    editor?.markPreviewViewportInteraction?.();
    readingPositionLifecycle?.userInteracted();
  },
  onViewportChange: () => {
    if (isSidePreviewVisible()) editor?.previewViewportChanged?.();
    readingPositionLifecycle?.viewportChanged();
  },
  onGeometryChanged: () => {
    if (isSidePreviewVisible()) editor?.linkedPreviewReady?.();
  },
  runViewportTransaction: (mutate, documentChange) => {
    if (!editor?.runPreviewPresentationTransaction) {
      mutate();
      return;
    }
    const reloadViewport = pendingReloadPreviewViewport;
    editor.runPreviewPresentationTransaction(mutate, documentChange);
    if (
      !reloadViewport ||
      reloadViewport.text === null ||
      documentChange?.nextText !== reloadViewport.text ||
      reloadViewport.interactionGeneration !== previewViewportInteractionGeneration ||
      !reloadViewport.isCurrent?.()
    ) return;
    pendingReloadPreviewViewport = null;
    previewController.restoreTopVisiblePosition({
      line: reloadViewport.position.topLine,
      lineOffset: reloadViewport.position.topLineOffset,
      viewportOffset: reloadViewport.position.viewportOffset,
      sourceRange: reloadViewport.position.sourceRange
    }, () => true);
  }
});
const previewAdapter = createPreviewWebviewAdapter(previewController);
previewAppearanceSlot.replaceWith(previewController.appearanceControl);
previewFontFamilySlot.replaceWith(previewController.fontFamilyControl);
previewSourceColoringSlot.replaceWith(previewController.sourceColoringControl);
previewController.host.append(sourcePreviewScrollSyncButton);
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

const editorSurface = document.createElement('div');
editorSurface.className = 'editor-surface';
editorSurface.append(editorHost, previewController.host);
editorWrapper.replaceChildren(editorSurface, outlineController.sidebar, selectionMenuElements.menu);
root.replaceChildren(toolbar, editorWrapper);

const editorModeApplication = createEditorModeApplication();
let editorModeRuntime: EditorModeRuntime;
let sourcePreviewEnabled = false;
// This preference belongs to one open document session. Keep it out of
// WebviewUiState so reopening the document starts from synchronized scrolling.
let sourcePreviewScrollSyncEnabled = true;
let splitModeTransitionViewport: EditorModeViewportToken | null = null;
let pendingEditorViewportAfterPreviewExit: EditorModeViewportToken | null = null;
let deferEditorViewportUntilPreviewExit = false;
let sourcePreviewRevealGeneration = 0;
let pendingSourcePreviewReveal: {
  readonly generation: number;
  editorReady: boolean;
  previewReady: boolean;
} | null = null;
const restorePendingEditorViewportAfterPreviewExit = (): void => {
  const viewport = pendingEditorViewportAfterPreviewExit;
  if (!viewport) return;
  pendingEditorViewportAfterPreviewExit = null;
  deferEditorViewportUntilPreviewExit = false;
  editor?.restoreViewportAnchorToken?.(viewport, 'editor');
  editor?.restoreModeRoundTripCaptureSurface?.(viewport);
};
const getActiveEditorMode = (): EditorMode => editorModeApplication.getState().mode;
const isSidePreviewVisible = (): boolean => (
  sourcePreviewEnabled && getActiveEditorMode() === 'source'
);
const isPreviewSurfaceVisible = (): boolean => (
  getActiveEditorMode() === 'preview' || isSidePreviewVisible()
);
function presentSourcePreviewControls(): void {
  const split = isSidePreviewVisible();
  const sourcePreviewLabel = split
    ? activeUiStrings.hideSidePreview
    : activeUiStrings.showSidePreview;
  sourcePreviewButton.title = sourcePreviewLabel;
  sourcePreviewButton.setAttribute('aria-label', sourcePreviewLabel);
  sourcePreviewButtonLabel.textContent = split
    ? activeUiStrings.exitSidePreview
    : activeUiStrings.sidePreview;

  const syncLabel = sourcePreviewScrollSyncEnabled
    ? activeUiStrings.disableSynchronizedScrolling
    : activeUiStrings.enableSynchronizedScrolling;
  sourcePreviewScrollSyncButton.title = syncLabel;
  sourcePreviewScrollSyncButton.setAttribute('aria-label', syncLabel);
  sourcePreviewScrollSyncButton.setAttribute('aria-pressed', sourcePreviewScrollSyncEnabled ? 'true' : 'false');
  sourcePreviewScrollSyncButton.classList.toggle('is-independent', !sourcePreviewScrollSyncEnabled);
  sourcePreviewScrollSyncButton.replaceChildren(createElement(
    sourcePreviewScrollSyncEnabled ? Link : Unlink,
    {
      width: 14,
      height: 14,
      'aria-hidden': 'true',
      'data-icon': sourcePreviewScrollSyncEnabled ? 'link' : 'unlink'
    }
  ));
}
const activateSourcePreviewLinkage = (
  activationOwner: 'editor' | 'last-interaction' = 'editor'
): void => {
  if (!editor) return;
  // Independent panes still open at one shared semantic position. Continuous
  // projection is disabled immediately after that initial alignment.
  editor.setLinkedPreviewEnabled?.(true, activationOwner);
  if (!sourcePreviewScrollSyncEnabled) editor.setLinkedPreviewEnabled?.(false);
};
const cancelSourcePreviewReveal = (): void => {
  sourcePreviewRevealGeneration += 1;
  pendingSourcePreviewReveal = null;
  previewController.host.style.removeProperty('visibility');
};
const finishSourcePreviewReveal = (): void => {
  const reveal = pendingSourcePreviewReveal;
  if (!reveal || !reveal.editorReady || !reveal.previewReady) return;
  if (reveal.generation !== sourcePreviewRevealGeneration || !isSidePreviewVisible()) return;
  pendingSourcePreviewReveal = null;
  window.requestAnimationFrame(() => {
    if (reveal.generation !== sourcePreviewRevealGeneration || !isSidePreviewVisible()) return;
    previewController.refreshLayout();
    if (editor) (editor.view as typeof editor.view & { measure(flush?: boolean): void }).measure(false);
    restorePendingEditorViewportAfterPreviewExit();
    activateSourcePreviewLinkage();
    previewController.host.inert = false;
    previewController.host.style.removeProperty('visibility');
  });
};
function markSourcePreviewSurfaceReady(): void {
  if (!pendingSourcePreviewReveal) return;
  pendingSourcePreviewReveal.previewReady = true;
  finishSourcePreviewReveal();
}
const markSourcePreviewEditorReady = (): void => {
  if (!pendingSourcePreviewReveal) return;
  pendingSourcePreviewReveal.editorReady = true;
  finishSourcePreviewReveal();
};
const presentPreviewSurface = (
  fullPreview: boolean,
  { atomicSplit = false }: { readonly atomicSplit?: boolean } = {}
): { readonly split: boolean; readonly visible: boolean } => {
  const split = !fullPreview && isSidePreviewVisible();
  const visible = fullPreview || split;
  if (visible !== !previewController.host.hidden) previewPaintReady = false;
  editorSurface.toggleAttribute('data-source-preview', split);
  sourcePreviewButton.classList.toggle('is-active', split);
  sourcePreviewButton.setAttribute('aria-pressed', split ? 'true' : 'false');
  presentSourcePreviewControls();
  if (atomicSplit && split) {
    const generation = ++sourcePreviewRevealGeneration;
    pendingSourcePreviewReveal = { generation, editorReady: false, previewReady: false };
    previewController.host.style.visibility = 'hidden';
    editor?.setLinkedPreviewEnabled?.(false);
    previewAdapter.setActive({ active: true, text: getCurrentEditorText() });
    previewController.host.inert = true;
    return { split, visible };
  }
  cancelSourcePreviewReveal();
  previewAdapter.setActive({ active: visible, text: getCurrentEditorText() });
  if (split) {
    activateSourcePreviewLinkage(
      deferEditorViewportUntilPreviewExit ? 'last-interaction' : 'editor'
    );
  }
  else editor?.setLinkedPreviewEnabled?.(false);
  return { split, visible };
};
const getActiveEditableMode = (): 'live' | 'source' => {
  const state = editorModeApplication.getState();
  return state.mode === 'preview' ? state.lastEditableMode : state.mode;
};
let pendingInitialText: string | null = null;
let pendingSourceLineNumbers: InitMessage['sourceLineNumbers'] = 'on';
let previousVisibleSourceLineNumbers: Exclude<InitMessage['sourceLineNumbers'], 'off'> = 'on';
let longCodeBlockFoldingEnabled = true;
let gitClient: any = null;
let pendingEditorFocus = false;
let pendingDiagnostics: any[] = [];
let pendingRevealSelection: { anchor: number; head: number; focus?: boolean } | null = null;
let pendingRevealDocumentFragment: string | null = null;
let pendingEditorSurfaceRecoveryRaf: number | null = null;
let createEditorFactoryPromise: Promise<CreateEditorFactory> | null = null;
let editorFontSizePreference: EditorFontSizePreference = { mode: 'auto', value: 14 };
const INITIAL_EDITOR_MOUNT_FALLBACK_MS = 120;
const LIVE_IMAGE_REVEAL_WAIT_MS = 120;

const failureNotice = createFailureNoticeManager(editorNotice);
handleEditorNoticeDismiss = failureNotice.clearFailureNotice;

const syncEditorFontSizeControls = (): void => {
  const custom = editorFontSizePreference.mode === 'custom';
  editorFontSizeModeControl.setActive(editorFontSizePreference.mode);
  editorFontSizeValue.textContent = `${editorFontSizePreference.value}`;
  editorFontSizeStepper.classList.toggle('is-disabled', !custom);
  decreaseEditorFontSizeBtn.disabled = !custom || editorFontSizePreference.value <= EDITOR_FONT_SIZE_MIN;
  increaseEditorFontSizeBtn.disabled = !custom || editorFontSizePreference.value >= EDITOR_FONT_SIZE_MAX;
};

const applyEditorFontSizePreference = (
  preference: EditorFontSizePreference,
  { post = false, refreshPreview = true }: { readonly post?: boolean; readonly refreshPreview?: boolean } = {}
): void => {
  editorFontSizePreference = {
    mode: preference.mode === 'custom' ? 'custom' : 'auto',
    value: normalizeEditorFontSize(preference.value)
  };
  const mutate = () => {
    if (editorFontSizePreference.mode === 'custom') {
      document.documentElement.style.setProperty('--meo-user-editor-font-size', `${editorFontSizePreference.value}px`);
    } else {
      document.documentElement.style.removeProperty('--meo-user-editor-font-size');
    }
  };
  if (editor?.preserveViewport) editor.preserveViewport(mutate);
  else mutate();
  syncEditorFontSizeControls();
  if (refreshPreview) {
    previewAdapter.refreshVisible(getCurrentEditorText(), {
      preserveViewport: true,
      preserveFrame: true
    });
  }
  if (post) {
    vscode.postMessage({
      type: 'setEditorFontSize',
      mode: editorFontSizePreference.mode,
      value: editorFontSizePreference.value
    });
  }
};

editorAppearanceControl.element.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.editor-appearance-button[data-editor-appearance]')
    : null;
  const appearance = button?.dataset.editorAppearance;
  if (appearance === 'auto' || appearance === 'light' || appearance === 'dark') {
    themeAdapter.setAppearance(appearance, { post: true });
  }
});

editorFontSizeModeControl.element.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.editor-font-size-mode-button[data-editor-font-size-mode]')
    : null;
  const mode = button?.dataset.editorFontSizeMode;
  if (mode === 'auto' || mode === 'custom') {
    applyEditorFontSizePreference({ ...editorFontSizePreference, mode }, { post: true });
  }
});

const adjustEditorFontSize = (delta: number): void => {
  if (editorFontSizePreference.mode !== 'custom') return;
  applyEditorFontSizePreference({
    mode: 'custom',
    value: normalizeEditorFontSize(editorFontSizePreference.value + delta)
  }, { post: true });
};

decreaseEditorFontSizeBtn.addEventListener('click', () => adjustEditorFontSize(-1));
increaseEditorFontSizeBtn.addEventListener('click', () => adjustEditorFontSize(1));

uiLanguageControl.element.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('.ui-language-button[data-ui-language]')
    : null;
  const preference = button?.dataset.uiLanguage;
  if (preference !== 'auto' && preference !== 'zh-CN' && preference !== 'en') return;
  activeUiLanguagePreference = preference;
  uiLanguageControl.setActive(preference);
  applyUiLanguage(preference === 'auto' ? automaticUiLanguage : preference);
  vscode.postMessage({ type: 'setUiLanguagePreference', language: preference });
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

readingPositionLifecycle = createReadingPositionLifecycle({
  timer: {
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle as number)
  },
  capture: () => {
    const position = getActiveEditorMode() === 'preview'
      ? previewController.getTopVisiblePosition()
      : getTopVisiblePosition();
    return position ? { line: position.topLine, lineOffset: position.topLineOffset } : null;
  },
  restore: (position) => {
    if (getActiveEditorMode() === 'preview') {
      if (!previewController.getTopVisiblePosition()) return false;
      previewController.restoreTopLine(position.line, position.lineOffset);
      return true;
    }
    if (!editor) return false;
    editor.restoreTopLine(position.line, position.lineOffset, { syncCursor: false });
    return true;
  },
  post: (position) => vscode.postMessage({ type: 'readingPositionChanged', position })
});

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

  readingPositionLifecycle?.explicitNavigation();

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
  readingPositionLifecycle?.explicitNavigation();
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

const discardConfirmationWindowMs = 3000;
let discardConfirmationTimer: number | null = null;
let pendingReloadViewport: { handle: ViewportAnchorToken; owner: 'editor' | 'preview' } | null = null;
let pendingReloadPreviewViewport: {
  readonly position: NonNullable<ReturnType<typeof previewController.getTopVisiblePosition>>;
  readonly interactionGeneration: number;
  readonly text: string | null;
  readonly isCurrent?: () => boolean;
} | null = null;

const clearDiscardConfirmation = () => {
  if (discardConfirmationTimer !== null) {
    window.clearTimeout(discardConfirmationTimer);
    discardConfirmationTimer = null;
  }
  discardBtn.classList.remove('is-discard-armed');
  discardBtn.title = activeUiStrings.reloadDiskVersion;
  discardBtn.setAttribute('aria-label', activeUiStrings.reloadDiskVersion);
  discardBtn.replaceChildren(createElement(HardDriveUpload, { width: 18, height: 18 }));
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
  const splitPreviewPosition = !previewActive && isSidePreviewVisible()
    ? previewController.getTopVisiblePosition()
    : null;
  pendingReloadPreviewViewport = splitPreviewPosition
    ? {
        position: splitPreviewPosition,
        interactionGeneration: previewViewportInteractionGeneration,
        text: null
      }
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
  discardBtn.title = activeUiStrings.reloadDiskVersionDoubleClick;
  discardBtn.setAttribute('aria-label', activeUiStrings.reloadDiskVersionDoubleClick);
  discardBtn.replaceChildren(createElement(Check, { width: 18, height: 18, 'stroke-width': 2.5 }));
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
  const previewVisible = isPreviewSurfaceVisible();
  const owner = previewActive ? 'preview' : 'editor';
  const viewport = source === 'disk-reload' && pendingReloadViewport?.owner === owner
    ? pendingReloadViewport.handle
    : editor.captureViewportAnchorToken?.(owner) ?? null;
  let presented = false;
  const present = async (isViewportCurrent: () => boolean): Promise<void> => {
    presented = await setEditorTextSafely(text, `documentSession.${source}`, source === 'disk-reload');
    if (!presented) throw viewportPresentationFailed;
    if (previewVisible) {
      if (source === 'disk-reload' && pendingReloadPreviewViewport) {
        const reloadHandle = pendingReloadViewport?.handle ?? null;
        pendingReloadPreviewViewport = {
          ...pendingReloadPreviewViewport,
          text,
          isCurrent: () => reloadHandle === null ||
            editor?.isViewportAnchorTokenCurrent?.(reloadHandle) === true
        };
      }
      previewAdapter.refreshVisible(text, {
        // An Editor-owned transaction only restores the CodeMirror surface.
        // A simultaneously visible split Preview must preserve its own anchor.
        preserveViewport: owner === 'editor' || !isViewportCurrent()
      });
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
  showFailureNotice: (message) => {
    pendingReloadPreviewViewport = null;
    failureNotice.setFailureNotice(message, 'warning');
  },
  reportUnexpectedError: (context, error) => {
    console.error(`[MEO webview] Document Session ${context}`, error);
  }
});

const documentSaveFlushAdapter = createDocumentSaveFlushWebviewAdapter({
  postMessage: (message) => vscode.postMessage(message),
  commitTransientEdits: commitEditorTransientEdits,
  getCurrentText: () => editor?.getTextForSave() ?? getCurrentEditorText(),
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
  if (isSidePreviewVisible()) previewAdapter.scheduleVisibleRefresh(nextText);
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
    initialLongCodeBlockFolding: longCodeBlockFoldingEnabled,
    initialTableStickyHeaderEnabled: tableStickyHeaderEnabled,
    initialDiagnostics: pendingDiagnostics,
    onApplyChanges: handleLocalEditorChange,
    onOpenLink: (href: string) => vscode.postMessage({ type: 'openLink', href }),
    onSelectionChange: (state: any) => selectionMenuController.update(state),
    mermaidDiagramPresentationFactory,
    uiLanguage: activeUiLanguage,
    sourceLineNumbers: pendingSourceLineNumbers,
    onGitDiffSummaryChange: (summary) => {
      gitDiffSummary = summary;
      presentChangesReview();
    },
    onViewportChange: () => readingPositionLifecycle?.viewportChanged(),
    previewViewportSurface: {
      captureTopVisiblePosition(viewportOffset) {
        const position = previewController.getTopVisiblePosition(viewportOffset);
        return position ? {
          line: position.topLine,
          lineOffset: position.topLineOffset,
          editorLineOffset: position.editorLineOffset,
          viewportOffset: position.viewportOffset,
          sourceRange: position.sourceRange
        } : null;
      },
      captureReadingPosition(viewportRatio) {
        const position = previewController.getReadingPosition(viewportRatio);
        return position ? {
          line: position.topLine,
          lineOffset: position.topLineOffset,
          editorLineOffset: position.editorLineOffset,
          viewportOffset: position.viewportOffset,
          sourceRange: position.sourceRange
        } : null;
      },
      restoreTopVisiblePosition(position, isCurrent) {
        previewController.restoreTopVisiblePosition(position, isCurrent);
      },
      captureLinkedGeometry() {
        return previewController.captureLinkedGeometry();
      },
      readScrollTop() {
        return previewController.readScrollTop();
      },
      writeScrollTop(scrollTop) {
        previewController.writeScrollTop(scrollTop);
      }
    }
  });
  editorScrollToTopController.setScrollElement(editor.view.scrollDOM);
  if (gitChangesGutterVisible) gitClient?.applyBaselineToEditor(editor);
  syncGitDiffDetails();
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
  async applyEditorMode(mode, viewport) {
    if (!editor) throw new Error('Editor is not mounted');
    // Preview exits reveal the editor at its final width only after the mode
    // change succeeds. Restoring before that reveal projects against the
    // temporary full-width geometry and is then displaced by split reflow.
    const deferViewportRestore = deferEditorViewportUntilPreviewExit
      && pendingEditorViewportAfterPreviewExit === viewport;
    editor.setMode(mode, viewport, { deferViewportRestore });
    if (mode === 'source' && pendingSourcePreviewReveal) {
      (editor.view as typeof editor.view & { measure(flush?: boolean): void }).measure(false);
      markSourcePreviewEditorReady();
    }
    if (
      !previewController.host.hidden &&
      (mode === 'live' || (mode === 'source' && editorHost.inert))
    ) {
      await editor.whenVisiblePresentationReady(LIVE_IMAGE_REVEAL_WAIT_MS);
    }
    changesReviewMode = mode;
    syncGitDiffDetails();
    syncGitDiffLineHighlights();
    if (outlineController.isVisible()) outlineController.refresh();
    if (mode === 'live') failureNotice.clearFailureNotice();
    failureNotice.updateEditorNotice();
  },
  setPreviewActive(active, presentation) {
    const atomicSplit = !active
      && presentation?.mode === 'source'
      && presentation.previousMode !== 'source'
      && sourcePreviewEnabled;
    presentPreviewSurface(active, { atomicSplit });
    if (active && pendingEditorViewportAfterPreviewExit) {
      pendingEditorViewportAfterPreviewExit = null;
      deferEditorViewportUntilPreviewExit = false;
    }
    if (!active && pendingEditorViewportAfterPreviewExit && !atomicSplit) {
      restorePendingEditorViewportAfterPreviewExit();
    }
    if (active) {
      // A Source split and the standalone Preview have different final widths.
      // Reflow width-dependent content and invalidate its source map before the
      // mode transaction projects the captured reading anchor.
      previewController.refreshLayout();
    }
    if (active && document.activeElement instanceof HTMLElement && editorHost.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    syncGitDiffLineHighlights();
    if (active) syncGitDiffDetails();
  },
  setEditorVisible(visible, interactive = visible) {
    editorHost.toggleAttribute('data-preview-cover', !visible && !previewPaintReady);
    editorHost.inert = !interactive;
    editorHost.hidden = !visible;
  },
  presentModeControl(mode) {
    root.dataset.mode = mode;
    modeControl.setActive(mode);
    changesReviewMode = mode;
    presentChangesReview();
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
  captureViewport(targetMode) {
    const currentMode = getActiveEditorMode();
    if (
      currentMode === 'preview'
      && targetMode !== 'preview'
      && splitModeTransitionViewport
    ) {
      const viewport = splitModeTransitionViewport;
      if (editor?.prepareModeRoundTripReturn?.(viewport)) {
        splitModeTransitionViewport = null;
        pendingEditorViewportAfterPreviewExit = viewport;
        deferEditorViewportUntilPreviewExit = true;
        return viewport;
      }
    }

    const owner = editorHost.hidden
      ? 'preview'
      : isSidePreviewVisible()
        ? editor?.getLastViewportInteractionOwner?.() ?? 'editor'
        : 'editor';
    const viewport = editor?.captureModeTransitionAnchorToken?.(owner) ?? null;
    if (currentMode === 'source' && isSidePreviewVisible() && targetMode === 'preview') {
      splitModeTransitionViewport = viewport;
    } else if (currentMode === 'preview' && targetMode !== 'preview') {
      splitModeTransitionViewport = null;
      pendingEditorViewportAfterPreviewExit = viewport;
      // Source split reaches its final width only after standalone Preview is
      // removed. Restore every Preview -> Source transition against that final
      // geometry, not just a direct split-mode round trip.
      deferEditorViewportUntilPreviewExit = targetMode === 'source' && sourcePreviewEnabled;
    } else {
      splitModeTransitionViewport = null;
    }
    return viewport;
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
  activeUiLanguagePreference = message.uiLanguagePreference;
  automaticUiLanguage = message.automaticUiLanguage;
  uiLanguageControl.setActive(activeUiLanguagePreference);
  applyUiLanguage(message.uiLanguage);
  applyEditorFontSizePreference({
    mode: message.editorFontSizeMode,
    value: message.editorFontSize
  }, { refreshPreview: false });
  pendingSourceLineNumbers = message.sourceLineNumbers;
  if (message.sourceLineNumbers !== 'off') {
    previousVisibleSourceLineNumbers = message.sourceLineNumbers;
  }
  sourceLineNumbersBtn.classList.toggle('is-active', message.sourceLineNumbers !== 'off');
  sourceLineNumbersBtn.setAttribute('aria-checked', message.sourceLineNumbers !== 'off' ? 'true' : 'false');
  longCodeBlockFoldingBtn.setAttribute('aria-checked', longCodeBlockFoldingEnabled ? 'true' : 'false');
  setTableStickyHeaderEnabled(message.tableStickyHeaderEnabled, { post: false });
  setRestoreReadingPositionOnOpen(message.restoreReadingPositionOnOpen, { post: false });
  readingPositionLifecycle?.start({
    enabled: message.restoreReadingPositionOnOpen,
    restore: message.readingPositionRestore
  });
  toolbar.classList.remove('meo-preload-toolbar');
  toolbar.removeAttribute('aria-hidden');
  editorWrapper.classList.remove('meo-preload-editor-shell');
  editorWrapper.removeAttribute('aria-hidden');
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
    setFixedBaselineState(
      message.fixedBaselinePinned,
      message.fixedBaselineActive,
      message.fixedBaselineUpdatedAt
    );
  }
  if (typeof message.gitDiffLineHighlights === 'boolean') {
    gitDiffLineHighlightsEnabled = message.gitDiffLineHighlights;
    syncGitDiffLineHighlights();
  }
  if (typeof message.gitDiffDetailsVisible === 'boolean') {
    setGitDiffDetailsVisibleState(message.gitDiffDetailsVisible, { post: false });
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
  getUiLanguage: () => activeUiLanguage,
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
applyCodeThemeForPreview = (appearance) => {
  setShikiTheme(themeAdapter.getCodePalette(appearance).sourceTheme, 'preview');
};

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
        .then(() => {
          readingPositionLifecycle?.surfaceReady();
          failureNotice.updateEditorNotice();
        });
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
    setFixedBaselineState(message.pinned === true, message.active === true, message.updatedAt);
    return;
  }

  if (message.type === 'contentMaxWidthChanged') {
    setContentMaxWidthEnabled(message.enabled, { post: false });
    return;
  }

  if (message.type === 'tableStickyHeaderChanged') {
    setTableStickyHeaderEnabled(message.enabled, { post: false });
    return;
  }

  if (message.type === 'restoreReadingPositionOnOpenChanged') {
    setRestoreReadingPositionOnOpen(message.enabled, { post: false });
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
    if (message.payload.mode === 'git-head') {
      gitBaselineState = message.payload;
    }
    gitClient?.handleMessage(message, { editor: gitChangesGutterVisible ? editor : undefined });
    presentChangesReview();
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
  changesReviewControl.destroy();
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
    if (isSidePreviewVisible()) editor.linkedPreviewReady?.();
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

sourcePreviewButton.addEventListener('click', () => {
  if (getActiveEditorMode() !== 'source' || !editor) return;
  const viewport = editor.captureViewportAnchorToken?.('editor') ?? null;
  sourcePreviewEnabled = !sourcePreviewEnabled;
  const { split } = presentPreviewSurface(false, { atomicSplit: sourcePreviewEnabled });
  editor.focus();
  if (viewport) {
    editor.restoreViewportAnchorToken?.(viewport, 'editor');
  }
  editor.refreshLayout?.();
  if (split) {
    (editor.view as typeof editor.view & { measure(flush?: boolean): void }).measure(false);
    markSourcePreviewEditorReady();
  }
});

sourcePreviewScrollSyncButton.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse') event.preventDefault();
});

sourcePreviewScrollSyncButton.addEventListener('click', () => {
  if (!isSidePreviewVisible() || !editor) return;
  sourcePreviewScrollSyncEnabled = !sourcePreviewScrollSyncEnabled;
  editor.setLinkedPreviewEnabled?.(
    sourcePreviewScrollSyncEnabled,
    sourcePreviewScrollSyncEnabled ? 'last-interaction' : undefined
  );
  presentSourcePreviewControls();
});

sourcePreviewScrollSyncButton.addEventListener('wheel', (event) => {
  if (!isSidePreviewVisible() || event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  editor?.markPreviewViewportInteraction?.();
  const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? previewController.host.clientHeight
      : 1;
  previewController.writeScrollTop(
    previewController.readScrollTop() + event.deltaY * deltaScale
  );
}, { passive: false });

previewButton.addEventListener('click', () => {
  void editorModeRuntime.dispatch({
    type: 'requestMode', mode: 'preview', source: 'user',
    restoreEditorFocus: editor?.hasFocus() === true
  });
});

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
sourceLineNumbersBtn.addEventListener('click', () => {
  const nextMode = pendingSourceLineNumbers === 'off' ? previousVisibleSourceLineNumbers : 'off';
  if (nextMode !== 'off') previousVisibleSourceLineNumbers = nextMode;
  pendingSourceLineNumbers = nextMode;
  sourceLineNumbersBtn.classList.toggle('is-active', nextMode !== 'off');
  sourceLineNumbersBtn.setAttribute('aria-checked', nextMode !== 'off' ? 'true' : 'false');
  editor?.setSourceLineNumbers(nextMode);
  vscode.postMessage({ type: 'setSourceLineNumbers', mode: nextMode });
});
longCodeBlockFoldingBtn.addEventListener('click', () => {
  longCodeBlockFoldingEnabled = !longCodeBlockFoldingEnabled;
  longCodeBlockFoldingBtn.classList.toggle('is-active', longCodeBlockFoldingEnabled);
  longCodeBlockFoldingBtn.setAttribute('aria-checked', longCodeBlockFoldingEnabled ? 'true' : 'false');
  editor?.setLongCodeBlockFolding(longCodeBlockFoldingEnabled);
});
tableStickyHeaderBtn.addEventListener('click', () => {
  setTableStickyHeaderEnabled(!tableStickyHeaderEnabled);
});
restoreReadingPositionBtn.addEventListener('click', () => {
  setRestoreReadingPositionOnOpen(!restoreReadingPositionOnOpen);
});

for (const eventName of ['wheel', 'pointerdown', 'keydown', 'touchstart']) {
  root.addEventListener(eventName, (event) => {
    if (event.isTrusted) readingPositionLifecycle?.userInteracted();
  }, { capture: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') readingPositionLifecycle?.flush();
});
window.addEventListener('pagehide', () => readingPositionLifecycle?.flush());
scheduleReadyHandshake();
scheduleEditorBundleWarmupAfterReady();
