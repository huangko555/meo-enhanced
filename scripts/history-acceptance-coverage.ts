import { editorCommandIds, type EditorCommandId } from '../src/foundation/editingPreferences';

type Acceptance = { commands: readonly EditorCommandId[]; effect: 'edit' | 'contextual' | 'neutral' | 'replay' | 'persistence';
  tests: readonly string[]; rule: string };

/** Coverage routing is deliberately separate from runtime evidence. A new
 * command must choose its history semantics and owning behavioral suites. */
export const historyAcceptance: readonly Acceptance[] = [
  { commands: ['save', 'saveAs'], effect: 'persistence', tests: ['test-native-save-table-flush.ts', 'test-document-save-flush-protocol.ts'],
    rule: 'Commit pending input before persistence; saving itself adds no document history entry.' },
  { commands: ['undo', 'redo'], effect: 'replay', tests: ['test-editor-history-runtime.ts', 'test-history-matrix.ts'],
    rule: 'Replay the shared document history and restore the current semantic interaction, without creating another entry.' },
  { commands: ['find', 'all', 'selection', 'home', 'expandSelection', 'shrinkSelection', 'nextOccurrence', 'skipOccurrence', 'addCursor', 'splitCursors', 'mode', 'preview', 'escape', 'tableNav'],
    effect: 'neutral', tests: ['test-editing-features-production.ts', 'test-preview-shortcuts-production.ts', 'test-mode-selection-continuity.ts'],
    rule: 'Navigation, selection and view changes do not edit the document or add a document undo step; commit pre-existing input separately.' },
  { commands: ['copy', 'copyMarkdown', 'copyCsv'], effect: 'neutral', tests: ['test-table-clipboard-production.ts', 'test-editing-features-production.ts'],
    rule: 'Copy retains document text and history; native clipboard delivery has its separate acceptance boundary.' },
  { commands: ['cut', 'paste', 'plain'], effect: 'edit', tests: ['test-editing-features-production.ts', 'test-mixed-html-paste-production.ts', 'test-table-clipboard-production.ts'],
    rule: 'One accepted edit restores exact text, selection and focus through undo/redo, including pending native input.' },
  { commands: ['replace'], effect: 'contextual', tests: ['test-search-replace-production.ts'],
    rule: 'Opening search is neutral; each accepted replacement and replace-all must have a correct history boundary.' },
  { commands: ['bold', 'italic', 'inlineCode', 'strike', 'highlight', 'underline', 'kbd', 'link', 'wikiLink'], effect: 'edit',
    tests: ['test-command-history-production.ts', 'test-basic-capability-production-matrix.ts'],
    rule: 'Every format case inherits complete before/undo/redo interaction checks in both modes and document scales.' },
  { commands: ['image', 'inlineMath', 'blockMath', 'formatHtml'], effect: 'edit',
    tests: ['test-editing-features-production.ts', 'test-history-matrix.ts', 'test-rendered-content-history-roundtrip.ts'],
    rule: 'Restore source edits and the rendered/source focus owner; late rendering must not override newer navigation.' },
  { commands: ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingUp', 'headingDown', 'bullet', 'ordered', 'taskList', 'taskDone', 'quote', 'codeBlock', 'rule', 'indent'],
    effect: 'edit', tests: ['test-editing-features-production.ts', 'test-live-command-presentation.ts', 'test-list-layout-interaction.ts'],
    rule: 'Preserve command provenance, valid selection and marker presentation; history targets the operation, not a diff union endpoint.' },
  { commands: ['insertTable', 'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight', 'convert'],
    effect: 'edit', tests: ['test-live-command-presentation.ts', 'test-table-history.ts', 'test-table-clipboard-production.ts', 'test-editing-features-production.ts'],
    rule: 'All production table commands run both history directions; native cell identity, selection and semantic source row have an explicit owner.' },
  { commands: ['lineComment', 'selectionComment', 'moveUp', 'moveDown', 'copyUp', 'copyDown', 'deleteLine', 'blankAbove', 'blankBelow'], effect: 'edit',
    tests: ['test-editing-features-production.ts', 'test-html-comment-input-production.ts'],
    rule: 'Structural edits and comments keep one history group and restore directed or multiple selections.' },
  { commands: ['enter', 'tab', 'delete'], effect: 'contextual',
    tests: ['test-input-assistance-production.ts', 'test-live-command-presentation.ts', 'test-table-history.ts'],
    rule: 'Text/list/cell input is undoable; keyboard control activation and focus navigation must not become document edits.' }
];

export function inspectHistoryAcceptance(commands: readonly string[] = editorCommandIds, entries: readonly Acceptance[] = historyAcceptance): string[] {
  const failures: string[] = [], seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.tests.length || !entry.rule.trim()) failures.push('History acceptance requires owning tests and explicit semantics');
    for (const command of entry.commands) {
      if (!commands.includes(command)) failures.push(`Unknown history command: ${command}`);
      if (seen.has(command)) failures.push(`Duplicate history command: ${command}`);
      seen.add(command);
    }
  }
  for (const command of commands) if (!seen.has(command)) failures.push(`Missing history acceptance: ${command}`);
  return failures;
}
