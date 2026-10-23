import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import type { ChangesReviewUnavailableReason } from './changesReview';

export type { UiLanguage } from '../../../src/foundation/uiLanguage';

export type GitHeadDisplayStatus =
  | 'git-unavailable'
  | 'not-repo'
  | 'ignored'
  | 'untracked'
  | 'no-commits'
  | 'not-file'
  | 'too-large'
  | 'binary'
  | 'error';

export type UiStrings = Readonly<{
  auto: string;
  light: string;
  dark: string;
  previewTitle: string;
  previewPreset: string;
  previewPresetInfo: string;
  previewPresetManage: string;
  previewOnlyLight: string;
  previewOnlyDark: string;
  previewThemeSupport: string;
  previewCurrentTheme: string;
  previewControlEditable: string;
  previewControlFixed: string;
  previewControlStyles: string;
  previewControlUnsupported: string;
  previewUnsupportedOption: string;
  previewFixedFontFamily: string;
  previewFixedWidth: string;
  previewFixedAppearance: string;
  previewPresetError: string;
  previewFixedCodeColorsOn: string;
  previewFixedCodeColorsOff: string;
  previewFixedCommentsShow: string;
  previewFixedCommentsHide: string;
  previewWidth: string;
  previewWidthResponsive: string;
  previewWidthReference: string;
  previewAppearance: string;
  previewSourceColoring: string;
  strongColoring: string;
  boldHeadings: string;
  showComments: string;
  previewCommentsShow: string;
  previewCommentsHide: string;
  previewCodeColors: string;
  previewCodeColorsOn: string;
  previewCodeColorsOff: string;
  previewFontFamily: string;
  previewCodeFontFamily: string;
  previewFontSearch: string;
  previewFontClearSearch: string;
  previewFontEmpty: string;
  previewFontRefresh: string;
  previewFontReset: string;
  previewFontResetShort: string;
  previewFontRefreshShort: string;
  previewFontMissing: string;
  previewFontLoading: string;
  previewPresetFont: string;
  previewCodeTypographyFallback: string;
  previewFontPlaceholder: string;
  previewFontUnavailable: string;
  previewGenerating: string;
  previewFailed: string;
  previewTools: string;
  exportDocument: string;
  exportStyleNote: string;
  exportHtml: string;
  exportPdf: string;
  exportDocx: string;
  exportAsHtml: string;
  exportAsPdf: string;
  exportAsDocx: string;
  exportHtmlWithContents: string;
  exportPdfWithContents: string;
  exportDocxWithContents: string;
  findAndReplace: string;
  more: string;
  moreTools: string;
  toolbarOverflow: string;
  feedbackPrompt: string;
  reportIssue: string;
  editorAppearance: string;
  editorFontSize: string;
  custom: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  interfaceLanguage: string;
  showLineNumbers: string;
  foldLongCodeBlocks: string;
  largeDocumentStartup: string;
  largeDocumentStartupDescription: string;
  largeDocumentStartupHint: string;
  stickyTableHeader: string;
  findAndReplacePanel: string;
  find: string;
  replace: string;
  clearFind: string;
  clearReplace: string;
  wholeWord: string;
  caseSensitive: string;
  previousMatch: string;
  nextMatch: string;
  closeFind: string;
  replaceCurrentMatch: string;
  replaceAllMatches: string;
  noMatches: string;
  enterText: string;
  replaced: string;
  findMatches: (count: number) => string;
  replacedCurrent: (current: number, total: number) => string;
  replacedRemaining: (count: number) => string;
  replacedMatches: (count: number) => string;
  documentOutline: string;
  outline: string;
  outlineCollapseTopTwo: string;
  outlineExpandAll: string;
  outlineSwitchFixed: string;
  outlineSwitchFloating: string;
  outlineSwitchLeft: string;
  outlineSwitchRight: string;
  outlineClose: string;
  outlineResize: string;
  outlineEmptyHeading: string;
  outlineExpand: string;
  outlineCollapse: string;
  outlineNoHeadings: string;
  outlineLoading: string;
  untitled: string;
  backToTop: string;
  editorToolbar: string;
  formatting: string;
  markdownMode: string;
  live: string;
  source: string;
  liveLoading: string;
  sourceLoading: string;
  split: string;
  preview: string;
  sidePreview: string;
  sidePreviewMore: string;
  exitSidePreview: string;
  showSidePreview: string;
  hideSidePreview: string;
  disableSynchronizedScrolling: string;
  enableSynchronizedScrolling: string;
  inlineMarkdownFormatting: string;
  bold: string;
  italic: string;
  lineover: string;
  highlight: string;
  inlineCode: string;
  kbd: string;
  underline: string;
  markTaskComplete: string;
  markTaskIncomplete: string;
  clearLinkUrl: string;
  jumpWithinDocument: string;
  openLink: string;
  linkDestination: (href: string) => string;
  missingWikiLink: string;
  missingLocalLink: string;
  expandDetails: string;
  collapseDetails: string;
  showHtmlSource: string;
  jumpToFootnote: (number: number) => string;
  jumpToFootnoteReference: (number: number) => string;
  indentedCodeBlockLabel: string;
  copyCode: string;
  copied: string;
  copy: string;
  selectAllCode: string;
  all: string;
  codeLines: (count: number) => string;
  showMoreCode: (count: number) => string;
  showMoreLines: (count: number) => string;
  showLessCode: string;
  showLess: string;
  mermaidBlockControls: (line: number) => string;
  mermaidEditor: (line: number) => string;
  editMermaidSplit: string;
  showMermaidSource: string;
  showMermaidPreview: string;
  formulaBlockControls: (line: number) => string;
  formulaEditor: (line: number) => string;
  editFormulaSplit: string;
  showFormulaSource: string;
  showFormulaPreview: string;
  loading: string;
  zoomIn: string;
  zoomOut: string;
  resetZoom: string;
  morePreviewControls: string;
  fullscreen: string;
  exitFullscreen: string;
  mermaidError: (message: string) => string;
  openWithSystemApp: string;
  fullscreenImage: string;
  refreshImage: string;
  colorLabel: (value: string) => string;
  adjustColor: (value: string) => string;
  colorControls: (value: string) => string;
  hexColorValue: string;
  hue: string;
  saturation: string;
  brightness: string;
  opacity: string;
  closeColorControls: string;
  cancelColorAdjustment: string;
  applyColorAdjustment: string;
  showHtmlPreview: string;
  unsupportedHtmlSource: string;
  acceptCurrent: string;
  acceptIncoming: string;
  acceptBoth: string;
  currentVersion: (label: string) => string;
  incomingVersion: (label: string) => string;
  alertLabel: (type: string) => string;
  tableActions: string;
  returnToTableHeader: string;
  tableInsert: string;
  tableMove: string;
  tableDelete: string;
  deleteTable: string;
  sortTableAscending: string;
  sortTableDescending: string;
  tableBack: string;
  tableCollapse: string;
  tableMoreActions: string;
  tablePreviousActions: string;
  tableAlign: string;
  insertRowAbove: string;
  insertRowBelow: string;
  moveRowUp: string;
  moveRowDown: string;
  deleteRow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  moveColumnLeft: string;
  moveColumnRight: string;
  deleteColumn: string;
  alignColumnLeft: string;
  alignColumnCenter: string;
  alignColumnRight: string;
  insertRowAboveShort: string;
  insertRowBelowShort: string;
  insertColumnLeftShort: string;
  insertColumnRightShort: string;
  moveRowUpShort: string;
  moveRowDownShort: string;
  moveColumnLeftShort: string;
  moveColumnRightShort: string;
  deleteRowShort: string;
  deleteColumnShort: string;
  alignColumnLeftShort: string;
  alignColumnCenterShort: string;
  alignColumnRightShort: string;
  heading: string;
  headingLevels: string;
  headingLevel: (level: number) => string;
  bulletList: string;
  numberedList: string;
  task: string;
  showOutlineLeft: string;
  showOutlineRight: string;
  codeBlock: string;
  quote: string;
  horizontalRule: string;
  link: string;
  wikiLink: string;
  image: string;
  table: string;
  line: string;
  goToLine: string;
  alignSourceToPreview: string;
  alignPreviewToSource: string;
  save: string;
  saveDocument: string;
  saveAs: string;
  saveAsFailed: string;
  retrySaveAs: string;
  saveAsResultUnknown: string;
  saveAsResultUnknownMessage: string;
  historyFailed: string;
  historyFailedMessage: string;
  undo: string;
  redo: string;
  reloadDiskVersion: string;
  reloadDiskVersionDoubleClick: string;
  constrainContentWidth: string;
  constrainWidth: string;
  disableConstrainedWidth: string;
  resumeFromLastPosition: string;
  resumeReadingPositionLabel: string;
  currentEdits: string;
  recentSave: string;
  gitHead: string;
  compareWithVersion: string;
  displaySettings: string;
  editorSettings: string;
  documentDisplaySettings: string;
  openingDocumentsSettings: string;
  interfaceSettings: string;
  currentDiskVersionOption: string;
  beforeLastSaveVersionOption: string;
  gitHeadOption: string;
  gitHeadStatus: (status: GitHeadDisplayStatus) => string;
  gitHeadWithStatus: (status: string) => string;
  gitHeadOptionWithStatus: (status: string) => string;
  manualSnapshot: string;
  manualSnapshotOption: string;
  disableComparison: string;
  createSnapshot: string;
  clickToCreateSnapshot: string;
  updateSnapshot: string;
  showChangeLocations: string;
  showBeforeChangeContent: string;
  noChanges: string;
  noComparison: string;
  comparisonUnavailable: string;
  comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => string;
  addedCount: (count: number) => string;
  deletedCount: (count: number) => string;
  comparedWith: (baseline: string) => string;
  changesComparedWith: (summary: string, baseline: string) => string;
  dismissNotification: string;
  dismissNotificationButton: string;
  commentSelectionBlocked: string;
  noticeInfoTitle: string;
  noticeWarningTitle: string;
  noticeErrorTitle: string;
  noticeLiveModeUnavailableTitle: string;
  noticeEditorUpdateFailedTitle: string;
  noticeLiveRenderIssueTitle: string;
  noticeEditorLoadFailedTitle: string;
  noticeDocumentSyncFailedTitle: string;
  noticeExternalConflictTitle: string;
  noticeReloadDiskFailedTitle: string;
  noticeExternalFileModifiedTitle: string;
  noticeExternalFileDeletedTitle: string;
  noticeExternalFileUnreadableTitle: string;
  noticePasteImageFailedTitle: string;
  retryLiveMode: string;
  retryDocumentUpdate: string;
  retryDocumentUpdateFailed: string;
  retryImagePaste: string;
  retryImagePasteFailed: string;
  restartEditor: string;
  saveCopy: string;
  noticeActionFailed: string;
  switchToSourceMode: string;
  liveModeFailure: string;
  editorUpdateFailure: string;
  transientUpdateFailure: string;
  transientModeFailure: string;
  transientLoadFailure: string;
  pasteImageFailure: (message: string) => string;
  properties: string;
  resyncFailureNotice: string;
  externalConflictNotice: string;
  reloadDiskFailureNotice: string;
  externalFileModifiedNotice: string;
  externalFileDeletedNotice: string;
  externalFileUnreadableNotice: string;
}>;

