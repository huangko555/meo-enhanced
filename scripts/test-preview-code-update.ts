import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import type { createPreviewController } from '../webview/src/helpers/preview';

type Harness = Window & {
  __previewController: ReturnType<typeof createPreviewController>;
  __previewMessages: Array<{ type: string; requestId: string }>;
  __previewRenderedAt?: number;
  __releaseLanguage: (language: string) => void;
  __waitingLanguages: Set<string>;
  __fullParses: number;
  __parsedMain?: WeakRef<Element>;
  __retainedCodeRuns: Element[];
};

// Hold only the external grammar loader. Production token scheduling, Preview
// rendering, revision guards and DOM projection all run unchanged.
const fakeCore = `
  const releases = new Map();
  const released = new Set();
  globalThis.__waitingLanguages = new Set();
  globalThis.__releaseLanguage = name => {
    released.add(name);
    releases.get(name)?.forEach(resolve => resolve());
    releases.delete(name);
  };
  export function createHighlighterCore() {
    return {
      async loadLanguage(grammar) {
        if (!['python', 'sql'].includes(grammar.name) || released.has(grammar.name)) return;
        globalThis.__waitingLanguages.add(grammar.name);
        await new Promise(resolve => {
          const pending = releases.get(grammar.name) ?? [];
          pending.push(resolve);
          releases.set(grammar.name, pending);
        });
      },
      codeToTokens(code, options) {
        let offset = 0;
        return { tokens: code.split('\\n').map(content => {
          const syntaxToken = { content, offset, color: options.lang === 'javascript' ? '#11aa55' : content.includes('old') ? '#2244aa' : '#aa4422', fontStyle: 0 };
          offset += content.length + 1;
          return [syntaxToken];
        }) };
      },
      dispose() {}
    };
  }
`;
const build = await Bun.build({
  entrypoints: ['scripts/test-preview-code-update-entry.ts'],
  target: 'browser', format: 'iife',
  plugins: [{ name: 'preview-code-grammar-gate', setup(builder) {
    for (const module of ['core', 'engine/oniguruma', 'wasm']) {
      builder.onResolve({ filter: new RegExp(`^shiki/${module}$`) }, () => ({
        path: module, namespace: 'preview-code-test'
      }));
    }
    builder.onLoad({ filter: /.*/, namespace: 'preview-code-test' }, ({ path }) => ({
      loader: 'js', contents: path === 'core' ? fakeCore : path === 'wasm'
        ? 'export default {};'
        : 'export async function createOnigurumaEngine() { return {}; }'
    }));
    builder.onResolve({ filter: /^@shikijs\/langs\// }, ({ path }) => ({
      path: path.slice('@shikijs/langs/'.length), namespace: 'preview-code-language-test'
    }));
    builder.onLoad({ filter: /.*/, namespace: 'preview-code-language-test' }, ({ path }) => ({
      loader: 'js', contents: `export default { name: ${JSON.stringify(path)} };`
    }));
  } }]
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  for (const scenario of ['staggered', 'superseded', 'removed', 'hidden', 'theme', 'disabled', 'disposed']) {
    const page = await browser.newPage();
    const waitFor = async (predicate: () => unknown) => {
      try { await page.waitForFunction(predicate); }
      catch (error) {
        const state = await page.evaluate(() => {
          const scope = window as Harness;
          const doc = scope.__previewController.host.querySelector('iframe')?.contentDocument;
          return { rendered: scope.__previewRenderedAt, waiting: [...(scope.__waitingLanguages ?? [])],
            sources: Array.from(doc?.querySelectorAll('.meo-export-code-line-source') ?? []).map(source => source.outerHTML),
            requests: scope.__previewMessages.length, body: doc?.body.textContent?.slice(0,300) };
        });
        throw new Error(scenario + ': ' + JSON.stringify(state), { cause: error });
      }
    };
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 900, height: 760 });
    await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}</style><body></body>');
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    await page.evaluate(() => { const controller = (window as Harness).__previewController; controller.setAppearance('dark'); controller.setVisible(true); });
    const render = async (text: string) => {
      const value = exportRuntime.renderPreviewDocument({ markdownText: text,
        sourceDocumentPath: 'C:/preview-code-update.md', uiLanguage: 'en' });
      await page.evaluate(({ text, value }) => {
        const scope = window as Harness;
        void scope.__previewController.requestRender(text, { preserveViewport: true });
        const message = scope.__previewMessages.filter(message => message.type === 'requestPreviewRender').at(-1)!;
        scope.__previewController.acceptRenderResponse({ type: 'previewRenderResult',
          requestId: message.requestId, result: { ok: true, value } });
      }, { text, value });
      return value;
    };
    const text = (revision: string, first = 'typescript', second = 'typescript') => [
      '# Stable heading', `${revision} revision`, 'Stable selected paragraph',
      `\`\`\`${first}\n${revision}_first = 1\n\`\`\``,
      `\`\`\`${second}\n${revision}_second = 2\n\`\`\``,
      '[Stable link](https://example.com)',
      ...Array.from({ length: 10 }, (_, index) => `Tail paragraph ${index}`)
    ].join('\n\n');
    await render(text('old'));
    await waitFor(() => {
      const scope = window as Harness;
      const doc = scope.__previewController.host.querySelector('iframe')?.contentDocument;
      return scope.__previewRenderedAt && doc?.querySelectorAll('[data-meo-shiki]').length === 2;
    });
    if (scenario === 'staggered') {
      await page.evaluate(() => {
        const scope = window as Harness;
        const doc = scope.__previewController.host.querySelector('iframe')!.contentDocument!;
        scope.__retainedCodeRuns = Array.from(doc.querySelectorAll('.meo-export-code-line-source > span'));
        const range = doc.createRange();
        range.selectNodeContents(scope.__retainedCodeRuns[0]);
        doc.defaultView!.getSelection()!.addRange(range);
      });
      const proseOnly = text('old').replace('old revision', 'prose-only revision\nsecond line');
      const prosePayload = await render(proseOnly);
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector('p')?.textContent?.includes('prose-only revision'));
      assert.equal(await page.evaluate(() => {
        const scope = window as Harness;
        const doc = scope.__previewController.host.querySelector('iframe')!.contentDocument!;
        const runs = Array.from(doc.querySelectorAll('.meo-export-code-line-source > span'));
        return runs.length === scope.__retainedCodeRuns.length
          && runs.every((run, index) => run === scope.__retainedCodeRuns[index]);
      }), true, 'Prose-only revisions must retain unchanged themed code DOM');
      const mappings = await page.evaluate(html => {
        const doc = (window as Harness).__previewController.host.querySelector('iframe')!.contentDocument!;
        const expected = doc.createElement('main');
        expected.innerHTML = html;
        const read = (root: ParentNode) => Array.from(root.querySelectorAll('[data-source-line], [data-source-end-line]'))
          .map(node => [node.getAttribute('data-source-line'), node.getAttribute('data-source-end-line')]);
        return { actual: read(doc.querySelector('main.meo-export-doc')!), expected: read(expected),
          selected: doc.defaultView!.getSelection()!.toString() };
      }, prosePayload.html);
      assert.deepEqual(mappings.actual, mappings.expected, 'Retained code must receive current source mappings');
      assert.equal(mappings.selected, 'old_first = 1', 'A prose update must preserve selection inside unchanged code');
      await render(text('old', 'javascript'));
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector<HTMLElement>('code.language-javascript .meo-export-code-line-source > span')
        ?.style.color === 'rgb(17, 170, 85)');
      await render(text('old'));
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector<HTMLElement>('code.language-typescript .meo-export-code-line-source > span')
        ?.style.color === 'rgb(34, 68, 170)');
      const themeVersion = await page.evaluate(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector<HTMLElement>('[data-meo-shiki]')!.dataset.meoShiki);
      await page.evaluate(() => (window as Harness).__previewController.setAppearance('light'));
      await page.waitForFunction(previous => {
        const doc = (window as Harness).__previewController.host.querySelector('iframe')!.contentDocument!;
        const lines = Array.from(doc.querySelectorAll<HTMLElement>('[data-meo-shiki]'));
        return lines.length === 2 && lines.every(line => line.dataset.meoShiki !== previous);
      }, {}, themeVersion);
      const lightVersion = await page.evaluate(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector<HTMLElement>('[data-meo-shiki]')!.dataset.meoShiki);
      await page.evaluate(() => (window as Harness).__previewController.setAppearance('dark'));
      await page.waitForFunction(previous => {
        const doc = (window as Harness).__previewController.host.querySelector('iframe')!.contentDocument!;
        const lines = Array.from(doc.querySelectorAll<HTMLElement>('[data-meo-shiki]'));
        return lines.length === 2 && lines.every(line => line.dataset.meoShiki !== previous);
      }, {}, lightVersion);
      await render('```typescript\nalpha\n\n    beta\n```\n\n    alpha\n\n        beta');
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelectorAll('[data-meo-shiki]').length === 3);
      const assertCodeSelection = async () => {
        const selections = await page.evaluate(() => {
          const doc = (window as Harness).__previewController.host.querySelector('iframe')!.contentDocument!;
          return Array.from(doc.querySelectorAll('pre.meo-export-code-block code')).map(code => {
            const range = doc.createRange();
            range.selectNodeContents(code);
            const selection = doc.defaultView!.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            const text = selection.toString().trimEnd();
            selection.removeAllRanges();
            return text;
          });
        });
        assert.deepEqual(selections, ['alpha\n\n    beta', 'alpha\n\n    beta'],
          'Indented and highlighted fenced code must retain blank lines without copying line numbers');
      };
      await assertCodeSelection();
      const blankThemeVersion = await page.evaluate(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector<HTMLElement>('[data-meo-shiki]')!.dataset.meoShiki);
      await page.evaluate(() => (window as Harness).__previewController.setAppearance('light'));
      await page.waitForFunction(previous => {
        const doc = (window as Harness).__previewController.host.querySelector('iframe')!.contentDocument!;
        const lines = Array.from(doc.querySelectorAll<HTMLElement>('[data-meo-shiki]'));
        return lines.length === 3 && lines.every(line => line.dataset.meoShiki !== previous);
      }, {}, blankThemeVersion);
      await assertCodeSelection();
      await page.evaluate(() => (window as Harness).__previewController.setAppearance('dark'));
      await render(text('old'));
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelectorAll('[data-meo-shiki]').length === 2);
    }
    await page.evaluate(() => {
      const scope = window as Harness;
      const frame = scope.__previewController.host.querySelector('iframe')!;
      const realm = frame.contentWindow as unknown as { Element: typeof Element };
      const descriptor = Object.getOwnPropertyDescriptor(realm.Element.prototype, 'innerHTML')!;
      scope.__fullParses = 0;
      Object.defineProperty(realm.Element.prototype, 'innerHTML', { ...descriptor, set(value: string) {
        if (this.matches('main.meo-export-doc')) { scope.__fullParses += 1; scope.__parsedMain = new WeakRef(this); }
        descriptor.set!.call(this, value);
      } });
      const paragraph = frame.contentDocument!.querySelectorAll('p')[1]!;
      const range = frame.contentDocument!.createRange();
      range.selectNodeContents(paragraph);
      frame.contentWindow!.getSelection()!.removeAllRanges();
      frame.contentWindow!.getSelection()!.addRange(range);
    });
    await render(text('new', 'python', 'sql'));
    await waitFor(() => (window as Harness).__waitingLanguages.size === 2);
    const read = () => page.evaluate(() => {
      const scope = window as Harness;
      const doc = scope.__previewController.host.querySelector('iframe')!.contentDocument!;
      return { prose: doc.querySelector('p')?.textContent,
        sources: Array.from(doc.querySelectorAll<HTMLElement>('.meo-export-code-line-source')).map(source => ({
          text: source.textContent, color: source.querySelector<HTMLElement>('span[style]')?.style.color
        })), parses: scope.__fullParses,
        selected: scope.__previewController.getSelectedText(),
        mappings: Array.from(doc.querySelectorAll('.meo-export-code-block-wrap')).map(block => block.getAttribute('data-source-line')) };
    });
    const pending = await read();
    assert.equal(pending.prose, 'new revision', `${scenario}: unrelated prose must not wait for code tokens`);
    assert.deepEqual(pending.sources.map(source => source.text), ['old_first = 1', 'old_second = 2'], scenario + ': ' + JSON.stringify(pending));
    assert.ok(pending.sources.every(source => source.color === 'rgb(34, 68, 170)'));
    assert.equal(pending.parses, 1);
    if (scenario === 'staggered') {
      const session = await page.createCDPSession();
      await session.send('HeapProfiler.collectGarbage');
      assert.equal(await page.evaluate(() => (window as Harness).__parsedMain?.deref() === undefined), true,
        'Waiting code blocks must not retain the parsed full-document tree');
      await session.detach();
    }
    const renderedBeforeAction = await page.evaluate(() => (window as Harness).__previewRenderedAt);
    if (scenario === 'superseded') await render(text('latest'));
    if (scenario === 'removed') await render('# Removed\n\nOnly prose remains.');
    if (scenario === 'hidden') await page.evaluate(() => (window as Harness).__previewController.setVisible(false));
    if (scenario === 'theme') await page.evaluate(() => (window as Harness).__previewController.setAppearance('light'));
    if (scenario === 'disabled') {
      await page.evaluate(() => (window as Harness).__previewController.setSourceColoring(false));
      await render(text('new', 'python', 'sql'));
    }
    if (scenario === 'disposed') await page.evaluate(() => (window as Harness).__previewController.dispose());
    await page.evaluate(() => (window as Harness).__releaseLanguage('python'));
    if (scenario === 'staggered' || scenario === 'hidden') {
      await waitFor(() => (window as Harness).__previewController.host.querySelector('iframe')!
        .contentDocument!.querySelector('.meo-export-code-line-source')?.textContent === 'new_first = 1');
      const intermediate = await read();
      assert.deepEqual(intermediate.sources.map(source => source.text), ['new_first = 1', 'old_second = 2']);
      assert.deepEqual(intermediate.sources.map(source => source.color), ['rgb(170, 68, 34)', 'rgb(34, 68, 170)']);
      assert.equal(intermediate.parses, 1, 'Token refresh must not parse the whole document again');
    }
    await page.evaluate(() => (window as Harness).__releaseLanguage('sql'));
    await page.evaluate(async () => {
      for (let index = 0; index < 12; index += 1) await new Promise(requestAnimationFrame);
    });
    if (scenario !== 'disposed') {
      if (scenario === 'hidden') await page.evaluate(() => (window as Harness).__previewController.setVisible(true));
      const final = await read();
      const expected = scenario === 'superseded' ? 'latest' : 'new';
      assert.deepEqual(final.sources.map(source => source.text), scenario === 'removed' ? []
        : [`${expected}_first = 1`, `${expected}_second = 2`], scenario + ': ' + JSON.stringify(final));
      if (scenario !== 'removed' && scenario !== 'disabled') {
        assert.ok(final.sources.every(source => source.color === 'rgb(170, 68, 34)'));
      }
      assert.equal(final.parses, ['superseded', 'removed', 'disabled'].includes(scenario) ? 2 : 1);
      if (scenario === 'staggered') {
        assert.equal(final.selected, 'Stable selected paragraph');
        assert.deepEqual(final.mappings, pending.mappings);
      }
      await page.evaluate(() => (window as Harness).__previewController.dispose());
    }
    if (scenario === 'disposed') {
      assert.equal(await page.evaluate(() => (window as Harness).__previewRenderedAt), renderedBeforeAction,
        'Disposed Preview must ignore late token completions');
      assert.equal(await page.evaluate(() => (window as Harness).__fullParses), 1);
    }
    assert.deepEqual(errors, [], scenario);
    await page.close();
  }
  console.log('Preview pending-code partial commit, staggered completion, revisions, visibility, theme, coloring and disposal checks passed');
} catch (error) { primaryError = error; }
finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}