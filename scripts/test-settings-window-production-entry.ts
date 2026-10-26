import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { syntaxParserRunning } from '@codemirror/language';
import { sourceSyntaxPreparation } from '../webview/src/helpers/sourceSyntax';
import { isLiveInputDerivedWorkPending, isLiveInputDerivedWorkReady, usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { changeEditingPreferences } from '../src/application/editingPreferences';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
(window as any).EditingSettingsHarness = { EditorView, changeEditingPreferences, defaultInputAssistance,
  syntaxParserRunning, sourceSyntaxPreparation, isLiveInputDerivedWorkPending,
  isLiveInputDerivedWorkReady, usesLargeDocumentDerivedWorkBudget };
