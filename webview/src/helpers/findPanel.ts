import { createElement, CaseSensitive, ChevronUp, ChevronDown, Replace, ReplaceAll, WholeWord, X } from 'lucide';
import { getUiStrings, type UiLanguage, type UiStrings } from '../application/uiLanguage';

export interface FindPanelElements {
  panel: HTMLDivElement;
  findInput: HTMLInputElement;
  findClearBtn: HTMLButtonElement;
  wholeWordBtn: HTMLButtonElement;
  caseSensitiveBtn: HTMLButtonElement;
  replaceInput: HTMLInputElement;
  replaceClearBtn: HTMLButtonElement;
  findStatus: HTMLSpanElement;
  findPrevBtn: HTMLButtonElement;
  findNextBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  replaceBtn: HTMLButtonElement;
  replaceAllBtn: HTMLButtonElement;
  toggleBtn: HTMLButtonElement;
  applyUiStrings: (strings: UiStrings) => void;
}

export interface FindPanelContext {
  getEditor: () => any;
  isVisible: () => boolean;
}

export const createFindPanel = (toggleBtn: HTMLButtonElement, uiLanguage: UiLanguage): FindPanelElements => {
  const uiStrings = getUiStrings(uiLanguage);
  const panel = document.createElement('div');
  panel.className = 'find-panel';
  panel.setAttribute('role', 'search');
  panel.setAttribute('aria-label', uiStrings.findAndReplacePanel);

  const findRow = document.createElement('div');
  findRow.className = 'find-row';

  const findInputWrap = document.createElement('div');
  findInputWrap.className = 'find-input-wrap find-input-wrap-with-status';

  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.className = 'find-input';
  findInput.placeholder = uiStrings.find;
  findInput.setAttribute('aria-label', uiStrings.find);

  const findStatus = document.createElement('span');
  findStatus.className = 'find-status';

  const findClearBtn = document.createElement('button');
  findClearBtn.type = 'button';
  findClearBtn.className = 'format-button find-clear-button';
  findClearBtn.title = uiStrings.clearFind;
  findClearBtn.setAttribute('aria-label', uiStrings.clearFind);
  findClearBtn.appendChild(createElement(X, { width: 16, height: 16 }));

  const wholeWordBtn = document.createElement('button');
  wholeWordBtn.type = 'button';
  wholeWordBtn.className = 'format-button toggle-button find-option-button';
  wholeWordBtn.title = uiStrings.wholeWord;
  wholeWordBtn.appendChild(createElement(WholeWord, { width: 16, height: 16 }));
  wholeWordBtn.setAttribute('aria-label', uiStrings.wholeWord);
  wholeWordBtn.setAttribute('aria-pressed', 'false');

  const caseSensitiveBtn = document.createElement('button');
  caseSensitiveBtn.type = 'button';
  caseSensitiveBtn.className = 'format-button toggle-button find-option-button';
  caseSensitiveBtn.title = uiStrings.caseSensitive;
  caseSensitiveBtn.appendChild(createElement(CaseSensitive, { width: 16, height: 16 }));
  caseSensitiveBtn.setAttribute('aria-label', uiStrings.caseSensitive);
  caseSensitiveBtn.setAttribute('aria-pressed', 'false');

  const findPrevBtn = document.createElement('button');
  findPrevBtn.type = 'button';
  findPrevBtn.className = 'format-button';
  findPrevBtn.title = uiStrings.previousMatch;
  findPrevBtn.appendChild(createElement(ChevronUp, { width: 16, height: 16 }));

  const findNextBtn = document.createElement('button');
  findNextBtn.type = 'button';
  findNextBtn.className = 'format-button';
  findNextBtn.title = uiStrings.nextMatch;
  findNextBtn.appendChild(createElement(ChevronDown, { width: 16, height: 16 }));

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'format-button find-close-button';
  closeBtn.title = uiStrings.closeFind;
  closeBtn.setAttribute('aria-label', uiStrings.closeFind);
  closeBtn.appendChild(createElement(X, { width: 16, height: 16 }));

  findInputWrap.append(findInput, findStatus, findClearBtn);
  findRow.append(findInputWrap, wholeWordBtn, caseSensitiveBtn, findPrevBtn, findNextBtn);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'find-row find-replace-row';

  const replaceInputWrap = document.createElement('div');
  replaceInputWrap.className = 'find-input-wrap';

  const replaceInput = document.createElement('input');
  replaceInput.type = 'text';
  replaceInput.className = 'find-input';
  replaceInput.placeholder = uiStrings.replace;
  replaceInput.setAttribute('aria-label', uiStrings.replace);

  const replaceClearBtn = document.createElement('button');
  replaceClearBtn.type = 'button';
  replaceClearBtn.className = 'format-button find-clear-button';
  replaceClearBtn.title = uiStrings.clearReplace;
  replaceClearBtn.setAttribute('aria-label', uiStrings.clearReplace);
  replaceClearBtn.appendChild(createElement(X, { width: 16, height: 16 }));

  replaceInputWrap.append(replaceInput, replaceClearBtn);

  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'format-button';
  replaceBtn.title = uiStrings.replaceCurrentMatch;
  replaceBtn.appendChild(createElement(Replace, { width: 16, height: 16 }));

  const replaceAllBtn = document.createElement('button');
  replaceAllBtn.type = 'button';
  replaceAllBtn.className = 'format-button';
  replaceAllBtn.title = uiStrings.replaceAllMatches;
  replaceAllBtn.appendChild(createElement(ReplaceAll, { width: 16, height: 16 }));

  const closeSpacer = document.createElement('span');
  closeSpacer.className = 'find-button-spacer';
  closeSpacer.setAttribute('aria-hidden', 'true');

  replaceRow.append(replaceInputWrap, replaceBtn, replaceAllBtn, closeSpacer, closeBtn);
  panel.append(findRow, replaceRow);

  const applyUiStrings = (strings: UiStrings): void => {
    panel.setAttribute('aria-label', strings.findAndReplacePanel);
    findInput.placeholder = strings.find;
    findInput.setAttribute('aria-label', strings.find);
    findClearBtn.title = strings.clearFind;
    findClearBtn.setAttribute('aria-label', strings.clearFind);
    wholeWordBtn.title = strings.wholeWord;
    wholeWordBtn.setAttribute('aria-label', strings.wholeWord);
    caseSensitiveBtn.title = strings.caseSensitive;
    caseSensitiveBtn.setAttribute('aria-label', strings.caseSensitive);
    findPrevBtn.title = strings.previousMatch;
    findNextBtn.title = strings.nextMatch;
    closeBtn.title = strings.closeFind;
    closeBtn.setAttribute('aria-label', strings.closeFind);
    replaceInput.placeholder = strings.replace;
    replaceInput.setAttribute('aria-label', strings.replace);
    replaceClearBtn.title = strings.clearReplace;
    replaceClearBtn.setAttribute('aria-label', strings.clearReplace);
    replaceBtn.title = strings.replaceCurrentMatch;
    replaceAllBtn.title = strings.replaceAllMatches;
  };

  return {
    panel,
    findInput,
    findClearBtn,
    wholeWordBtn,
    caseSensitiveBtn,
    replaceInput,
    replaceClearBtn,
    findStatus,
    findPrevBtn,
    findNextBtn,
    closeBtn,
    replaceBtn,
    replaceAllBtn,
    toggleBtn,
    applyUiStrings
  };
};

