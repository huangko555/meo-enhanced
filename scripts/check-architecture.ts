import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

type Source = { path: string; text: string };
type Edge = { from: string; to: string; specifier: string };

const repoRoot = resolve(import.meta.dir, '..');
const staged = process.argv.includes('--staged');
const configPath = join(repoRoot, 'scripts', 'architecture-baseline.json');

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

const configText = staged
  ? runGit(['show', ':scripts/architecture-baseline.json'])
  : readFileSync(configPath, 'utf8');
const config = JSON.parse(configText) as {
  targetRoots: string[];
  bootstrapOnlyModules?: Array<{ module: string; allowedImporters: string[] }>;
  bootstrapLifecycleContracts?: Array<{
    file: string;
    constructors: Array<{ module: string; export: string }>;
    disposeOrder: string[];
  }>;
  resourceOwnerFreeModules?: string[];
  sharedModuleContracts?: Array<{
    module: string;
    exactImporters: string[];
    delegates: Array<{
      file: string;
      function: string;
      requiredCall: string;
      allowedMethodCalls?: string[];
      allowNullReturn?: boolean;
    }>;
  }>;
  knownLegacyTestFailures: { id: string; test: string; fingerprint: string }[];
};

function sourceFilesOnDisk(): string[] {
  const result: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(ts|tsx)$/.test(entry)) result.push(relative(repoRoot, full));
    }
  };
  for (const root of ['src', 'webview/src']) visit(join(repoRoot, root));
  return result;
}

function sourceFilesInIndex(): string[] {
  return runGit(['ls-files', '--cached'])
    .split(/\r?\n/)
    .filter((file) => /^(src|webview[\\/]src)[\\/].*\.(ts|tsx)$/.test(file));
}

function readSource(file: string): Source {
  const path = file.replaceAll('\\', '/');
  return { path, text: staged ? runGit(['show', `:${path}`]) : readFileSync(join(repoRoot, file), 'utf8') };
}