const CATALOG: Readonly<Record<UiLanguage, UiStrings>> = Object.freeze({
  en: Object.freeze({
    auto: 'Auto', light: 'Light', dark: 'Dark', previewTitle: 'Markdown Preview',
    previewAppearance: 'Preview theme', previewSourceColoring: 'Preview source coloring', strongColoring: 'Color bold text', boldHeadings: 'Bold headings', showComments: 'HTML comments', previewCommentsShow: 'Show', previewCommentsHide: 'Hide',
    previewCodeColors: 'Code color', previewCodeColorsOn: 'On', previewCodeColorsOff: 'Off',
    previewPreset: 'Preview preset', previewPresetInfo: 'Preset info', previewWidth: 'Width', previewWidthResponsive: 'Fit panel', previewWidthReference: 'Reference width',
    previewPresetManage: 'Custom presets…', previewOnlyLight: 'This preset only supports the light theme', previewOnlyDark: 'This preset only supports the dark theme',
    previewThemeSupport: 'Theme support', previewCurrentTheme: 'Current theme', previewControlEditable: 'Adjustable', previewControlFixed: 'Fixed',
    previewControlStyles: 'Set by style', previewControlUnsupported: 'Unavailable', previewPresetError: 'Preset error',
    previewUnsupportedOption: 'This preset does not support this option', previewFixedFontFamily: 'Font is set by this preset’s style',
    previewFixedWidth: 'Content width is fixed by this preset', previewFixedAppearance: 'Theme is fixed by this preset',
    previewFixedCodeColorsOn: 'This preset keeps code coloring on', previewFixedCodeColorsOff: 'This preset keeps code coloring off',
    previewFixedCommentsShow: 'This preset always shows HTML comments', previewFixedCommentsHide: 'This preset always hides HTML comments',
    exportStyleNote: 'HTML and PDF use the current preview style.\nWord uses a fixed export style.',
    previewFontFamily: 'Body font',
    previewCodeFontFamily: 'Code font',
    previewFontSearch: 'Search fonts',
    previewFontClearSearch: 'Clear font search',
    previewFontEmpty: 'No matching fonts',
    previewFontRefresh: 'Refresh font list',
    previewFontReset: 'Reset font',
    previewFontResetShort: 'Default',
    previewFontRefreshShort: 'Refresh',
    previewFontMissing: 'Not found in the font list',
    previewFontLoading: 'Loading system fonts…',
    previewPresetFont: 'Use preset font',
    previewCodeTypographyFallback: 'Invalid code font size or line height; readable defaults applied.',
    previewFontPlaceholder: 'Use default font',
    previewFontUnavailable: 'System font list unavailable; keeping current choices',
    previewGenerating: 'Loading preview…',
    previewFailed: 'Preview generation failed', previewTools: 'Preview tools', exportDocument: 'Export as…',
    exportHtml: 'Export as HTML', exportPdf: 'Export as PDF', exportDocx: 'Export as Word', exportAsHtml: 'Export as HTML',
    exportAsPdf: 'Export as PDF', exportAsDocx: 'Export as Word document', exportHtmlWithContents: 'Export as HTML with Contents',
    exportPdfWithContents: 'Export as PDF with Contents', exportDocxWithContents: 'Export as Word with Contents', findAndReplace: 'Find and replace', more: 'Settings',
    moreTools: 'Settings', toolbarOverflow: 'More tools', feedbackPrompt: 'Having trouble?', reportIssue: 'Report an issue',
    editorAppearance: 'UI theme', editorFontSize: 'Font size',
    custom: 'Custom', decreaseFontSize: 'Decrease font size', increaseFontSize: 'Increase font size',
    interfaceLanguage: 'Language', showLineNumbers: 'Show line numbers',
    foldLongCodeBlocks: 'Fold long code blocks', largeDocumentStartup: 'Large document opening: prefer Source',
    largeDocumentStartupDescription: 'When enabled, open large documents in Source mode. When disabled, remember your last mode. You can always switch modes; automatic performance optimizations remain active.',
    largeDocumentStartupHint: 'Only changes how large documents open. When off, use your last mode; automatic performance optimizations remain active.',
    stickyTableHeader: 'Keep table headers visible',
    findAndReplacePanel: 'Find and replace', find: 'Find', replace: 'Replace',
    clearFind: 'Clear Find', clearReplace: 'Clear Replace', wholeWord: 'Whole word',
    caseSensitive: 'Case sensitive', previousMatch: 'Previous match', nextMatch: 'Next match',
    closeFind: 'Close Find', replaceCurrentMatch: 'Replace current match',
    replaceAllMatches: 'Replace all matches', noMatches: 'No matches', enterText: 'Enter text',
    replaced: 'Replaced', findMatches: (count: number) => `${count} matches`,
    replacedCurrent: (current: number, total: number) => `Replaced • ${current}/${total}`,
    replacedRemaining: (count: number) => `Replaced • ${count} remaining`,
    replacedMatches: (count: number) => `Replaced ${count} matches`,
    documentOutline: 'Document outline', outline: 'Outline', outlineCollapseTopTwo: 'Collapse to level 1',
    outlineExpandAll: 'Expand all', outlineSwitchFixed: 'Switch to fixed outline',
    outlineSwitchFloating: 'Switch to floating outline', outlineSwitchLeft: 'Switch to left side',
    outlineSwitchRight: 'Switch to right side', outlineClose: 'Close outline',
    outlineResize: 'Drag to resize outline',
    outlineEmptyHeading: '(Empty heading)',
    outlineExpand: 'Expand', outlineCollapse: 'Collapse', outlineNoHeadings: 'No headings', outlineLoading: 'Preparing outline…', untitled: 'Untitled',
    backToTop: 'Back to top',
    editorToolbar: 'Editor toolbar', formatting: 'Formatting', markdownMode: 'Markdown mode',
    live: 'Live', source: 'Source', liveLoading: 'Loading Live view…', sourceLoading: 'Loading Source view…', split: 'Split', preview: 'Preview',
    sidePreview: 'Side preview', sidePreviewMore: 'Preview options', exitSidePreview: 'Exit side preview',
    showSidePreview: 'Show side preview', hideSidePreview: 'Hide side preview',
    disableSynchronizedScrolling: 'Disable scroll sync',
    enableSynchronizedScrolling: 'Enable scroll sync',
    inlineMarkdownFormatting: 'Inline markdown formatting', bold: 'Bold', italic: 'Italic',
    lineover: 'Strikethrough', highlight: 'Highlight', inlineCode: 'Inline code', kbd: 'Keyboard style',
    underline: 'Underline', markTaskComplete: 'Mark task as complete',
    markTaskIncomplete: 'Mark task as incomplete', clearLinkUrl: 'Clear link URL',
    jumpWithinDocument: 'Jump within document', openLink: 'Open link',
    linkDestination: (href: string) => 'Go to: ' + href,
    missingWikiLink: 'Wiki link target not found locally', missingLocalLink: 'Local file link target not found',
    expandDetails: 'Expand details', collapseDetails: 'Collapse details', showHtmlSource: 'Show HTML source',
    jumpToFootnote: (number: number) => `Jump to footnote ${number}`,
    jumpToFootnoteReference: (number: number) => `Jump to footnote reference ${number}`,
    indentedCodeBlockLabel: 'Indented code block',
    copyCode: 'Copy', copied: 'copied', copy: 'copy', selectAllCode: 'Select all code', all: 'all',
    codeLines: (count: number) => `${count} lines`,
    showMoreCode: (count: number) => `Show ${count} more lines of code`,
    showMoreLines: (count: number) => `Show ${count} more lines`, showLessCode: 'Show less code', showLess: 'Show less',
    mermaidBlockControls: (line: number) => `Mermaid block controls at line ${line}`,
    mermaidEditor: (line: number) => `Mermaid editor at line ${line}`,
    editMermaidSplit: 'Switch to split view', showMermaidSource: 'Switch to source',
    showMermaidPreview: 'Switch to preview',
    formulaBlockControls: (line: number) => `Formula block controls at line ${line}`,
    formulaEditor: (line: number) => `Formula editor at line ${line}`,
    editFormulaSplit: 'Switch to split view', showFormulaSource: 'Switch to source',
    showFormulaPreview: 'Switch to preview',
    loading: 'Loading…', zoomIn: 'Zoom in', zoomOut: 'Zoom out', resetZoom: 'Reset zoom',
    morePreviewControls: 'More preview controls',
    fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen',
    mermaidError: (message: string) => `Mermaid error: ${message}`,
    openWithSystemApp: 'Open with system app', fullscreenImage: 'Fullscreen image', refreshImage: 'Refresh image',
    colorLabel: (value: string) => `Color ${value}`,
    adjustColor: (value: string) => `Adjust color ${value}`,
    colorControls: (value: string) => `Color controls for ${value}`,
    hexColorValue: 'HEX color value', hue: 'Hue', saturation: 'Saturation',
    brightness: 'Brightness', opacity: 'Opacity', closeColorControls: 'Close color controls',
    cancelColorAdjustment: 'Cancel', applyColorAdjustment: 'Apply',
    showHtmlPreview: 'Show HTML preview',
    unsupportedHtmlSource: 'Invalid or unsupported HTML; source retained',
    acceptCurrent: 'Accept Current', acceptIncoming: 'Accept Incoming', acceptBoth: 'Accept Both',
    currentVersion: (label: string) => `Current: ${label},`,
    incomingVersion: (label: string) => `Incoming: ${label}`,
    alertLabel: (type: string) => type,
    tableActions: 'Table actions', returnToTableHeader: 'Click to return to table header',
    tableInsert: 'Insert', tableMove: 'Move', tableDelete: 'Delete', tableBack: 'Back',
    deleteTable: 'Delete table', sortTableAscending: 'Sort ascending', sortTableDescending: 'Sort descending',
    tableCollapse: 'Collapse table actions', tableMoreActions: 'Next page',
    tablePreviousActions: 'Previous page',
    tableAlign: 'Align',
    insertRowAbove: 'Insert row above', insertRowBelow: 'Insert row below', moveRowUp: 'Move row up', moveRowDown: 'Move row down',
    deleteRow: 'Delete row', insertColumnLeft: 'Insert column left', insertColumnRight: 'Insert column right',
    moveColumnLeft: 'Move column left', moveColumnRight: 'Move column right',
    deleteColumn: 'Delete column', alignColumnLeft: 'Align selected column left',
    alignColumnCenter: 'Align selected column center', alignColumnRight: 'Align selected column right',
    insertRowAboveShort: 'Row above', insertRowBelowShort: 'Row below',
    insertColumnLeftShort: 'Column left', insertColumnRightShort: 'Column right',
    moveRowUpShort: 'Row up', moveRowDownShort: 'Row down',
    moveColumnLeftShort: 'Column left', moveColumnRightShort: 'Column right',
    deleteRowShort: 'Row', deleteColumnShort: 'Column',
    alignColumnLeftShort: 'Left', alignColumnCenterShort: 'Center', alignColumnRightShort: 'Right',
    heading: 'Heading',
    headingLevels: 'Heading levels', headingLevel: (level: number) => `Heading ${level}`,
    bulletList: 'Bullet list', numberedList: 'Numbered list', task: 'Task list',
    showOutlineLeft: 'Show outline on left', showOutlineRight: 'Show outline on right',
    codeBlock: 'Code block', quote: 'Blockquote', horizontalRule: 'Horizontal rule',
    link: 'Link', wikiLink: 'Wiki link', image: 'Image', table: 'Insert table', line: 'Lines',
    goToLine: 'Go to line', alignSourceToPreview: 'Align source to preview view', alignPreviewToSource: 'Align preview to source view', save: 'Save', saveDocument: 'Save document',
    saveAs: 'Save as…', saveAsFailed: 'Save As failed', undo: 'Undo', redo: 'Redo',
    retrySaveAs: 'Retry save as…',
    saveAsResultUnknown: 'Save As result not confirmed',
    saveAsResultUnknownMessage: 'Saving may still be in progress. Check the Save As dialog and destination file before trying again.',
    historyFailed: 'Undo/Redo could not finish',
    historyFailedMessage: 'Check the current document before continuing. You can save a copy to keep its current contents.',
    reloadDiskVersion: 'Reload (discard unsaved changes)', reloadDiskVersionDoubleClick: 'Confirm reload (discard unsaved changes)',
    constrainContentWidth: 'Constrain Content Width', constrainWidth: 'Limit content width',
    disableConstrainedWidth: 'Disable Constrained Width',
    resumeFromLastPosition: 'Resume from last position', resumeReadingPositionLabel: 'Resume from last position',
    currentEdits: 'Last Saved Version', recentSave: 'Before Agent Edits',
    gitHead: 'Git HEAD (Latest Commit)',
    compareWithVersion: 'Compare Against', displaySettings: 'Display Settings', editorSettings: 'Editor Settings',
    documentDisplaySettings: 'Document display', openingDocumentsSettings: 'When opening documents', interfaceSettings: 'Interface settings',
    currentDiskVersionOption: 'Last Saved Version',
    beforeLastSaveVersionOption: 'Before Agent Edits',
    gitHeadOption: 'Git HEAD', manualSnapshot: 'Manual Snapshot',
    manualSnapshotOption: 'Manual Snapshot', disableComparison: 'Turn Off Comparison',
    gitHeadStatus: (status: GitHeadDisplayStatus) => ({
      'git-unavailable': 'Git Unavailable',
      'not-repo': 'Not a Git Repo',
      ignored: 'Ignored by Git',
      untracked: 'Untracked File',
      'no-commits': 'No Commits',
      'not-file': 'Not a Local File',
      'too-large': 'File Too Large',
      binary: 'Binary File',
      error: 'Temporary Error'
    })[status],
    gitHeadWithStatus: (status: string) => `Git HEAD (${status})`,
    gitHeadOptionWithStatus: (status: string) => `Git HEAD · ${status}`,
    createSnapshot: 'Create',
    clickToCreateSnapshot: 'Click to Create', updateSnapshot: 'Update',
    showChangeLocations: 'Mark Change Locations',
    showBeforeChangeContent: 'Show Original · Source Only',
    noChanges: 'No Changes', noComparison: 'No comparison',
    comparisonUnavailable: 'Unable to Compare',
    comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => ({
      'git-unavailable': 'Git Unavailable',
      'not-repo': 'Not a Git Repo',
      ignored: 'Ignored by Git',
      'not-file': 'Not a Local File',
      'too-large': 'File Too Large',
      binary: 'Binary File',
      error: 'Temporary Error',
      'no-baseline': 'No Comparison Version',
      timeout: 'Comparison Timed Out'
    })[reason],
    addedCount: (count: number) => `${count} added`, deletedCount: (count: number) => `${count} deleted`,
    comparedWith: (baseline: string) => `vs. ${baseline}`,
    changesComparedWith: (summary: string, baseline: string) => `${summary} · Compared with ${baseline}`,
    dismissNotification: 'Dismiss notification',
    dismissNotificationButton: 'Dismiss',
    commentSelectionBlocked: 'The selection contains a comment or code. Narrow the selection and try again.',
    noticeInfoTitle: 'Status',
    noticeWarningTitle: 'Action needed',
    noticeErrorTitle: 'Editor issue',
    noticeLiveModeUnavailableTitle: 'Live Mode unavailable',
    noticeEditorUpdateFailedTitle: 'Editor update failed',
    noticeLiveRenderIssueTitle: 'Live rendering interrupted',
    noticeEditorLoadFailedTitle: 'Editor failed to load',
    noticeDocumentSyncFailedTitle: 'Document sync failed',
    noticeExternalConflictTitle: 'External change detected',
    noticeReloadDiskFailedTitle: 'Disk reload failed',
    noticeExternalFileModifiedTitle: 'File changed on disk',
    noticeExternalFileDeletedTitle: 'File deleted on disk',
    noticeExternalFileUnreadableTitle: 'Could not verify disk version',
    noticePasteImageFailedTitle: 'Image paste failed',
    retryLiveMode: 'Retry',
    retryDocumentUpdate: 'Retry Update',
    retryDocumentUpdateFailed: 'The update still could not be shown.',
    retryImagePaste: 'Retry Paste',
    retryImagePasteFailed: 'The image still could not be inserted.',
    restartEditor: 'Restart Editor',
    saveCopy: 'Save Copy',
    noticeActionFailed: 'Action failed:',
    switchToSourceMode: 'Switch to Source',
    liveModeFailure: 'Live mode failed to render this document. Switched to Source mode.',
    editorUpdateFailure: 'The editor could not show the latest document content. Retry the update.',
    transientUpdateFailure: 'Live mode hit a transient render error while updating. Try again.',
    transientModeFailure: 'Live mode hit a transient render error. Staying in current mode; try again.',
    transientLoadFailure: 'Live mode hit a transient render error while loading. Try reopening or switching modes.',
    pasteImageFailure: (message: string) => `Could not paste image: ${message}`,
    properties: 'Properties',
    resyncFailureNotice: 'Could not resynchronize the document. Local edits were kept; save a copy to protect them.',
    externalConflictNotice: 'The document changed while a local edit was still being applied. Local edits were kept; save a copy before resolving the conflict.',
    reloadDiskFailureNotice: 'Could not reload the latest version from disk. Unsaved edits were kept; save a copy to protect them.',
    externalFileModifiedNotice: 'The file changed on disk. Unsaved edits were kept; save a copy before deciding how to proceed.',
    externalFileDeletedNotice: 'The file was deleted from disk. Unsaved edits were kept; save a copy to protect them.',
    externalFileUnreadableNotice: 'Could not read the disk version. Unsaved edits remain in the editor; save a copy to protect them.'
  }),
  'zh-CN': Object.freeze({
    auto: '自动', light: '浅色', dark: '深色', previewTitle: 'Markdown 预览',
    previewAppearance: '预览主题', previewSourceColoring: '预览源码着色', strongColoring: '粗体文字着色', boldHeadings: '标题加粗', showComments: 'HTML 注释', previewCommentsShow: '显示', previewCommentsHide: '隐藏',
    previewCodeColors: '代码着色', previewCodeColorsOn: '开', previewCodeColorsOff: '关',
    previewPreset: '预览预设', previewPresetInfo: '预设说明', previewWidth: '正文宽度', previewWidthResponsive: '适配面板', previewWidthReference: '参考宽度',
    previewPresetManage: '自定义预设…', previewOnlyLight: '此预设仅支持浅色主题', previewOnlyDark: '此预设仅支持深色主题',
    previewThemeSupport: '主题支持', previewCurrentTheme: '当前主题', previewControlEditable: '可调整', previewControlFixed: '固定',
    previewControlStyles: '由样式决定', previewControlUnsupported: '不支持调整', previewPresetError: '预设错误',
    previewUnsupportedOption: '此预设不支持此选项', previewFixedFontFamily: '字体由此预设的样式决定',
    previewFixedWidth: '正文宽度由此预设固定', previewFixedAppearance: '主题由此预设固定',
    previewFixedCodeColorsOn: '此预设固定开启代码着色', previewFixedCodeColorsOff: '此预设固定关闭代码着色',
    previewFixedCommentsShow: '此预设固定显示 HTML 注释', previewFixedCommentsHide: '此预设固定隐藏 HTML 注释',
    exportStyleNote: 'HTML、PDF 沿用当前预览样式。\nWord 使用固定导出样式。',
    previewFontFamily: '正文字体',
    previewCodeFontFamily: '代码字体',
    previewFontSearch: '搜索字体',
    previewFontClearSearch: '清空字体搜索',
    previewFontEmpty: '未找到匹配字体',
    previewFontRefresh: '刷新字体列表',
    previewFontReset: '还原默认字体',
    previewFontResetShort: '默认',
    previewFontRefreshShort: '刷新',
    previewFontMissing: '列表中未找到',
    previewFontLoading: '正在读取系统字体…',
    previewPresetFont: '使用预设字体',
    previewCodeTypographyFallback: '代码字号或行高无效，已恢复可读的默认值。',
    previewFontPlaceholder: '使用默认字体',
    previewFontUnavailable: '无法读取系统字体列表，保留当前候选',
    previewGenerating: '正在加载预览…',
    previewFailed: '预览生成失败', previewTools: '预览工具', exportDocument: '导出为…', exportHtml: '导出为 HTML',
    exportPdf: '导出为 PDF', exportDocx: '导出为 Word', exportAsHtml: '导出为 HTML', exportAsPdf: '导出为 PDF',
    exportAsDocx: '导出为 Word 文档', exportHtmlWithContents: '导出为 HTML（含目录）', exportPdfWithContents: '导出为 PDF（含目录）',
    exportDocxWithContents: '导出为 Word（含目录）',
    findAndReplace: '查找和替换', more: '设置', moreTools: '设置', toolbarOverflow: '更多工具',
    feedbackPrompt: '使用中遇到问题？', reportIssue: '欢迎反馈',
    editorAppearance: '界面主题', editorFontSize: '字号大小', custom: '自定义',
    decreaseFontSize: '减小字号', increaseFontSize: '增大字号',
    interfaceLanguage: '界面语言', showLineNumbers: '显示行号',
    foldLongCodeBlocks: '折叠长代码块', largeDocumentStartup: '大文档打开方式：优先源码',
    largeDocumentStartupDescription: '开启后，大文档优先以源码模式打开；关闭后，沿用上次选择的模式。仍可随时切换模式，各模式的自动性能优化照常启用。',
    largeDocumentStartupHint: '只影响大文档的打开方式。关闭后沿用上次选择，自动性能优化照常启用。',
    stickyTableHeader: '表格浮动表头',
    findAndReplacePanel: '查找和替换', find: '查找',
    replace: '替换', clearFind: '清除查找内容', clearReplace: '清除替换内容',
    wholeWord: '全字匹配', caseSensitive: '区分大小写', previousMatch: '上一个匹配项',
    nextMatch: '下一个匹配项', closeFind: '关闭查找', replaceCurrentMatch: '替换当前匹配项',
    replaceAllMatches: '替换全部匹配项', noMatches: '无匹配项', enterText: '请输入文本',
    replaced: '已替换', findMatches: (count: number) => `${count} 个匹配项`,
    replacedCurrent: (current: number, total: number) => `已替换 • ${current}/${total}`,
    replacedRemaining: (count: number) => `已替换 • 剩余 ${count} 个`,
    replacedMatches: (count: number) => `已替换 ${count} 个匹配项`,
    documentOutline: '文档目录', outline: '目录', outlineCollapseTopTwo: '折叠到一级标题',
    outlineExpandAll: '展开全部', outlineSwitchFixed: '切换到固定目录',
    outlineSwitchFloating: '切换到浮动目录', outlineSwitchLeft: '切换到左侧',
    outlineSwitchRight: '切换到右侧', outlineClose: '关闭目录',
    outlineResize: '拖动调整目录宽度',
    outlineEmptyHeading: '(空标题)',
    outlineExpand: '展开', outlineCollapse: '折叠', outlineNoHeadings: '暂无标题', outlineLoading: '正在生成目录…', untitled: '未命名',
    backToTop: '回到顶部',
    editorToolbar: '编辑器工具栏', formatting: '格式', markdownMode: 'Markdown 模式',
    live: '实时', source: '源码', liveLoading: '正在加载实时视图…', sourceLoading: '正在加载源码视图…', split: '分栏', preview: '预览',
    sidePreview: '侧边预览', sidePreviewMore: '预览选项', exitSidePreview: '退出侧边预览',
    showSidePreview: '显示侧边预览', hideSidePreview: '关闭侧边预览',
    disableSynchronizedScrolling: '关闭同步滚动',
    enableSynchronizedScrolling: '启用同步滚动',
    inlineMarkdownFormatting: '行内 Markdown 格式',
    bold: '加粗', italic: '斜体', lineover: '删除线', highlight: '高亮', inlineCode: '行内代码',
    kbd: '按键样式', underline: '下划线', markTaskComplete: '标记任务为已完成',
    markTaskIncomplete: '标记任务为未完成', clearLinkUrl: '清除链接地址',
    jumpWithinDocument: '在文档内跳转', openLink: '打开链接',
    linkDestination: (href: string) => '跳转到：' + href,
    missingWikiLink: '本地未找到 Wiki 链接目标', missingLocalLink: '未找到本地文件链接目标',
    expandDetails: '展开详细信息', collapseDetails: '折叠详细信息', showHtmlSource: '显示 HTML 源码',
    jumpToFootnote: (number: number) => `跳转到脚注 ${number}`,
    jumpToFootnoteReference: (number: number) => `跳转到脚注引用 ${number}`,
    indentedCodeBlockLabel: '缩进代码块',
    copyCode: '复制', copied: '已复制', copy: '复制', selectAllCode: '全选代码', all: '全选',
    codeLines: (count: number) => `${count} 行`,
    showMoreCode: (count: number) => `显示其余 ${count} 行代码`,
    showMoreLines: (count: number) => `显示其余 ${count} 行`, showLessCode: '收起代码', showLess: '收起',
    mermaidBlockControls: (line: number) => `第 ${line} 行 Mermaid 块控件`,
    mermaidEditor: (line: number) => `第 ${line} 行 Mermaid 编辑器`,
    editMermaidSplit: '切换为分栏', showMermaidSource: '切换为源码',
    showMermaidPreview: '切换为预览',
    formulaBlockControls: (line: number) => `第 ${line} 行公式块控件`,
    formulaEditor: (line: number) => `第 ${line} 行公式编辑器`,
    editFormulaSplit: '切换为分栏', showFormulaSource: '切换为源码',
    showFormulaPreview: '切换为预览',
    loading: '正在加载…', zoomIn: '放大', zoomOut: '缩小', resetZoom: '重置缩放',
    morePreviewControls: '更多预览操作',
    fullscreen: '全屏', exitFullscreen: '退出全屏',
    mermaidError: (message: string) => `Mermaid 错误：${message}`,
    openWithSystemApp: '使用系统应用打开', fullscreenImage: '全屏查看图片', refreshImage: '刷新图片',
    colorLabel: (value: string) => `颜色 ${value}`,
    adjustColor: (value: string) => `调整颜色 ${value}`,
    colorControls: (value: string) => `${value} 的颜色调整器`,
    hexColorValue: 'HEX 色值', hue: '色相', saturation: '饱和度',
    brightness: '明度', opacity: '透明度', closeColorControls: '关闭颜色调整器',
    cancelColorAdjustment: '取消', applyColorAdjustment: '应用',
    showHtmlPreview: '显示 HTML 预览',
    unsupportedHtmlSource: 'HTML 标记无效或不受支持，已保留源码',
    acceptCurrent: '接受当前更改', acceptIncoming: '接受传入更改', acceptBoth: '接受两者',
    currentVersion: (label: string) => `当前：${label}，`,
    incomingVersion: (label: string) => `传入：${label}`,
    alertLabel: (type: string) => ({ NOTE: '备注', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意' }[type] ?? type),
    tableActions: '表格操作', returnToTableHeader: '点击回到表头',
    tableInsert: '插入', tableMove: '移动', tableDelete: '删除', tableBack: '返回',
    deleteTable: '删除表格', sortTableAscending: '升序排列', sortTableDescending: '降序排列',
    tableCollapse: '收起表格操作', tableMoreActions: '下一页',
    tablePreviousActions: '上一页',
    tableAlign: '对齐',
    insertRowAbove: '在上方插入行', insertRowBelow: '在下方插入行', moveRowUp: '上移行', moveRowDown: '下移行',
    deleteRow: '删除行', insertColumnLeft: '在左侧插入列', insertColumnRight: '在右侧插入列',
    moveColumnLeft: '左移列', moveColumnRight: '右移列',
    deleteColumn: '删除列', alignColumnLeft: '所选列左对齐',
    alignColumnCenter: '所选列居中对齐', alignColumnRight: '所选列右对齐',
    insertRowAboveShort: '上方加行', insertRowBelowShort: '下方加行',
    insertColumnLeftShort: '左侧加列', insertColumnRightShort: '右侧加列',
    moveRowUpShort: '行上移', moveRowDownShort: '行下移',
    moveColumnLeftShort: '列左移', moveColumnRightShort: '列右移',
    deleteRowShort: '行', deleteColumnShort: '列',
    alignColumnLeftShort: '左对齐', alignColumnCenterShort: '居中', alignColumnRightShort: '右对齐',
    heading: '标题', headingLevels: '标题级别',
    headingLevel: (level: number) => `${level} 级标题`, bulletList: '无序列表',
    numberedList: '有序列表', task: '任务列表', showOutlineLeft: '在左侧显示目录',
    showOutlineRight: '在右侧显示目录', codeBlock: '代码块', quote: '引用',
    horizontalRule: '分隔线', link: '链接', wikiLink: 'Wiki 链接', image: '图片', table: '插入表格',
    line: '行号', goToLine: '跳转到行', alignSourceToPreview: '将源码对齐到预览视图', alignPreviewToSource: '将预览对齐到源码视图', save: '保存', saveDocument: '保存文档',
    saveAs: '另存为…', saveAsFailed: '另存为失败', undo: '撤销', redo: '重做',
    retrySaveAs: '重试另存为…',
    saveAsResultUnknown: '尚未确认另存为结果',
    saveAsResultUnknownMessage: '保存可能仍在进行。请先检查另存为对话框和目标文件，确认后再重试。',
    historyFailed: '撤销或重做未能完成',
    historyFailedMessage: '请先检查当前文档内容，再继续编辑。你可以另存副本保留当前内容。',
    reloadDiskVersion: '重新加载（放弃未保存内容）', reloadDiskVersionDoubleClick: '确认重新加载（放弃未保存内容）',
    constrainContentWidth: '限制内容宽度', constrainWidth: '限制宽度',
    disableConstrainedWidth: '取消内容宽度限制',
    resumeFromLastPosition: '打开时恢复上一次阅读位置', resumeReadingPositionLabel: '恢复阅读位置',
    currentEdits: '最近保存版本', recentSave: 'Agent 编辑前版本',
    gitHead: 'Git HEAD（最新提交）',
    compareWithVersion: '比较方式', displaySettings: '显示设置', editorSettings: '编辑器设置',
    documentDisplaySettings: '文档显示', openingDocumentsSettings: '打开文档时', interfaceSettings: '界面设置',
    currentDiskVersionOption: '与最近保存版本比较',
    beforeLastSaveVersionOption: '与 Agent 编辑前版本比较',
    gitHeadOption: '与 Git HEAD 比较', manualSnapshot: '手动快照',
    manualSnapshotOption: '与手动快照比较', disableComparison: '关闭比较',
    gitHeadStatus: (status: GitHeadDisplayStatus) => ({
      'git-unavailable': 'Git 不可用',
      'not-repo': '非 Git 仓库',
      ignored: 'Git 已忽略',
      untracked: '未跟踪文件',
      'no-commits': '暂无提交',
      'not-file': '非本地文件',
      'too-large': '文件过大',
      binary: '二进制文件',
      error: '暂不可用'
    })[status],
    gitHeadWithStatus: (status: string) => `Git HEAD（${status}）`,
    gitHeadOptionWithStatus: (status: string) => `与 Git HEAD 比较 · ${status}`,
    createSnapshot: '创建', clickToCreateSnapshot: '点击创建', updateSnapshot: '更新',
    showChangeLocations: '标记更改位置',
    showBeforeChangeContent: '显示修改前内容 · 仅源码模式', noChanges: '无更改', noComparison: '不比较',
    comparisonUnavailable: '无法比较',
    comparisonUnavailableReason: (reason: ChangesReviewUnavailableReason) => ({
      'git-unavailable': 'Git 不可用',
      'not-repo': '非 Git 仓库',
      ignored: 'Git 已忽略',
      'not-file': '非本地文件',
      'too-large': '文件过大',
      binary: '二进制文件',
      error: '暂不可用',
      'no-baseline': '暂无比较版本',
      timeout: '比较超时'
    })[reason],
    addedCount: (count: number) => `新增 ${count} 行`, deletedCount: (count: number) => `删除 ${count} 行`,
    comparedWith: (baseline: string) => `与${baseline}对比`,
    changesComparedWith: (summary: string, baseline: string) => `${summary} · 与${baseline}对比`,
    dismissNotification: '关闭通知',
    dismissNotificationButton: '关闭',
    commentSelectionBlocked: '选区包含已有注释或代码，请缩小选区后重试。',
    noticeInfoTitle: '状态',
    noticeWarningTitle: '需要处理',
    noticeErrorTitle: '编辑器问题',
    noticeLiveModeUnavailableTitle: '实时模式不可用',
    noticeEditorUpdateFailedTitle: '编辑器更新失败',
    noticeLiveRenderIssueTitle: '实时渲染暂时中断',
    noticeEditorLoadFailedTitle: '编辑器加载失败',
    noticeDocumentSyncFailedTitle: '文档同步失败',
    noticeExternalConflictTitle: '检测到外部修改',
    noticeReloadDiskFailedTitle: '磁盘重新加载失败',
    noticeExternalFileModifiedTitle: '磁盘文件已修改',
    noticeExternalFileDeletedTitle: '磁盘文件已删除',
    noticeExternalFileUnreadableTitle: '无法核验磁盘版本',
    noticePasteImageFailedTitle: '图片粘贴失败',
    retryLiveMode: '重试',
    retryDocumentUpdate: '重试更新',
    retryDocumentUpdateFailed: '重试后仍无法显示最新内容。',
    retryImagePaste: '重试粘贴',
    retryImagePasteFailed: '仍无法插入图片。',
    restartEditor: '重启编辑器',
    saveCopy: '另存副本',
    noticeActionFailed: '操作失败：',
    switchToSourceMode: '切换到源码',
    liveModeFailure: '实时模式无法渲染此文档，已切换到源码模式。',
    editorUpdateFailure: '编辑器无法显示最新文档内容，请重试更新。',
    transientUpdateFailure: '实时模式更新时遇到临时渲染错误，请重试。',
    transientModeFailure: '实时模式遇到临时渲染错误，将保持当前模式；请重试。',
    transientLoadFailure: '实时模式加载时遇到临时渲染错误，请重新打开文件或切换模式。',
    pasteImageFailure: (message: string) => `无法粘贴图片：${message}`,
    properties: 'Properties',
    resyncFailureNotice: '无法重新同步文档，已保留本地编辑，可另存副本保全内容。',
    externalConflictNotice: '文档发生外部变化时，本地编辑尚未应用完成。当前编辑已保留，可先另存副本。',
    reloadDiskFailureNotice: '无法从磁盘重新加载最新版本，已保留本地编辑，可另存副本保全内容。',
    externalFileModifiedNotice: '磁盘文件已被外部修改。未保存的编辑已保留，可先另存副本再决定如何处理。',
    externalFileDeletedNotice: '磁盘文件已被外部删除。未保存的编辑已保留，可另存副本保全内容。',
    externalFileUnreadableNotice: '无法读取磁盘版本。未保存的编辑仍在编辑器中，可另存副本以保全内容。'
  })
});

export function getUiStrings(language: UiLanguage): UiStrings {
  return CATALOG[language];
}
