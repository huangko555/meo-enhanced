import { htmlLanguage } from '@codemirror/lang-html';
import { Prec, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { scanHtmlTags, splitHtmlBlockFragments } from '../../../src/foundation/htmlSyntax';

/** HTML assistance shares the main editor's document, selection and history. */
export function createHtmlSourceEditing(
  rangeAt: (state: EditorState) => { from: number; to: number } | null,
  tagNames: ReadonlySet<string>
) {
  return [
    Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing || view.state.readOnly || from !== to || view.state.selection.ranges.length !== 1
        || !htmlLanguage.isActiveAt(view.state, from, -1)) return false;
      const range = rangeAt(view.state);
      const start = range?.from ?? view.state.doc.lineAt(from).from;
      const before = view.state.doc.sliceString(start, from);
      if (text === '>') {
        const open = before.lastIndexOf('<');
        if (open < 0) return false;
        const source = before.slice(open) + '>';
        const [tag] = scanHtmlTags(source);
        if (!tag || tag.from !== 0 || tag.to !== source.length || tag.closing || tag.selfClosing || !tagNames.has(tag.name)) return false;
        const rest = view.state.doc.sliceString(from, range?.to ?? view.state.doc.length);
        if (splitHtmlBlockFragments(before + '>' + rest).some(fragment =>
          fragment.from <= open && fragment.to > before.length)) return false;
        view.dispatch({ changes: { from, insert: `></${tag.name}>` }, selection: { anchor: from + 1 },
          userEvent: 'input.type', scrollIntoView: true });
        return true;
      }
      if (text === '/' && before.endsWith('<')) {
        const stack: string[] = [];
        for (const tag of scanHtmlTags(before.slice(0, -1))) {
          if (tag.closing) { if (stack.at(-1) === tag.name) stack.pop(); }
          else if (!tag.selfClosing) stack.push(tag.name);
        }
        const name = stack.at(-1);
        if (!name || !tagNames.has(name)) return false;
        const insert = `/${name}>`;
        view.dispatch({ changes: { from, to: from + (view.state.doc.sliceString(from, from + 1) === '>' ? 1 : 0), insert },
          selection: { anchor: from + insert.length }, userEvent: 'input.type', scrollIntoView: true });
        return true;
      }
      return false;
    }))
  ];
}
