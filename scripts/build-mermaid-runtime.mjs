import { cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** One lazy module graph works in Webviews and in directly opened HTML files. */
export async function buildMermaidRuntime(root, dist) {
  const directory = path.join(dist, 'mermaid');
  const build = await Bun.build({
    entrypoints: [path.join(root, 'webview/src/mermaidRuntime.ts')],
    target: 'browser', format: 'esm', splitting: true, minify: true,
    // The browser's native module prefetch would fetch the same dependencies
    // again when SystemJS requests them as classic scripts.
    modulePreload: false, outdir: directory,
    plugins: [{ name: 'mermaid-off-thread-elk', setup(builder) {
      builder.onResolve({ filter: /^elkjs\/lib\/elk\.bundled\.js$/ }, () => ({
        path: path.join(root, 'webview/src/adapters/mermaidElkLayout.ts')
      }));
    } }]
  });
  if (!build.success) throw new AggregateError(build.logs, 'Mermaid build failed');
  const minifier = new Bun.Transpiler({ loader: 'js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: true });
  const imports = new Map();
  for (const output of build.outputs) {
    const name = path.basename(output.path) === 'mermaidRuntime.js' ? 'core.js' : path.basename(output.path);
    const source = await output.text();
    const syntax = ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    imports.set(name, syntax.statements
      .filter(statement => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      .flatMap(statement => statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? [path.basename(statement.moduleSpecifier.text)] : []));
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.System, target: ts.ScriptTarget.ESNext, removeComments: true },
      fileName: name
    }).outputText;
    if (!code.startsWith('System.register(')) throw new Error(`Mermaid chunk is not a module: ${name}`);
    await Bun.write(path.join(directory, name), minifier.transformSync(
      code.replace('System.register(', 'globalThis.__meoMermaidSystem.register(')
    ));
  }
  const preloads = new Set();
  const collect = name => {
    if (preloads.has(name)) return;
    preloads.add(name);
    for (const dependency of imports.get(name) ?? []) collect(dependency);
  };
  collect('core.js');
  await Bun.write(path.join(directory, 'preload.json'), JSON.stringify([...preloads]));

  // A module exports the unchanged worker source as text. Classic script
  // loading also works under file://, where fetching a worker file is blocked.
  const worker = readFileSync(path.join(root, 'node_modules/elkjs/lib/elk-worker.min.js'), 'utf8');
  await Bun.write(path.join(directory, 'elk-worker-source.js'),
    `globalThis.__meoMermaidSystem.register([], function(exports) {
      return { execute() { exports('default', ${JSON.stringify(worker)}); } };
    });`);
  cpSync(path.join(root, 'node_modules/elkjs/LICENSE.md'), path.join(directory, 'elk-LICENSE.md'));

  const system = readFileSync(path.join(root, 'node_modules/systemjs/dist/system.min.js'), 'utf8')
    .replace(/\/\/# sourceMappingURL=.*$/m, '');
  const loader = `(() => {
    if (globalThis.__meoMermaidSystem) return;
    const previous = globalThis.System;
    ${system}
    const loader = globalThis.System;
    globalThis.System = previous;
    globalThis.__meoMermaidSystem = loader;
    // Evict failed dependency chains after their import settles. A transient
    // local-resource failure must not poison a later editor/export retry.
    const failed = new Set();
    loader.onload = (error, id) => { if (error) failed.add(id); };
    const importModule = loader.import;
    loader.import = function(...args) {
      return importModule.apply(this, args).then(module => new Promise(resolve => {
        // Preserve an input/paint opportunity at dynamic-import completion.
        // Immediate cached resolution merged rendering stages into a measured
        // 90ms foreground task; a posted task keeps those stages separate.
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close(); channel.port2.close(); resolve(module);
        };
        channel.port2.postMessage(null);
      }), error => {
        for (const id of failed) this.delete(id);
        failed.clear();
        throw error;
      });
    };
    // SystemJS calls the prototype hook internally, rather than an instance
    // property. Apply nonce/CORS policy there so preloads are also reusable.
    const prototype = Object.getPrototypeOf(loader);
    const createScript = prototype.createScript;
    prototype.createScript = function(url) {
      const script = createScript.call(this, url);
      if (url.startsWith('file:')) script.removeAttribute('crossorigin');
      else script.crossOrigin = 'anonymous';
      script.nonce = document.body?.dataset.meoScriptNonce ?? '';
      if (url.endsWith('/elk-worker-source.js')) {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          script.remove();
          script.dispatchEvent(new Event('error'));
        }, 5000);
        script.addEventListener('load', event => {
          // Removing an in-flight script does not cancel it in every browser.
          // A late load must not reach SystemJS's removeChild callback.
          if (timedOut) event.stopImmediatePropagation();
          clearTimeout(timer);
        }, { once: true });
        script.addEventListener('error', () => clearTimeout(timer), { once: true });
      }
      script.addEventListener('error', () => script.remove(), { once: true });
      return script;
    };
  })();`;
  await Bun.write(path.join(directory, 'loader.js'), minifier.transformSync(loader));
  await Bun.write(path.join(directory, 'mermaidRuntime.js'),
    `import './loader.js';
     const module = await globalThis.__meoMermaidSystem.import(new URL('./core.js', import.meta.url).href);
     export default module.default;`);
  await Bun.write(path.join(dist, 'mermaid.min.js'), minifier.transformSync(`(() => {
    const base = document.currentScript.src;
    globalThis.__MEO_MERMAID_READY__ = new Promise((resolve, reject) => {
      const load = () => globalThis.__meoMermaidSystem.import(new URL('./mermaid/core.js', base).href)
        .then(module => { globalThis.mermaid = module.default; resolve(module.default); }, reject);
      if (globalThis.__meoMermaidSystem) { load(); return; }
      const script = document.createElement('script');
      script.src = new URL('./mermaid/loader.js', base).href;
      script.nonce = document.body?.dataset.meoScriptNonce ?? '';
      script.onload = () => { script.remove(); load(); };
      script.onerror = () => { script.remove(); reject(new Error('Mermaid runtime failed to load')); };
      document.head.appendChild(script);
    });
    globalThis.__MEO_MERMAID_READY__.catch(() => {});
  })();`));
  console.log(`Built shared Mermaid runtime (${build.outputs.length} lazy modules, one ELK worker)`);
}