function resolveImport(from: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(from), specifier)).replaceAll('\\', '/');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function importsFor(source: Source): string[] {
  const file = sourceFileFor(source);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

function sourceFileFor(source: Source): ts.SourceFile {
  const scriptKind = extname(source.path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, scriptKind);
}

function targetLayer(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  for (const root of config.targetRoots) {
    const prefix = `${root}/`;
    if (normalized.startsWith(prefix)) return root.split('/').at(-1) ?? null;
  }
  return null;
}

function allowedTargetLayers(layer: string): Set<string> {
  return new Set({
    foundation: [],
    domain: ['foundation'],
    application: ['domain', 'foundation'],
    protocol: ['foundation'],
    host: ['application', 'protocol', 'foundation', 'host'],
    adapters: ['application', 'protocol', 'foundation', 'adapters'],
    bootstrap: ['application', 'protocol', 'foundation', 'host', 'adapters', 'bootstrap'],
    editor: ['application', 'protocol', 'foundation', 'adapters', 'editor'],
  }[layer] ?? []);
}

function isTarget(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return config.targetRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isLegacy(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('src/') || normalized.startsWith('webview/src/')
    ? !isTarget(normalized) : false;
}

const files = (staged ? sourceFilesInIndex() : sourceFilesOnDisk()).map((file) => file.replaceAll('\\', '/'));
const fileSet = new Set(files);
const sources = files.map(readSource);
const edges: Edge[] = [];
const failures: string[] = [];
const forbiddenFor: Record<string, RegExp[]> = {
  domain: [/^vscode$/, /^node:/, /^@codemirror\//, /^dom$/i],
  application: [/^vscode$/, /^node:/, /^@codemirror\//, /^dom$/i],
  protocol: [/^vscode$/, /^node:/, /^@codemirror\//, /^dom$/i],
  foundation: [/^vscode$/, /^node:/, /^@codemirror\//, /^dom$/i],
};

for (const source of sources) {
  for (const specifier of importsFor(source)) {
    const resolved = resolveImport(source.path, specifier, fileSet);
    if (resolved) edges.push({ from: source.path, to: resolved, specifier });

    if (isTarget(source.path)) {
      const layer = targetLayer(source.path);
      if (layer && forbiddenFor[layer]?.some((rule) => rule.test(specifier))) {
        failures.push(`ARCH004 ${layer} 禁止依赖 ${specifier}: ${source.path}`);
      }
    }
  }
}

const adjacency = new Map<string, string[]>();
for (const file of files) adjacency.set(file, []);
for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);

const visiting = new Set<string>();
const visited = new Set<string>();
const stack: string[] = [];
const cycles = new Set<string>();
const visit = (file: string): void => {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    if (start >= 0) cycles.add(stack.slice(start).concat(file).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file); stack.push(file);
  for (const next of adjacency.get(file) ?? []) visit(next);
  stack.pop(); visiting.delete(file); visited.add(file);
};
for (const file of files) visit(file);
for (const cycle of cycles) failures.push(`ARCH001 循环依赖: ${cycle}`);

for (const edge of edges) {
  const bootstrapRule = config.bootstrapOnlyModules?.find((rule) => rule.module === edge.to);
  if (bootstrapRule && !bootstrapRule.allowedImporters.includes(edge.from)) {
    failures.push(`ARCH007 具体实现只能由 Bootstrap 导入: ${edge.from} -> ${edge.to}`);
  }
  if (!isTarget(edge.from)) continue;
  const layer = targetLayer(edge.from);
  if (!layer) continue;
  if (isLegacy(edge.to)) failures.push(`ARCH006 新架构依赖 Legacy: ${edge.from} -> ${edge.to}`);
  if (edge.specifier.includes('/internal/')) failures.push(`ARCH003 跨模块 internal 泄漏: ${edge.from} -> ${edge.specifier}`);
  const fromLayer = targetLayer(edge.from);
  const toLayer = targetLayer(edge.to);
  if (fromLayer && toLayer && fromLayer !== toLayer && !allowedTargetLayers(fromLayer).has(toLayer)) {
    failures.push(`ARCH002 依赖方向违规: ${fromLayer} -> ${toLayer} (${edge.from} -> ${edge.to})`);
  }
}

for (const contract of config.sharedModuleContracts ?? []) {
  const actualImporters = new Set(edges.filter((edge) => edge.to === contract.module).map((edge) => edge.from));
  const expectedImporters = new Set(contract.exactImporters);
  for (const importer of expectedImporters) {
    if (!actualImporters.has(importer)) {
      failures.push(`ARCH010 共享模块缺少生产调用方: ${importer} -> ${contract.module}`);
    }
  }
  for (const importer of actualImporters) {
    if (!expectedImporters.has(importer)) {
      failures.push(`ARCH010 共享模块出现未授权调用方: ${importer} -> ${contract.module}`);
    }
  }
  for (const delegate of contract.delegates) {
    const source = sources.find((candidate) => candidate.path === delegate.file);
    if (!source) {
      failures.push(`ARCH011 共享模块调用方不存在: ${delegate.file}`);
      continue;
    }
    const file = sourceFileFor(source);
    const importedCalls = new Map<string, string>();
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (resolveImport(source.path, statement.moduleSpecifier.text, fileSet) !== contract.module) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        importedCalls.set(binding.propertyName?.text ?? binding.name.text, binding.name.text);
      }
    }
    const functionDeclaration = file.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === delegate.function
    ));
    if (!functionDeclaration?.body) {
      failures.push(`ARCH011 共享模块委托函数不存在: ${delegate.file} (${delegate.function})`);
      continue;
    }
    const requiredLocalName = importedCalls.get(delegate.requiredCall);
    const allowedMethods = new Set(delegate.allowedMethodCalls ?? []);
    const parameterNames = new Set(functionDeclaration.parameters
      .filter((parameter) => ts.isIdentifier(parameter.name))
      .map((parameter) => (parameter.name as ts.Identifier).text));
    let requiredCallCount = 0;
    const requiredResultNames = new Set<string>();
    let containsUnauthorizedCall = false;
    let readsParameterByIndex = false;
    let containsDelimiterLiteral = false;
    let containsIteration = false;
    let containsRegex = false;
    const visitCaller = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          if (node.expression.text === requiredLocalName) {
            requiredCallCount += 1;
            if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
              const declarationList = node.parent.parent;
              if (ts.isVariableDeclarationList(declarationList)
                && (declarationList.flags & ts.NodeFlags.Const) !== 0) {
                requiredResultNames.add(node.parent.name.text);
              }
            }
          } else containsUnauthorizedCall = true;
        } else if (ts.isPropertyAccessExpression(node.expression)
          && !allowedMethods.has(node.expression.name.text)) {
          containsUnauthorizedCall = true;
        }
      }
      if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
        || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        containsIteration = true;
      }
      if (ts.isRegularExpressionLiteral(node)) {
        containsRegex = true;
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
        && parameterNames.has(node.expression.text)) {
        readsParameterByIndex = true;
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes('$')) {
        containsDelimiterLiteral = true;
      }
      ts.forEachChild(node, visitCaller);
    };
    visitCaller(functionDeclaration.body);
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
        || ts.isNonNullExpression(current)) {
        current = current.expression;
      }
      return current;
    };
    const returnDerivesSharedResult = (statement: ts.ReturnStatement): boolean => {
      if (!statement.expression) return false;
      const expression = unwrap(statement.expression);
      if (ts.isIdentifier(expression) && requiredResultNames.has(expression.text)) return true;
      if (ts.isCallExpression(expression)) {
        if (ts.isIdentifier(expression.expression) && expression.expression.text === requiredLocalName) {
          return true;
        }
        if (ts.isPropertyAccessExpression(expression.expression)
          && ts.isIdentifier(expression.expression.expression)
          && requiredResultNames.has(expression.expression.expression.text)
          && allowedMethods.has(expression.expression.name.text)) {
          return true;
        }
      }
      return false;
    };
    const isAllowedReturn = (statement: ts.ReturnStatement): boolean => {
      if (!statement.expression) return false;
      const expression = unwrap(statement.expression);
      return returnDerivesSharedResult(statement)
        || Boolean(delegate.allowNullReturn && expression.kind === ts.SyntaxKind.NullKeyword);
    };
    const ownedReturns: ts.ReturnStatement[] = [];
    const collectReturns = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && owner !== functionDeclaration && !ts.isFunctionLike(owner)) owner = owner.parent;
        if (owner === functionDeclaration) ownedReturns.push(node);
      }
      ts.forEachChild(node, collectReturns);
    };
    collectReturns(functionDeclaration.body);
    const declarationCounts = new Map<string, number>();
    const recordBindingName = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        if (requiredResultNames.has(name.text)) {
          declarationCounts.set(name.text, (declarationCounts.get(name.text) ?? 0) + 1);
        }
        return;
      }
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) recordBindingName(element.name);
      }
    };
    const collectDeclarations = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        recordBindingName(node.name);
      } else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node))
        && node.name && requiredResultNames.has(node.name.text)) {
        declarationCounts.set(node.name.text, (declarationCounts.get(node.name.text) ?? 0) + 1);
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(functionDeclaration.body);
    if (!requiredLocalName || requiredCallCount !== 1) {
      failures.push(`ARCH011 共享模块调用方必须恰好委托一次 ${delegate.requiredCall}: ${delegate.file} (${delegate.function})`);
    }
    if (Array.from(requiredResultNames).some((name) => declarationCounts.get(name) !== 1)) {
      failures.push(`ARCH011 共享模块委托结果变量不得遮蔽: ${delegate.file} (${delegate.function})`);
    }
    if (!ownedReturns.some(returnDerivesSharedResult)) {
      failures.push(`ARCH011 共享模块委托结果必须存在有效返回路径: ${delegate.file} (${delegate.function})`);
    }
    if (!ownedReturns.length || ownedReturns.some((statement) => !isAllowedReturn(statement))) {
      failures.push(`ARCH011 共享模块委托结果必须决定返回值: ${delegate.file} (${delegate.function})`);
    }
    if (containsUnauthorizedCall || readsParameterByIndex || containsDelimiterLiteral
      || containsIteration || containsRegex) {
      failures.push(`ARCH011 共享模块委托函数包含调用方扫描规则: ${delegate.file} (${delegate.function})`);
    }
  }
}

