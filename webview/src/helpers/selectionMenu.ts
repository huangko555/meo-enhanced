import { createElement, Bold, Italic, Strikethrough, Highlighter, Terminal, Link, Brackets, Keyboard, Underline } from 'lucide';
import { getUiStrings, type UiLanguage } from '../../../src/foundation/uiLanguage';

export interface SelectionMenuElements {
  menu: HTMLDivElement;
  setUiLanguage(language: UiLanguage): void;
};

export type SelectionMenuState = {
  visible?: boolean;
  anchorX?: number;
  anchorY?: number;
  anchorBottomY?: number;
  align?: 'center' | 'start';
};

const createSelectionActionButton = (action: string, label: string, Icon: any): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'selection-inline-button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createElement(Icon, { width: 16, height: 16 }));
  return button;
};

export const createSelectionMenu = (): SelectionMenuElements => {
  const menu = document.createElement('div');
  menu.className = 'selection-inline-menu';
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', 'Inline markdown formatting');

  const selectionBoldBtn = createSelectionActionButton('bold', 'Bold', Bold);
  const selectionItalicBtn = createSelectionActionButton('italic', 'Italic', Italic);
  const selectionLineoverBtn = createSelectionActionButton('lineover', 'Lineover', Strikethrough);
  const selectionHighlightBtn = createSelectionActionButton('highlight', 'Highlight', Highlighter);
  const selectionInlineCodeBtn = createSelectionActionButton('inlineCode', 'Inline Code', Terminal);
  const selectionLinkBtn = createSelectionActionButton('link', 'Link', Link);
  const selectionWikiLinkBtn = createSelectionActionButton('wikiLink', 'Wiki Link', Brackets);
  const selectionKbdBtn = createSelectionActionButton('kbd', 'Kbd', Keyboard);
  const selectionUnderlineBtn = createSelectionActionButton('underline', 'Underline', Underline);
  menu.append(
    selectionBoldBtn,
    selectionItalicBtn,
    selectionLineoverBtn,
    selectionHighlightBtn,
    selectionInlineCodeBtn,
    selectionLinkBtn,
    selectionWikiLinkBtn,
    selectionKbdBtn,
    selectionUnderlineBtn
  );

  const setUiLanguage = (language: UiLanguage): void => {
    const strings = getUiStrings(language);
    menu.setAttribute('aria-label', strings.inlineMarkdownFormatting);
    const labels: Readonly<Record<string, string>> = {
      bold: strings.bold,
      italic: strings.italic,
      lineover: strings.lineover,
      highlight: strings.highlight,
      inlineCode: strings.inlineCode,
      link: strings.link,
      wikiLink: strings.wikiLink,
      kbd: strings.kbd,
      underline: strings.underline
    };
    for (const button of menu.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      const label = labels[button.dataset.action ?? ''];
      if (!label) continue;
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  };

  return { menu, setUiLanguage };
};

export const createSelectionMenuController = (
  elements: SelectionMenuElements,
  getEditor: () => any
) => {
  const hide = (): void => {
    elements.menu.classList.remove('is-visible');
    elements.menu.classList.remove('is-below');
  };

  const topToolbarBottom = (): number => {
    const toolbar = document.querySelector('.mode-toolbar');
    if (!(toolbar instanceof HTMLElement)) {
      return 0;
    }

    return toolbar.getBoundingClientRect().bottom;
  };

  const update = (selectionState: SelectionMenuState | null): void => {
    if (!selectionState?.visible) {
      hide();
      return;
    }

    elements.menu.classList.add('is-visible');
    const margin = 8;
    const menuWidth = elements.menu.offsetWidth;
    const anchorX = selectionState.anchorX ?? 0;
    const rawLeft = selectionState.align === 'center' ? anchorX - (menuWidth / 2) : anchorX;
    const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
    const clampedLeft = Math.min(maxLeft, Math.max(margin, rawLeft));
    const menuHeight = elements.menu.offsetHeight;
    const anchorY = selectionState.anchorY ?? margin;
    const anchorBottomY = selectionState.anchorBottomY ?? anchorY;
    const gap = margin;
    const aboveTop = anchorY - gap - menuHeight;
    const shouldPlaceBelow = aboveTop < topToolbarBottom() + gap;
    const rawTop = shouldPlaceBelow ? anchorBottomY + gap : anchorY - gap;
    elements.menu.style.left = `${clampedLeft}px`;
    elements.menu.style.top = `${Math.max(margin, rawTop)}px`;
    elements.menu.classList.toggle('is-below', shouldPlaceBelow);
  };

  const handleAction = (action: string): void => {
    const editor = getEditor();
    if (!editor) return;
    editor.insertFormat(action);
    editor.focus();
  };

  return {
    hide,
    update,
    handleAction,
    elements
  };
};

export type SelectionMenuController = ReturnType<typeof createSelectionMenuController>;
