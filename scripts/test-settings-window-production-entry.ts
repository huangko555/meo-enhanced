import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { changeEditingPreferences } from '../src/application/editingPreferences';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
(window as any).EditingSettingsHarness = { EditorView, changeEditingPreferences, defaultInputAssistance };