for (const contract of config.bootstrapLifecycleContracts ?? []) {
  const source = sources.find((candidate) => candidate.path === contract.file);
  if (!source) {
    failures.push(`ARCH008 Bootstrap 生命周期文件不存在: ${contract.file}`);
    continue;
  }
  const file = sourceFileFor(source);
  const localNames = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = resolveImport(source.path, statement.moduleSpecifier.text, fileSet);
    if (!resolved) continue;
    for (const constructor of contract.constructors.filter((item) => item.module === resolved)) {
      const imports = statement.importClause?.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) continue;
      const binding = imports.elements.find((element) =>
        (element.propertyName?.text ?? element.name.text) === constructor.export
      );
      if (binding) localNames.set(constructor.export, binding.name.text);
    }
  }
  const owners = new Map<string, string>();
  const creationCounts = new Map<string, number>();
  const disposePositions = new Map<string, number>();
  const visitLifecycle = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      for (const [exportName, localName] of localNames) {
        if (node.expression.text !== localName) continue;
        creationCounts.set(exportName, (creationCounts.get(exportName) ?? 0) + 1);
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          owners.set(exportName, node.parent.name.text);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'dispose' && ts.isIdentifier(node.expression.expression)) {
      for (const [exportName, owner] of owners) {
        if (node.expression.expression.text === owner) disposePositions.set(exportName, node.getStart(file));
      }
    }
    ts.forEachChild(node, visitLifecycle);
  };
  visitLifecycle(file);
  for (const constructor of contract.constructors) {
    if (creationCounts.get(constructor.export) !== 1 || !owners.has(constructor.export)) {
      failures.push(`ARCH008 Bootstrap 必须恰好创建一个 ${constructor.export}: ${contract.file}`);
    }
    if (!disposePositions.has(constructor.export)) {
      failures.push(`ARCH008 Bootstrap 必须销毁 ${constructor.export} 的实例: ${contract.file}`);
    }
  }
  for (let index = 1; index < contract.disposeOrder.length; index += 1) {
    const previous = disposePositions.get(contract.disposeOrder[index - 1]);
    const current = disposePositions.get(contract.disposeOrder[index]);
    if (previous !== undefined && current !== undefined && previous >= current) {
      failures.push(`ARCH008 Bootstrap 销毁顺序违规: ${contract.disposeOrder.join(' -> ')} (${contract.file})`);
      break;
    }
  }
}