export const createFindPanelController = (
  elements: FindPanelElements,
  getEditor: () => any,
  toolbar: HTMLElement,
  modeGroup: HTMLElement,
  getSelectedSurfaceText: (() => string) | undefined,
  initialUiLanguage: UiLanguage
) => {
  let uiStrings = getUiStrings(initialUiLanguage);
  let visible = false;

  const isWholeWordEnabled = (): boolean => {
    return elements.wholeWordBtn.classList.contains('is-active');
  };

  const setWholeWordEnabled = (enabled: boolean): void => {
    elements.wholeWordBtn.classList.toggle('is-active', enabled);
    elements.wholeWordBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  };

  const isCaseSensitiveEnabled = (): boolean => {
    return elements.caseSensitiveBtn.classList.contains('is-active');
  };

  const setCaseSensitiveEnabled = (enabled: boolean): void => {
    elements.caseSensitiveBtn.classList.toggle('is-active', enabled);
    elements.caseSensitiveBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  };

  const getSearchOptions = (): { wholeWord: boolean; caseSensitive: boolean } => {
    return {
      wholeWord: isWholeWordEnabled(),
      caseSensitive: isCaseSensitiveEnabled()
    };
  };

  const setSearchOptions = (
    options: { wholeWord?: boolean; caseSensitive?: boolean } = {}
  ): void => {
    setWholeWordEnabled(options.wholeWord === true);
    setCaseSensitiveEnabled(options.caseSensitive === true);
  };

  const setFindStatus = (text: string, isError = false): void => {
    elements.findStatus.textContent = text;
    elements.findStatus.classList.toggle('is-error', isError);
  };

  const updateFindPanelAnchor = (): void => {
    const toolbarRect = toolbar.getBoundingClientRect();
    const modeGroupRect = modeGroup.getBoundingClientRect();
    const rightOffset = Math.max(0, toolbarRect.right - modeGroupRect.right);
    elements.panel.style.right = `${rightOffset}px`;
  };

  const updateFindStatusSummary = (): void => {
    const editor = getEditor();
    if (!editor || !visible) {
      return;
    }

    const query = elements.findInput.value;
    const searchOptions = getSearchOptions();
    editor.setSearchQuery(query, searchOptions);
    if (!query) {
      setFindStatus('');
      return;
    }

    const total = editor.countMatches(query, searchOptions);
    if (!total) {
      setFindStatus(uiStrings.noMatches, true);
      return;
    }
    setFindStatus(uiStrings.findMatches(total));
  };

  const close = (): void => {
    visible = false;
    elements.panel.classList.remove('is-visible');
    elements.toggleBtn.classList.remove('is-active');
    elements.findInput.value = '';
    elements.replaceInput.value = '';
    setFindStatus('');
    const editor = getEditor();
    if (editor) {
      editor.setSearchQuery('', getSearchOptions());
      editor.focus();
    }
  };

  const getSelectedEditorText = (): string => {
    const surfaceText = getSelectedSurfaceText?.() ?? '';
    if (surfaceText) {
      return surfaceText;
    }
    const editor = getEditor();
    const state = editor?.view?.state;
    const selection = state?.selection?.main;
    if (!selection || selection.empty) {
      return '';
    }
    return state.doc.sliceString(Math.min(selection.from, selection.to), Math.max(selection.from, selection.to));
  };

  const open = (target: 'find' | 'replace' = 'find'): void => {
    const wasVisible = visible;
    updateFindPanelAnchor();
    visible = true;
    elements.panel.classList.add('is-visible');
    elements.toggleBtn.classList.add('is-active');
    const selectedText = wasVisible ? '' : getSelectedEditorText();
    if (selectedText) {
      elements.findInput.value = selectedText;
    }
    const editor = getEditor();
    if (editor) {
      editor.setSearchQuery(elements.findInput.value, getSearchOptions());
    }
    updateFindStatusSummary();
    const input = target === 'replace' ? elements.replaceInput : elements.findInput;
    input.focus();
    input.select();
  };

  const applyFindResult = (result: { found?: boolean; current?: number; total?: number } | null): boolean => {
    if (!result?.found) {
      setFindStatus(uiStrings.noMatches, true);
      return false;
    }
    setFindStatus(`${result.current}/${result.total}`);
    return true;
  };

  const runFind = (backward = false, options: Record<string, unknown> = {}): boolean => {
    const editor = getEditor();
    if (!editor) {
      return false;
    }

    const query = elements.findInput.value;
    if (!query) {
      setFindStatus(uiStrings.enterText, true);
      return false;
    }

    const searchOptions = { ...options, ...getSearchOptions() };
    const result = backward ? editor.findPrevious(query, searchOptions) : editor.findNext(query, searchOptions);
    return applyFindResult(result);
  };

  const runReplace = (): boolean => {
    const editor = getEditor();
    if (!editor) {
      return false;
    }

    const query = elements.findInput.value;
    if (!query) {
      setFindStatus(uiStrings.enterText, true);
      return false;
    }

    const result = editor.replaceCurrent(query, elements.replaceInput.value, getSearchOptions());
    if (!result.replaced) {
      return applyFindResult(result);
    }

    if (result.found) {
      setFindStatus(uiStrings.replacedCurrent(result.current ?? 0, result.total ?? 0));
      return true;
    }

    setFindStatus(result.total ? uiStrings.replacedRemaining(result.total) : uiStrings.replaced);
    return true;
  };

  const runReplaceAll = (): boolean => {
    const editor = getEditor();
    if (!editor) {
      return false;
    }

    const query = elements.findInput.value;
    if (!query) {
      setFindStatus(uiStrings.enterText, true);
      return false;
    }

    const result = editor.replaceAll(query, elements.replaceInput.value, getSearchOptions());
    if (!result.replaced) {
      setFindStatus(uiStrings.noMatches, true);
      return false;
    }

    setFindStatus(uiStrings.replacedMatches(result.replaced));
    return true;
  };

  const clearFind = (): void => {
    elements.findInput.value = '';
    updateFindStatusSummary();
    elements.findInput.focus();
  };

  const clearReplace = (): void => {
    elements.replaceInput.value = '';
    elements.replaceInput.focus();
  };

  const isVisible = () => visible;

  const updateAnchor = () => {
    if (visible) {
      updateFindPanelAnchor();
    }
  };

  const toggleWholeWord = (): void => {
    setWholeWordEnabled(!isWholeWordEnabled());
    if (visible) {
      updateFindStatusSummary();
    }
  };

  const toggleCaseSensitive = (): void => {
    setCaseSensitiveEnabled(!isCaseSensitiveEnabled());
    if (visible) {
      updateFindStatusSummary();
    }
  };

  return {
    open,
    close,
    isVisible,
    getSearchOptions,
    setSearchOptions,
    updateAnchor,
    updateFindStatusSummary,
    setUiLanguage(language: UiLanguage) {
      uiStrings = getUiStrings(language);
      elements.applyUiStrings(uiStrings);
      updateFindStatusSummary();
    },
    toggleWholeWord,
    toggleCaseSensitive,
    runFind,
    runReplace,
    runReplaceAll,
    clearFind,
    clearReplace,
    elements
  };
};

export type FindPanelController = ReturnType<typeof createFindPanelController>;
