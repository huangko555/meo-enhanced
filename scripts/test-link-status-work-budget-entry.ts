import '../webview/src/index';
import * as local from '../webview/src/helpers/localLinks';
import * as wiki from '../webview/src/helpers/wikiLinks';

(window as any).__linkStatusBudget = { local, wiki };