for (const module of config.resourceOwnerFreeModules ?? []) {
  const source = sources.find((candidate) => candidate.path === module);
  if (!source) continue;
  const file = sourceFileFor(source);
  const isFrozenLiteral = (node: ts.Node): boolean => (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'Object'
    && node.expression.name.text === 'freeze'
    && node.arguments.length === 1
    && (ts.isArrayLiteralExpression(node.arguments[0]) || ts.isObjectLiteralExpression(node.arguments[0]))
  );
  const containsMutableResource = (node: ts.Node): boolean => {
    if (isFrozenLiteral(node)) {
      let nestedMutable = false;
      ts.forEachChild(node.arguments[0], (child) => {
        if (!nestedMutable && containsMutableResource(child)) nestedMutable = true;
      });
      return nestedMutable;
    }
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node) || ts.isNewExpression(node)) {
      return true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && /^(?:create|make|open).*(?:pool|queue|cache|resource|registry)$/i.test(node.expression.text)) {
      return true;
    }
    let mutable = false;
    ts.forEachChild(node, (child) => {
      if (!mutable && containsMutableResource(child)) mutable = true;
    });
    return mutable;
  };
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const mutableDeclaration = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const initializer = declaration.initializer;
      if (mutableDeclaration || Boolean(initializer && containsMutableResource(initializer))) {
        failures.push(`ARCH009 资源无状态模块禁止顶层可变状态: ${module} (${name})`);
      }
    }
  }
}

const protocolSources = sources.filter((source) => source.path.startsWith('src/protocol/'));
if (protocolSources.length) {
  for (const source of sources.filter((item) => !item.path.startsWith('src/protocol/'))) {
    const directionalMessageType = /\btype\s+(?:Webview|Host|Extension)(?:ToHost|ToWebview)?Message\s*=([^;\r\n]+)/g;
    if (Array.from(source.text.matchAll(directionalMessageType))
      .some((match) => !match[1]?.trimStart().startsWith('import('))) {
      failures.push(`PROT001 Protocol 类型必须只定义在 src/protocol: ${source.path}`);
    }
  }
  if (!protocolSources.some((source) => /\b(?:export\s+)?function\s+decode[A-Z]|\bdecode[A-Z][A-Za-z]*\s*=/.test(source.text))) {
    failures.push('PROT002 src/protocol 缺少运行时 decoder');
  }
  for (const source of sources.filter((item) => item.path === 'src/extension/panelSession.ts' || item.path === 'webview/src/index.ts')) {
    if (/\?\?\s*(?:rawMessage\b|raw\s+as\s+)/.test(source.text)) {
      failures.push(`PROT004 Protocol 入站禁止 decoder 后回退 raw 值: ${source.path}`);
    }
    const expectedDecoder = source.path === 'src/extension/panelSession.ts'
      ? 'decodeWebviewToHostMessage'
      : 'decodeHostToWebviewMessage';
    if (!new RegExp(`\\b${expectedDecoder}\\s*\\(`).test(source.text)) {
      failures.push(`PROT005 Protocol 入站必须经过方向总 decoder ${expectedDecoder}: ${source.path}`);
    }
  }
}

for (const source of sources) {
  if (!isTarget(source.path) || !source.path.startsWith('webview/')) continue;
  const layer = targetLayer(source.path);
  if (layer !== 'adapters' && /\.postMessage\s*\(/.test(source.text)) {
    failures.push(`PROT003 Webview 绕过 Transport: ${source.path}`);
  }
}

if (config.knownLegacyTestFailures.length > 0) {
  failures.push('ARCH012 Legacy 测试失败基线必须保持为空');
}

console.log(`Architecture check (${staged ? 'staged index' : 'working tree'}): ${files.length} source files, ${edges.length} static imports`);
console.log(`Legacy test baseline: ${config.knownLegacyTestFailures.map((item) => item.id).join(', ') || 'none'}`);
if (failures.length) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Architecture checks passed; Legacy test baseline is empty.');
