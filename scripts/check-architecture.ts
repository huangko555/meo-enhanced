import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

type Source = { path: string; text: string };
type Edge = { from: string; to: string; specifier: string };

const repoRoot = resolve(import.meta.dir, '..');
const staged = process.argv.includes('--staged');
const configPath = join(repoRoot, 'scripts', 'architecture-baseline.json');

function indexPaths(): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: repoRoot });
  return output.toString('utf8').split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
}

function isArchitectureTextPath(path: string): boolean {
  return path === 'scripts/architecture-baseline.json' ||
    path === 'package.json' ||
    /^(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path) ||
    /^README(?:\.[^/]+)?\.md$/i.test(path) ||
    /^docs\/.*\.md$/i.test(path) ||
    /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path);
}

function readIndexTextFiles(paths: readonly string[]): Map<string, string> {
  if (!paths.length) return new Map();
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: Buffer.from(paths.map((path) => `:${path}\n`).join(''), 'utf8'),
    maxBuffer: 128 * 1024 * 1024
  });
  const result = new Map<string, string>();
  let offset = 0;
  for (const path of paths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file 缺少 blob header: ${path}`);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`git cat-file 无法读取 index blob: ${path} (${header})`);
    const size = Number(match[1]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error(`git cat-file blob 长度无效: ${path}`);
    }
    result.set(path, output.subarray(contentStart, contentEnd).toString('utf8'));
    offset = contentEnd + 1;
  }
  return result;
}

const cachedIndexPaths = staged ? indexPaths() : [];
const stagedTextFiles = staged
  ? readIndexTextFiles(cachedIndexPaths.filter(isArchitectureTextPath))
  : new Map<string, string>();

const configText = staged
  ? stagedTextFiles.get('scripts/architecture-baseline.json') ?? ''
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
  return cachedIndexPaths
    .filter((file) => /^(src|webview[\\/]src)[\\/].*\.(ts|tsx)$/.test(file));
}

function readSource(file: string): Source {
  const path = file.replaceAll('\\', '/');
  const text = staged ? stagedTextFiles.get(path) : readFileSync(join(repoRoot, file), 'utf8');
  if (text === undefined) throw new Error(`无法读取架构源码: ${path}`);
  return { path, text };
}

function projectFilesForCapabilityGuard(): string[] {
  if (staged) {
    return cachedIndexPaths;
  }
  const result: string[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else result.push(relative(repoRoot, full).replaceAll('\\', '/'));
    }
  };
  for (const entry of readdirSync(repoRoot)) {
    if (
      entry === 'package.json' ||
      /^(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(entry) ||
      /^README(?:\.[^/]+)?\.md$/i.test(entry)
    ) result.push(entry);
  }
  for (const root of ['docs', 'src', 'webview/src']) visit(join(repoRoot, root));
  return result;
}

function readTrackedProjectFile(path: string): string {
  const text = staged ? stagedTextFiles.get(path) : readFileSync(join(repoRoot, path), 'utf8');
  if (text === undefined) throw new Error(`无法读取产品入口: ${path}`);
  return text;
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

// Product deletion guard: table sorting must stay absent from every production-facing entry.
// Ordinary Array.sort calls, ordered-list behavior and Provenance source-row mappings are retained capabilities.
const tableSortingScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
const removedTableSortingTokens = [
  /preview[-_. ]?sort/i,
  /apply[-_. ]?sort/i,
  /TableSort[A-Za-z0-9_]*/,
  /sort(?:Button|Column|State|Direction|ByColumn|edRowOrder)/,
  /meo-[A-Za-z0-9_-]*sort[A-Za-z0-9_-]*/i,
  /\b(?:table|columns?|rows?)[-_. ]+(?:sort|order|reorder)(?:ing|ed)?\b/i,
  /\b(?:sort|order|reorder)(?:ing|ed)?[-_. ]+(?:table|columns?|rows?)\b/i,
  /\b(?:table|column|row)(?:Sort|Order|Reorder)[A-Za-z0-9_]*/,
  /\b(?:sort|order|reorder)(?:Table|Column|Row)[A-Za-z0-9_]*/,
  /\b(?:table|columns?|rows?)\b.{0,48}\b(?:sort|order|reorder)(?:ing|ed)?\b/i,
  /\b(?:sort|order|reorder)(?:ing|ed)?\b.{0,48}\b(?:table|columns?|rows?)\b/i,
  /\b(?:table|column|row)[A-Za-z0-9_.-]{0,48}(?:Order|Ordering)[A-Za-z0-9_]*/,
  /\b[A-Za-z0-9_.-]*(?:Order|Ordering)[A-Za-z0-9_.-]{0,48}(?:Table|Column|Row)[A-Za-z0-9_]*/
];
for (const path of tableSortingScope) {
  const lines = readTrackedProjectFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
      .replace(/\.(?:sort|toSorted)\s*\(/g, '(')
      .replace(/\b(?:un)?ordered(?:List|Lists|ListMarker)?\b/gi, '')
      .replace(/\b(?:sourceRowOrder|effectiveSourceRowOrder)\b/g, '');
    if (
      removedTableSortingTokens.some((pattern) => pattern.test(line))
    ) {
      failures.push(`ARCH013 已删除的表格排序能力重新出现: ${path}:${index + 1}`);
    }
  }
}

// Product deletion guard: Git Blame and its line-author/navigation aliases must stay absent.
// Git diff, Git HEAD baselines and ordinary document-link navigation remain supported.
const gitBlameScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
const normalizeCapabilityWords = (text: string): string[] => text
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[^A-Za-z0-9]+/g, ' ')
  .toLowerCase()
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const hasRemovedGitLineCapability = (text: string): boolean => {
  const words = normalizeCapabilityWords(text);
  if (!words.includes('git')) return false;
  if (words.some((word, index) => word === 'git' && words[index + 1] === 'annotate')) return true;
  const hasGitLineAuthorCapability = text.split(/[,:;={}()[\]'"`]/).some((segment) => {
    const segmentWords = normalizeCapabilityWords(segment);
    return segmentWords.some((_, start) => {
      const window = segmentWords.slice(start, start + 5);
      const wordSet = new Set(window);
      const hasCapabilityLine = window.some((word, index) => (
        word === 'line' && window[index + 1] !== 'coloring'
      ));
      return wordSet.has('git')
        && hasCapabilityLine
        && (wordSet.has('author') || wordSet.has('authors'));
    });
  });
  if (hasGitLineAuthorCapability) return true;
  for (let start = 0; start < words.length; start += 1) {
    const window = words.slice(start, start + 5);
    const wordSet = new Set(window);
    if (!wordSet.has('git') || !wordSet.has('line')) continue;
    if (wordSet.has('annotation') || wordSet.has('annotations') || wordSet.has('history')) {
      return true;
    }
    if (wordSet.has('commit') && wordSet.has('info')) return true;
    const navigation = ['open', 'show', 'navigate', 'navigation', 'reveal', 'jump']
      .some((word) => wordSet.has(word));
    if (navigation && ['revision', 'commit', 'history'].some((word) => wordSet.has(word))) {
      return true;
    }
  }
  return false;
};
const removedGitBlameTokens = [
  /git[-_. ]?blame/i,
  /\brequestLineAuthor[A-Za-z0-9_]*/,
  /\b(?:request|show|get|load|fetch)(?:Git)?CommitInfoForLine[A-Za-z0-9_]*/,
  /\b(?:show|request|open|toggle|enable|disable)LineHistory[A-Za-z0-9_]*/,
  /\b(?:open|show|navigate(?:To)?|reveal|jumpTo)(?:Git)?(?:Commit|Revision|History)ForLine[A-Za-z0-9_]*/,
  /\bopenGit(?:Revision|Worktree)ForLine\b/
];
for (const path of gitBlameScope) {
  const lines = readTrackedProjectFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (
      hasRemovedGitLineCapability(lines[index]) ||
      removedGitBlameTokens.some((pattern) => pattern.test(lines[index]))
    ) {
      failures.push(`ARCH014 已删除的 Git Blame 能力重新出现: ${path}:${index + 1}`);
    }
  }
}

// Product deletion guard: MEO-owned spell checking and diagnostic suggestions must stay absent.
// VS Code/compiler diagnostics display and ordinary selection formatting commands remain supported.
const spellDiagnosticScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
type NativeSpellcheckRange = { readonly start: number; readonly end: number };

const nativeHtmlSpellcheckRanges = (text: string): NativeSpellcheckRange[] => {
  const ranges: NativeSpellcheckRange[] = [];
  const attributePattern = /spellcheck\s*=\s*(?:(["'])(?:true|false)\1|(?:true|false))(?=\s|\/?>)/iy;
  for (let index = 0; index < text.length; index += 1) {
    if (
      text[index] !== '<' ||
      !/[A-Za-z]/.test(text[index + 1] ?? '') ||
      /[A-Za-z0-9_$]/.test(text[index - 1] ?? '')
    ) continue;

    let nameEnd = index + 2;
    while (/[A-Za-z0-9:-]/.test(text[nameEnd] ?? '')) nameEnd += 1;
    if (!/[\s/>]/.test(text[nameEnd] ?? '')) continue;

    let quote = '';
    let tagEnd = -1;
    let cursor = nameEnd;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '>') {
        tagEnd = cursor;
        break;
      }
      if (char === '<' || char === '`') break;
      if (char === '"' || char === "'") {
        let previous = cursor - 1;
        while (/\s/.test(text[previous] ?? '')) previous -= 1;
        if (text[previous] !== '=') break;
        quote = char;
      }
    }
    if (tagEnd < 0) {
      if (text[cursor] === '<') index = cursor - 1;
      continue;
    }

    quote = '';
    for (let attribute = nameEnd; attribute < tagEnd; attribute += 1) {
      const char = text[attribute];
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (attribute !== nameEnd && !/[\s/]/.test(text[attribute - 1] ?? '')) continue;
      attributePattern.lastIndex = attribute;
      const match = attributePattern.exec(text);
      if (match && attributePattern.lastIndex <= tagEnd) {
        ranges.push({ start: attribute, end: attributePattern.lastIndex });
        attribute = attributePattern.lastIndex - 1;
      }
    }
    index = tagEnd;
  }
  return ranges;
};

const nativeDomSpellcheckRanges = (text: string, path: string): NativeSpellcheckRange[] => {
  if (!/\.tsx?$/i.test(path)) return [];
  const sourceFile = sourceFileFor({ path, text });
  const ranges: NativeSpellcheckRange[] = [];
  const domTypes = new Set(['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLElement']);
  type Scope = {
    readonly parent: Scope | null;
    readonly kind: 'source' | 'function' | 'block';
    readonly bindings: Map<string, Binding>;
  };
  type BindingKind = 'const' | 'let' | 'var' | 'parameter';
  type ControlFrame = { readonly owner: ts.Node; readonly branch: string };
  type BindingEvent = {
    readonly node: ts.Node;
    readonly position: number;
    readonly dom: boolean;
    readonly context: Scope;
    readonly controlPath: readonly ControlFrame[];
    readonly pathKey: string;
    readonly pathPrefixes: readonly string[];
  };
  type SpellcheckUse = {
    readonly position: number;
    readonly range: NativeSpellcheckRange;
    readonly context: Scope;
    readonly controlPath: readonly ControlFrame[];
    readonly pathKey: string;
    readonly pathPrefixes: readonly string[];
  };
  type Binding = {
    kind: BindingKind;
    declarationContext: Scope | null;
    iterationResetLoop: ts.ForInStatement | ts.ForOfStatement | null;
    readonly events: BindingEvent[];
    readonly uses: SpellcheckUse[];
  };
  type ContinueExit = {
    readonly node: ts.ContinueStatement;
    readonly position: number;
    readonly pathPrefixes: readonly string[];
    readonly dominancePathKey: string;
    readonly finallyBlocks: readonly ts.Block[];
    readonly reachesBackedge: boolean;
  };
  const scopeByNode = new Map<ts.Node, Scope>();
  const bindings = new Set<Binding>();
  const continueExitsByContext = new Map<Scope, Map<ts.Node, ContinueExit[]>>();
  const throwsByFinallyBlock = new Map<ts.Block, ts.ThrowStatement[]>();

  const isDomType = (node: ts.TypeNode | undefined): boolean => {
    if (!node) return false;
    if (ts.isTypeReferenceNode(node)) return domTypes.has(node.typeName.getText(sourceFile));
    return false;
  };
  const unwrapExpression = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  const isDomInitializer = (node: ts.Expression | undefined): boolean => {
    if (!node) return false;
    const expression = unwrapExpression(node);
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      return isDomType(expression.type);
    }
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
      return false;
    }
    const method = expression.expression;
    if (
      method.expression.getText(sourceFile) === 'document' &&
      method.name.text === 'createElement' &&
      expression.arguments.length > 0 &&
      ts.isStringLiteralLike(expression.arguments[0])
    ) {
      return /^(?:input|textarea)$/i.test(expression.arguments[0].text);
    }
    return method.name.text === 'querySelector' && isDomType(expression.typeArguments?.[0]);
  };
  const isLexicalScope = (node: ts.Node): boolean => (
    ts.isSourceFile(node) ||
    ts.isFunctionLike(node) ||
    ts.isBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSwitchStatement(node)
  );
  const scopeKind = (node: ts.Node): Scope['kind'] => {
    if (ts.isSourceFile(node)) return 'source';
    if (ts.isFunctionLike(node)) return 'function';
    return 'block';
  };
  const nearestFunctionScope = (scope: Scope): Scope => {
    let current = scope;
    while (current.kind === 'block' && current.parent) current = current.parent;
    return current;
  };
  const resolveBinding = (scope: Scope, name: string): Binding | undefined => {
    let current: Scope | null = scope;
    while (current) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
      current = current.parent;
    }
    return undefined;
  };
  const bind = (scope: Scope, name: string, kind: BindingKind): Binding => {
    const bindingScope = kind === 'var' ? nearestFunctionScope(scope) : scope;
    const existing = bindingScope.bindings.get(name);
    if (existing) return existing;
    const binding: Binding = {
      kind,
      declarationContext: null,
      iterationResetLoop: null,
      events: [],
      uses: []
    };
    bindingScope.bindings.set(name, binding);
    bindings.add(binding);
    return binding;
  };
  const variableKind = (node: ts.VariableDeclaration): BindingKind => {
    const flags = node.parent.flags;
    if (flags & ts.NodeFlags.Const) return 'const';
    if (flags & ts.NodeFlags.Let) return 'let';
    return 'var';
  };
  const collectBindings = (node: ts.Node, parentScope: Scope | null): void => {
    const scope = isLexicalScope(node)
      ? { parent: parentScope, kind: scopeKind(node), bindings: new Map<string, Binding>() }
      : parentScope!;
    if (isLexicalScope(node)) scopeByNode.set(node, scope);
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const kind = ts.isParameter(node) || ts.isCatchClause(node.parent)
        ? 'parameter'
        : variableKind(node);
      const binding = bind(scope, node.name.text, kind);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        (ts.isForInStatement(node.parent.parent) || ts.isForOfStatement(node.parent.parent)) &&
        node.parent.parent.initializer === node.parent
      ) {
        binding.iterationResetLoop = node.parent.parent;
      }
    }
    ts.forEachChild(node, (child) => collectBindings(child, scope));
  };
  collectBindings(sourceFile, null);

  const executionContext = (scope: Scope): Scope => nearestFunctionScope(scope);
  const statementDefinitelyTerminates = (node: ts.Statement): boolean => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBlock(node)) {
      return node.statements.some(statementDefinitelyTerminates);
    }
    return ts.isIfStatement(node) && Boolean(node.elseStatement) &&
      statementDefinitelyTerminates(node.thenStatement) &&
      statementDefinitelyTerminates(node.elseStatement!);
  };
  const isLoopStatement = (node: ts.Node): node is ts.IterationStatement => (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
  const labeledLoop = (node: ts.LabeledStatement): ts.IterationStatement | null => {
    let statement = node.statement;
    while (ts.isLabeledStatement(statement)) statement = statement.statement;
    return isLoopStatement(statement) ? statement : null;
  };
  const continueTargetLoop = (node: ts.ContinueStatement): ts.IterationStatement | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return null;
      if (node.label) {
        if (ts.isLabeledStatement(parent) && parent.label.text === node.label.text) {
          return labeledLoop(parent);
        }
      } else if (isLoopStatement(parent)) {
        return parent;
      }
    }
    return null;
  };
  const breakTarget = (node: ts.BreakStatement): ts.Node | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return null;
      if (node.label) {
        if (ts.isLabeledStatement(parent) && parent.label.text === node.label.text) return parent;
      } else if (isLoopStatement(parent) || ts.isSwitchStatement(parent)) {
        return parent;
      }
    }
    return null;
  };
  const syntaxContains = (container: ts.Node, node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (current === container) return true;
    }
    return false;
  };
  const statementDefinitelySkipsFollowing = (node: ts.Statement, boundary: ts.Block): boolean => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBreakStatement(node)) {
      const destination = breakTarget(node);
      return destination !== null && !syntaxContains(boundary, destination);
    }
    if (ts.isContinueStatement(node)) {
      const destination = continueTargetLoop(node);
      return destination !== null && !syntaxContains(boundary, destination);
    }
    if (ts.isBlock(node)) {
      return node.statements.some((statement) => statementDefinitelySkipsFollowing(statement, boundary));
    }
    if (ts.isLabeledStatement(node)) return statementDefinitelySkipsFollowing(node.statement, boundary);
    if (
      ts.isTryStatement(node) && node.finallyBlock &&
      statementDefinitelySkipsFollowing(node.finallyBlock, boundary)
    ) return true;
    return ts.isIfStatement(node) && Boolean(node.elseStatement) &&
      statementDefinitelySkipsFollowing(node.thenStatement, boundary) &&
      statementDefinitelySkipsFollowing(node.elseStatement!, boundary);
  };
  const abruptOverridesContinue = (
    node: ts.ContinueStatement | ts.BreakStatement,
    target: ts.IterationStatement
  ): boolean => {
    if (ts.isContinueStatement(node)) {
      const destination = continueTargetLoop(node);
      return destination !== null && destination !== target && syntaxContains(destination, target);
    }
    const destination = breakTarget(node);
    return destination !== null && syntaxContains(destination, target);
  };
  const statementOverridesContinue = (
    node: ts.Statement,
    target: ts.IterationStatement
  ): boolean => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      return abruptOverridesContinue(node, target);
    }
    if (ts.isBlock(node)) {
      return node.statements.some((statement) => statementOverridesContinue(statement, target));
    }
    return ts.isIfStatement(node) && Boolean(node.elseStatement) &&
      statementOverridesContinue(node.thenStatement, target) &&
      statementOverridesContinue(node.elseStatement!, target);
  };
  const associatedFinallyBlocks = (
    node: ts.ContinueStatement,
    target: ts.IterationStatement
  ): ts.Block[] => {
    const blocks: ts.Block[] = [];
    let child: ts.Node = node;
    for (let parent = node.parent; parent && parent !== target; parent = parent.parent) {
      if (
        ts.isTryStatement(parent) &&
        parent.finallyBlock &&
        (child === parent.tryBlock || child === parent.catchClause)
      ) {
        blocks.push(parent.finallyBlock);
      }
      child = parent;
    }
    return blocks;
  };
  const continueDominanceRoot = (
    node: ts.ContinueStatement,
    target: ts.IterationStatement
  ): ts.Node => {
    let root: ts.Node = node;
    while (root.parent && root.parent !== target) {
      const parent = root.parent;
      if (ts.isBlock(parent)) {
        if (parent.parent === target) break;
        root = parent;
      } else if (ts.isLabeledStatement(parent)) {
        root = parent;
      } else if (ts.isDoStatement(parent) && parent.statement === root) {
        root = parent;
      } else if (ts.isTryStatement(parent) && parent.tryBlock === root) {
        root = parent;
      } else {
        break;
      }
    }
    return root;
  };
  const controlPathForNode = (
    node: ts.Node,
    inheritedPath: readonly ControlFrame[]
  ): readonly ControlFrame[] => {
    const parent = node.parent;
    if (!parent) return inheritedPath;
    let frame: ControlFrame | undefined;
    if (ts.isIfStatement(parent)) {
      if (
        node === parent.thenStatement &&
        (!parent.elseStatement || !statementDefinitelyTerminates(parent.elseStatement))
      ) {
        frame = { owner: parent, branch: 'then' };
      } else if (
        node === parent.elseStatement &&
        !statementDefinitelyTerminates(parent.thenStatement)
      ) {
        frame = { owner: parent, branch: 'else' };
      }
    } else if (
      (ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent) ||
        ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      node === parent.statement
    ) {
      frame = { owner: parent, branch: 'loop' };
    } else if (ts.isForStatement(parent) && node === parent.incrementor) {
      frame = { owner: parent, branch: 'loop' };
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      frame = { owner: node.parent.parent, branch: `case:${node.pos}` };
    } else if (ts.isTryStatement(parent)) {
      if (node === parent.tryBlock) frame = { owner: parent, branch: 'try' };
      else if (node === parent.catchClause) frame = { owner: parent, branch: 'catch' };
    } else if (ts.isConditionalExpression(parent)) {
      if (node === parent.whenTrue) frame = { owner: parent, branch: 'then' };
      else if (node === parent.whenFalse) frame = { owner: parent, branch: 'else' };
    } else if (
      ts.isBinaryExpression(parent) &&
      node === parent.right &&
      (
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      )
    ) {
      frame = { owner: parent, branch: 'short-circuit' };
    }
    return frame ? [...inheritedPath, frame] : inheritedPath;
  };
  type ControlPathMetadata = {
    readonly key: string;
    readonly prefixes: readonly string[];
  };
  const controlPathMetadataCache = new WeakMap<readonly ControlFrame[], ControlPathMetadata>();
  const controlPathByNode = new Map<ts.Node, readonly ControlFrame[]>();
  const controlPathMetadata = (controlPath: readonly ControlFrame[]): ControlPathMetadata => {
    const cached = controlPathMetadataCache.get(controlPath);
    if (cached) return cached;
    const prefixes = [''];
    let key = '';
    for (const frame of controlPath) {
      key += `/${frame.owner.pos}:${frame.branch}`;
      prefixes.push(key);
    }
    const metadata = { key, prefixes };
    controlPathMetadataCache.set(controlPath, metadata);
    return metadata;
  };
  const collectUsesAndAssignments = (
    node: ts.Node,
    inheritedScope: Scope,
    inheritedPath: readonly ControlFrame[]
  ): void => {
    const scope = scopeByNode.get(node) ?? inheritedScope;
    const context = executionContext(scope);
    const controlPath = controlPathForNode(node, inheritedPath);
    controlPathByNode.set(node, controlPath);
    const pathMetadata = controlPathMetadata(controlPath);
    if (ts.isThrowStatement(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) break;
        if (
          ts.isBlock(parent) && ts.isTryStatement(parent.parent) &&
          parent.parent.finallyBlock === parent
        ) {
          const throws = throwsByFinallyBlock.get(parent) ?? [];
          throws.push(node);
          throwsByFinallyBlock.set(parent, throws);
          break;
        }
      }
    }
    if (ts.isContinueStatement(node)) {
      const target = continueTargetLoop(node);
      if (target) {
        const finallyBlocks = associatedFinallyBlocks(node, target);
        const dominanceRoot = continueDominanceRoot(node, target);
        const reachesBackedge = !finallyBlocks.some((block) => statementOverridesContinue(block, target));
        const exit: ContinueExit = {
          node,
          position: node.getStart(sourceFile),
          pathPrefixes: pathMetadata.prefixes,
          dominancePathKey: controlPathMetadata(controlPathByNode.get(dominanceRoot) ?? controlPath).key,
          finallyBlocks,
          reachesBackedge
        };
        let byOwner = continueExitsByContext.get(context);
        if (!byOwner) {
          byOwner = new Map();
          continueExitsByContext.set(context, byOwner);
        }
        const exits = byOwner.get(target) ?? [];
        exits.push(exit);
        byOwner.set(target, exits);
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const binding = resolveBinding(scope, node.name.text);
      if (binding && binding.declarationContext === null) binding.declarationContext = context;
      binding?.events.push({
        node,
        position: node.getStart(sourceFile),
        dom: isDomType(node.type) || isDomInitializer(node.initializer),
        context,
        controlPath,
        pathKey: pathMetadata.key,
        pathPrefixes: pathMetadata.prefixes
      });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = unwrapExpression(node.left);
      if (ts.isIdentifier(left)) {
        resolveBinding(scope, left.text)?.events.push({
          node,
          position: node.getStart(sourceFile),
          dom: node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isDomInitializer(node.right),
          context,
          controlPath,
          pathKey: pathMetadata.key,
          pathPrefixes: pathMetadata.prefixes
        });
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(left) &&
        left.name.text.toLowerCase() === 'spellcheck' &&
        (node.right.kind === ts.SyntaxKind.TrueKeyword || node.right.kind === ts.SyntaxKind.FalseKeyword)
      ) {
        const receiver = unwrapExpression(left.expression);
        if (ts.isIdentifier(receiver)) {
          resolveBinding(scope, receiver.text)?.uses.push({
            position: node.getStart(sourceFile),
            range: { start: node.getStart(sourceFile), end: node.end },
            context,
            controlPath,
            pathKey: pathMetadata.key,
            pathPrefixes: pathMetadata.prefixes
          });
        }
      }
    }
    ts.forEachChild(node, (child) => collectUsesAndAssignments(child, scope, controlPath));
  };
  collectUsesAndAssignments(sourceFile, scopeByNode.get(sourceFile)!, []);

  type ContinueOwnerSummary = {
    readonly blockerPositionsByAncestorPath: Map<string, number[]>;
    readonly unreachableRangesByPath: Map<string, NativeSpellcheckRange[]>;
    readonly noBackedgePathKeys: Set<string>;
    readonly targetContinuePositions: readonly number[];
  };
  const addPosition = (positionsByPath: Map<string, number[]>, path: string, position: number): void => {
    const positions = positionsByPath.get(path) ?? [];
    positions.push(position);
    positionsByPath.set(path, positions);
  };
  const firstPositionAfter = (positions: readonly number[] | undefined, after: number): number => {
    if (!positions) return Number.POSITIVE_INFINITY;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] <= after) low = middle + 1;
      else high = middle;
    }
    return positions[low] ?? Number.POSITIVE_INFINITY;
  };
  const directChildOfBlock = (node: ts.Node, block: ts.Block): ts.Node | null => {
    let current = node;
    while (current.parent && current.parent !== block) current = current.parent;
    return current.parent === block ? current : null;
  };
  const nodeIsReachableFromBoundaryEntry = (node: ts.Node, boundary: ts.Node): boolean => {
    let current = node;
    while (current.parent && current !== boundary) {
      const parent = current.parent;
      if (ts.isBlock(parent)) {
        const child = directChildOfBlock(current, parent);
        const childIndex = child ? parent.statements.indexOf(child as ts.Statement) : -1;
        if (
          childIndex > 0 &&
          parent.statements.slice(0, childIndex).some((statement) => (
            statementDefinitelySkipsFollowing(statement, parent)
          ))
        ) return false;
      }
      current = parent;
    }
    return current === boundary;
  };
  const enclosingCatchBeforeTarget = (
    node: ts.Node,
    target: ts.Node
  ): ts.CatchClause | null => {
    let child = node;
    for (let parent = node.parent; parent && parent !== target; parent = parent.parent) {
      if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return null;
      if (ts.isTryStatement(parent) && parent.catchClause && child === parent.tryBlock) {
        return parent.catchClause;
      }
      child = parent;
    }
    return null;
  };
  const catchDefinitelyLeavesTarget = (node: ts.Statement, target: ts.IterationStatement): boolean => {
    if (ts.isReturnStatement(node)) return true;
    if (ts.isThrowStatement(node)) return enclosingCatchBeforeTarget(node, target) === null;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      return abruptOverridesContinue(node, target);
    }
    if (ts.isBlock(node)) return node.statements.some((statement) => catchDefinitelyLeavesTarget(statement, target));
    return ts.isIfStatement(node) && Boolean(node.elseStatement) &&
      catchDefinitelyLeavesTarget(node.thenStatement, target) &&
      catchDefinitelyLeavesTarget(node.elseStatement!, target);
  };
  type CaughtCompletionSummary = {
    readonly block: ts.Block;
    readonly catchPath: string;
    readonly catchEnd: number;
    readonly targetContinuePosition: number;
    readonly blockerPositionsByAncestorPath: ReadonlyMap<string, readonly number[]>;
  };
  type CaughtOwnerCompletionSummary = {
    readonly allBlockerPositionsByAncestorPath: ReadonlyMap<string, readonly number[]>;
    readonly catchesByPath: ReadonlyMap<string, readonly CaughtCompletionSummary[]>;
  };
  const continueBlockingPosition = (
    exit: ContinueExit,
    targetContinuePositions: readonly number[]
  ): number => exit.finallyBlocks.reduce((position, block) => {
    const sameTargetCompletion = firstPositionAfter(targetContinuePositions, block.getStart(sourceFile));
    return sameTargetCompletion < block.end ? sameTargetCompletion : Math.max(position, block.end);
  }, exit.position);
  const continueUnreachableRanges = (
    exit: ContinueExit,
    target: ts.Node
  ): NativeSpellcheckRange[] => {
    const ranges: NativeSpellcheckRange[] = [];
    let cursor = exit.position;
    const finallyBlocks = [...exit.finallyBlocks].sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
    for (const block of finallyBlocks) {
      const start = block.getStart(sourceFile);
      if (start > cursor) ranges.push({ start: cursor, end: start });
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < target.end) ranges.push({ start: cursor, end: target.end });
    return ranges;
  };
  const addRange = (
    rangesByPath: Map<string, NativeSpellcheckRange[]>,
    path: string,
    range: NativeSpellcheckRange
  ): void => {
    const ranges = rangesByPath.get(path) ?? [];
    ranges.push(range);
    rangesByPath.set(path, ranges);
  };
  const continueSummariesByContext = new Map<Scope, Map<ts.Node, ContinueOwnerSummary>>();
  const associatedFinallyPrefixesByContext = new Map<
    Scope,
    Map<ts.Node, Map<ts.Block, Set<string>>>
  >();
  for (const [context, exitsByOwner] of continueExitsByContext) {
    const summariesByOwner = new Map<ts.Node, ContinueOwnerSummary>();
    const finallyPrefixesByOwner = new Map<ts.Node, Map<ts.Block, Set<string>>>();
    for (const [owner, exits] of exitsByOwner) {
      const finallyPrefixes = new Map<ts.Block, Set<string>>();
      const targetContinuePositions = exits
        .filter((exit) => exit.reachesBackedge && nodeIsReachableFromBoundaryEntry(exit.node, owner))
        .map((exit) => exit.position)
        .sort((left, right) => left - right);
      const summary: ContinueOwnerSummary = {
        blockerPositionsByAncestorPath: new Map(),
        unreachableRangesByPath: new Map(),
        noBackedgePathKeys: new Set(),
        targetContinuePositions
      };
      for (const exit of exits) {
        if (!nodeIsReachableFromBoundaryEntry(exit.node, owner)) continue;
        if (!exit.reachesBackedge) {
          summary.noBackedgePathKeys.add(exit.dominancePathKey);
          continue;
        }
        const blockingPosition = continueBlockingPosition(exit, targetContinuePositions);
        for (const prefix of exit.pathPrefixes) {
          addPosition(summary.blockerPositionsByAncestorPath, prefix, blockingPosition);
        }
        for (const range of continueUnreachableRanges(exit, owner)) {
          addRange(summary.unreachableRangesByPath, exit.dominancePathKey, range);
        }
        for (const block of exit.finallyBlocks) {
          const prefixes = finallyPrefixes.get(block) ?? new Set<string>();
          for (const prefix of exit.pathPrefixes) prefixes.add(prefix);
          finallyPrefixes.set(block, prefixes);
        }
      }
      for (const positions of summary.blockerPositionsByAncestorPath.values()) {
        positions.sort((left, right) => left - right);
      }
      for (const ranges of summary.unreachableRangesByPath.values()) {
        ranges.sort((left, right) => left.start - right.start);
        let writeIndex = 0;
        for (const range of ranges) {
          const previous = ranges[writeIndex - 1];
          if (previous && range.start <= previous.end) {
            ranges[writeIndex - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
          }
          else ranges[writeIndex++] = range;
        }
        ranges.length = writeIndex;
      }
      summariesByOwner.set(owner, summary);
      if (finallyPrefixes.size > 0) finallyPrefixesByOwner.set(owner, finallyPrefixes);
    }
    continueSummariesByContext.set(context, summariesByOwner);
    associatedFinallyPrefixesByContext.set(context, finallyPrefixesByOwner);
  }
  const addPositionSet = (
    positionsByPath: Map<string, Set<number>>,
    path: string,
    position: number
  ): void => {
    const positions = positionsByPath.get(path) ?? new Set<number>();
    positions.add(position);
    positionsByPath.set(path, positions);
  };
  const sortedPositionArrays = (
    positionSetsByPath: ReadonlyMap<string, ReadonlySet<number>>
  ): Map<string, readonly number[]> => new Map(
    [...positionSetsByPath].map(([path, positions]) => [
      path,
      [...positions].sort((left, right) => left - right)
    ])
  );
  const caughtCompletionSummariesByContext = new Map<
    Scope,
    Map<ts.Node, CaughtOwnerCompletionSummary>
  >();
  for (const [context, finallyPrefixesByOwner] of associatedFinallyPrefixesByContext) {
    const summariesByOwner = new Map<ts.Node, CaughtOwnerCompletionSummary>();
    for (const [owner, prefixesByFinally] of finallyPrefixesByOwner) {
      const allPositionSetsByPath = new Map<string, Set<number>>();
      const positionSetsByCatch = new Map<ts.Block, Map<string, Set<number>>>();
      const targetPositions = continueSummariesByContext.get(context)?.get(owner)?.targetContinuePositions ?? [];
      for (const [finallyBlock, pathPrefixes] of prefixesByFinally) {
        for (const throwStatement of throwsByFinallyBlock.get(finallyBlock) ?? []) {
          if (!nodeIsReachableFromBoundaryEntry(throwStatement, finallyBlock)) continue;
          const catchClause = enclosingCatchBeforeTarget(throwStatement, owner);
          if (!catchClause || syntaxContains(finallyBlock, catchClause)) continue;
          const catchBlock = catchClause.block;
          if (catchDefinitelyLeavesTarget(catchBlock, owner as ts.IterationStatement)) continue;
          const position = throwStatement.getStart(sourceFile);
          const catchPositionSets = positionSetsByCatch.get(catchBlock) ?? new Map<string, Set<number>>();
          for (const prefix of pathPrefixes) {
            addPositionSet(allPositionSetsByPath, prefix, position);
            addPositionSet(catchPositionSets, prefix, position);
          }
          positionSetsByCatch.set(catchBlock, catchPositionSets);
        }
      }
      const catchesByPath = new Map<string, CaughtCompletionSummary[]>();
      for (const [catchBlock, positionSets] of positionSetsByCatch) {
        const summary: CaughtCompletionSummary = {
          block: catchBlock,
          catchPath: controlPathMetadata(controlPathByNode.get(catchBlock) ?? []).key,
          catchEnd: catchBlock.end,
          targetContinuePosition: firstPositionAfter(targetPositions, catchBlock.getStart(sourceFile)),
          blockerPositionsByAncestorPath: sortedPositionArrays(positionSets)
        };
        const catchSummaries = catchesByPath.get(summary.catchPath) ?? [];
        catchSummaries.push(summary);
        catchesByPath.set(summary.catchPath, catchSummaries);
      }
      summariesByOwner.set(owner, {
        allBlockerPositionsByAncestorPath: sortedPositionArrays(allPositionSetsByPath),
        catchesByPath
      });
    }
    caughtCompletionSummariesByContext.set(context, summariesByOwner);
  }
  const positionIsInRanges = (
    ranges: readonly NativeSpellcheckRange[] | undefined,
    position: number
  ): boolean => {
    if (!ranges) return false;
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].start <= position) low = middle + 1;
      else high = middle;
    }
    const candidate = ranges[low - 1];
    return Boolean(candidate && position < candidate.end);
  };
  const firstPositionAfterExcluding = (
    positions: readonly number[] | undefined,
    after: number,
    excluded: ReadonlySet<number> | undefined
  ): number => {
    if (!positions) return Number.POSITIVE_INFINITY;
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] <= after) low = middle + 1;
      else high = middle;
    }
    while (low < positions.length && excluded?.has(positions[low])) low += 1;
    return positions[low] ?? Number.POSITIVE_INFINITY;
  };

  for (const binding of bindings) {
    const stableConstDom = binding.kind === 'const' && binding.events.length > 0 &&
      binding.events.every((event) => event.dom);
    const capturedMutableDom = binding.kind !== 'const' && binding.events.length > 0 &&
      binding.events.every((event) => event.dom);
    const loopEntryEventsByContext = new Map<Scope, Map<ts.Node, Map<string, BindingEvent>>>();
    const catchRootEventsByContext = new Map<
      Scope,
      Map<ts.Node, Map<ts.Block, { readonly event: BindingEvent; readonly summary: CaughtCompletionSummary }>>
    >();
    for (const event of binding.events) {
      for (const frame of event.controlPath) {
        if (frame.branch !== 'loop') continue;
        if (frame.owner === binding.iterationResetLoop) continue;
        let loopEvents = loopEntryEventsByContext.get(event.context);
        if (!loopEvents) {
          loopEvents = new Map();
          loopEntryEventsByContext.set(event.context, loopEvents);
        }
        const latestByPath = loopEvents.get(frame.owner) ?? new Map<string, BindingEvent>();
        const catchSummaries = caughtCompletionSummariesByContext.get(event.context)?.get(frame.owner)
          ?.catchesByPath.get(event.pathKey);
        if (catchSummaries) {
          for (const catchSummary of catchSummaries) {
            if (!syntaxContains(catchSummary.block, event.node)) continue;
            let catchEventsByOwner = catchRootEventsByContext.get(event.context);
            if (!catchEventsByOwner) {
              catchEventsByOwner = new Map();
              catchRootEventsByContext.set(event.context, catchEventsByOwner);
            }
            const catchEvents = catchEventsByOwner.get(frame.owner) ?? new Map();
            catchEvents.set(catchSummary.block, { event, summary: catchSummary });
            catchEventsByOwner.set(frame.owner, catchEvents);
          }
        }
        const continueSummary = continueSummariesByContext.get(event.context)?.get(frame.owner);
        const pathDoesNotReachBackedge = event.pathPrefixes.some((prefix) => (
          continueSummary?.noBackedgePathKeys.has(prefix)
        ));
        if (pathDoesNotReachBackedge) continue;
        const unreachableAfterContinue = event.pathPrefixes.some((prefix) => (
          positionIsInRanges(continueSummary?.unreachableRangesByPath.get(prefix), event.position)
        ));
        if (unreachableAfterContinue) continue;
        latestByPath.set(event.pathKey, event);
        loopEvents.set(frame.owner, latestByPath);
      }
    }
    const ignoredCaughtPositionsByContext = new Map<Scope, Map<ts.Node, Map<string, Set<number>>>>();
    for (const [context, catchEventsByOwner] of catchRootEventsByContext) {
      const ignoredByOwner = new Map<ts.Node, Map<string, Set<number>>>();
      for (const [owner, catchEvents] of catchEventsByOwner) {
        const ignoredByPath = new Map<string, Set<number>>();
        for (const { event, summary } of catchEvents.values()) {
          const catchRecoversDom = event.dom &&
            event.position < summary.catchEnd &&
            event.position < summary.targetContinuePosition;
          if (!catchRecoversDom) continue;
          for (const [path, positions] of summary.blockerPositionsByAncestorPath) {
            const ignored = ignoredByPath.get(path) ?? new Set<number>();
            for (const position of positions) ignored.add(position);
            ignoredByPath.set(path, ignored);
          }
        }
        ignoredByOwner.set(owner, ignoredByPath);
      }
      ignoredCaughtPositionsByContext.set(context, ignoredByOwner);
    }
    const loopEntryNonDomByContext = new Map<Scope, Map<ts.Node, boolean>>();
    for (const [context, loopEvents] of loopEntryEventsByContext) {
      const nonDomByLoop = new Map<ts.Node, boolean>();
      for (const [owner, latestByPath] of loopEvents) {
        let possibleNonDom = false;
        for (const event of latestByPath.values()) {
          if (event.dom) continue;
          const killedByLaterAncestorDom = event.pathPrefixes.some((prefix) => {
            const later = latestByPath.get(prefix);
            if (!later?.dom || later.position <= event.position) return false;
            const positions = continueSummariesByContext.get(context)?.get(owner)
              ?.blockerPositionsByAncestorPath.get(event.pathKey);
            const caughtPositions = caughtCompletionSummariesByContext.get(context)?.get(owner)
              ?.allBlockerPositionsByAncestorPath.get(event.pathKey);
            const ignoredCaughtPositions = ignoredCaughtPositionsByContext.get(context)?.get(owner)
              ?.get(event.pathKey);
            return firstPositionAfter(positions, event.position) >= later.position &&
              firstPositionAfterExcluding(
                caughtPositions,
                event.position,
                ignoredCaughtPositions
              ) >= later.position;
          });
          if (!killedByLaterAncestorDom) {
            possibleNonDom = true;
            break;
          }
        }
        nonDomByLoop.set(owner, possibleNonDom);
      }
      loopEntryNonDomByContext.set(context, nonDomByLoop);
    }
    const flowByContext = new Map<Scope, {
      readonly latestByPath: Map<string, BindingEvent>;
      latestPossibleNonDom: BindingEvent | null;
    }>();
    let eventIndex = 0;
    for (const use of binding.uses) {
      while (eventIndex < binding.events.length && binding.events[eventIndex].position <= use.position) {
        const event = binding.events[eventIndex];
        let flow = flowByContext.get(event.context);
        if (!flow) {
          flow = { latestByPath: new Map(), latestPossibleNonDom: null };
          flowByContext.set(event.context, flow);
        }
        flow.latestByPath.set(event.pathKey, event);
        if (!event.dom) flow.latestPossibleNonDom = event;
        eventIndex += 1;
      }
      const flow = flowByContext.get(use.context);
      let definiteEvent: BindingEvent | undefined;
      for (const key of use.pathPrefixes) {
        const candidate = flow?.latestByPath.get(key);
        if (candidate && (!definiteEvent || candidate.position > definiteEvent.position)) {
          definiteEvent = candidate;
        }
      }
      const possibleNonDomAfterDefinite = flow?.latestPossibleNonDom &&
        (!definiteEvent || flow.latestPossibleNonDom.position > definiteEvent.position);
      const loopCarriedNonDom = use.controlPath.some((frame) => {
        if (frame.branch !== 'loop') return false;
        const possibleEntryNonDom = loopEntryNonDomByContext.get(use.context)?.get(frame.owner);
        if (!possibleEntryNonDom) return false;
        const killedInCurrentIteration = definiteEvent?.dom === true &&
          definiteEvent.controlPath.some((eventFrame) => (
            eventFrame.branch === 'loop' && eventFrame.owner === frame.owner
          ));
        return !killedInCurrentIteration;
      });
      const sameContextDom = definiteEvent?.dom === true &&
        !possibleNonDomAfterDefinite &&
        !loopCarriedNonDom;
      const captured = use.context !== binding.declarationContext;
      const allowed = sameContextDom || (captured && (stableConstDom || capturedMutableDom));
      if (allowed) ranges.push(use.range);
    }
  }
  return ranges;
};

const stripNativeSpellcheckSyntax = (text: string, path: string): string => {
  const ranges = [
    ...nativeHtmlSpellcheckRanges(text),
    ...nativeDomSpellcheckRanges(text, path)
  ];
  const setAttributePattern = /\.setAttribute\(\s*(["'])spellcheck\1\s*,\s*(?:(["'])(?:true|false)\2|(?:true|false))\s*\)/gi;
  for (const match of text.matchAll(setAttributePattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const chars = text.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
};
const hasRemovedSpellDiagnosticCapability = (text: string, path: string): boolean => {
  if (/cspell|proofread(?:er|ing)?/i.test(text)) return true;
  if (/^src\/protocol\/.*diagnostic[-_. ]?suggestions?/i.test(path)) return true;
  const words = normalizeCapabilityWords(text);
  const isProtocolPath = /^src\/protocol\//i.test(path);
  for (let start = 0; start < words.length; start += 1) {
    const window = words.slice(start, start + 6);
    const wordSet = new Set(window);
    const hasSuggestion = window.some((word) => /^suggest(?:ion|ions|ed|ing)?$/.test(word));
    const hasCorrection = window.some((word) => /^correction(?:s)?$/.test(word));
    const hasDiagnostic = window.some((word) => /^diagnostic(?:s)?$/.test(word));
    const hasSpelling = window.some((word) => /^(?:spell|spelling|typo|typos)$/.test(word));
    const hasSingleWordSpellcheck = wordSet.has('spellcheck');
    const hasChecker = window.some((word) => /^checker(?:s)?$/.test(word));
    const hasQuickFix = wordSet.has('quick') && (wordSet.has('fix') || wordSet.has('fixes'));
    const hasCapabilityContext = window.some((word) => /^(?:adapter|application|cache|collection|command|config|configuration|controller|decoder|disabled|enabled|event|lifecycle|menu|message|options|preferences|protocol|request|response|result|runtime|setting|settings|toggle|transport|ui|view)$/.test(word));
    const hasCapabilityAction = window.some((word) => /^(?:apply|collect|create|decode|disable|enable|request|set|show|toggle)$/.test(word));
    const hasMEOOwner = wordSet.has('meo');
    const hasBuiltInOwner = wordSet.has('built') && wordSet.has('in');
    const hasSpellCheck = hasSpelling && wordSet.has('check');
    if (
      hasSingleWordSpellcheck ||
      (hasDiagnostic && hasSuggestion && (isProtocolPath || hasCapabilityContext || hasCapabilityAction)) ||
      (hasDiagnostic && hasQuickFix && (hasCapabilityContext || hasCapabilityAction)) ||
      (hasSpellCheck && (hasCapabilityContext || hasCapabilityAction || hasMEOOwner || hasBuiltInOwner)) ||
      (hasSpelling && (hasSuggestion || hasQuickFix || hasCorrection || hasChecker)) ||
      (hasSpelling && hasDiagnostic && (hasCapabilityContext || hasCapabilityAction || hasMEOOwner || hasBuiltInOwner))
    ) {
      return true;
    }
  }
  return false;
};
for (const path of spellDiagnosticScope) {
  const lines = stripNativeSpellcheckSyntax(readTrackedProjectFile(path), path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (hasRemovedSpellDiagnosticCapability(lines[index], path)) {
      failures.push(`ARCH015 已删除的 MEO 拼写检查或诊断建议能力重新出现: ${path}:${index + 1}`);
    }
  }
}

// Product deletion guard: embedded Vim/Vi mode and editor-integration capabilities must stay absent.
// Historical changelogs and ordinary references to using Vim remain valid documentation.
const vimCapabilityScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path) ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
const removedVimIntegrationTokens = [
  /(?:@replit\/)?codemirror[-_. /]?vim/i,
  /vscodevim\.vim/i,
  /asvetliakov\.vscode[-_.]?neovim/i,
  /cm[-_. ]?vim[-_. ]?panel/i,
  /\b(?:apply|disable|enable|set|sync|toggle)(?:Vi|Vim)(?:\b|[A-Z0-9_])/,
  /\b(?:apply|disable|enable|set|sync|toggle)[-_.](?:vi|vim)\b/i,
  /\b(?:vi|vim)[-_.](?:disabled|enabled)\b/i
];
type VimCapabilitySurface = 'source' | 'package' | 'documentation';
const vimPackageCapabilityKey = /["'][^"']*(?:vi|vim)(?:[-_.]?(?:active|behavior|config|configuration|disabled|emulation|enabled|integration|keybinding|keybindings|leader|map|mapping|mappings|mode|panel|setting|settings|state))[^"']*["']\s*:/i;
const hasRemovedVimCapability = (text: string, surface: VimCapabilitySurface): boolean => {
  if (removedVimIntegrationTokens.some((pattern) => pattern.test(text))) return true;
  if (surface === 'package') return vimPackageCapabilityKey.test(text);
  const words = normalizeCapabilityWords(text);
  for (let start = 0; start < words.length; start += 1) {
    const window = words.slice(start, start + 8);
    const wordSet = new Set(window);
    if (!wordSet.has('vim') && !wordSet.has('vi')) continue;
    const hasExplicitCapabilityNoun = window.some((word) => (
      /^(?:emulation|integration|keybinding|keybindings|leader|map|mapping|mappings|mode|panel)$/.test(word)
    ));
    const hasStateNoun = window.some((word) => (
      /^(?:active|behavior|config|configuration|disabled|enabled|setting|settings|state)$/.test(word)
    ));
    if (!hasExplicitCapabilityNoun && !hasStateNoun) continue;
    if (surface === 'source') return true;
    const hasProductOwner = window.some((word) => (
      /^(?:meo|meoenhanced|source|live|toolbar)$/.test(word)
    ));
    const hasEmbeddedProductAction = window.some((word) => (
      /^(?:control|controls|disable|enable|embedded|toggle)$/.test(word)
    ));
    if (hasProductOwner || hasEmbeddedProductAction) return true;
  }
  return false;
};
for (const path of vimCapabilityScope) {
  const surface: VimCapabilitySurface = /^README(?:\.[^/]+)?\.md$/i.test(path) || /^docs\/.*\.md$/i.test(path)
    ? 'documentation'
    : path === 'package.json' || /^(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path)
      ? 'package'
      : 'source';
  if (surface === 'source' && hasRemovedVimCapability(path, surface)) {
    failures.push(`ARCH016 已删除的 Vim 模式或编辑器集成能力重新出现: ${path}:1`);
    continue;
  }
  const lines = readTrackedProjectFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (hasRemovedVimCapability(lines[index], surface)) {
      failures.push(`ARCH016 已删除的 Vim 模式或编辑器集成能力重新出现: ${path}:${index + 1}`);
    }
  }
}

// Product deletion guard: Emoji shortcode conversion and product-owned selectors must stay absent.
// Unicode emoji, ordinary text mentioning emoji and transitive emoji-regex dependencies remain supported.
const emojiShortcodeCapabilityScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path) ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
const removedEmojiShortcodeTokens = [
  /markdown-it-emoji/i,
  /(?:node[-_. /]?emoji|emoji[-_. /]?(?:toolkit|shortcodes?))/i,
  /\b(?:collect|convert|decorate|expand|parse|render|replace|resolve|scan)(?:EmojiShortcode|EmojiRanges?)(?:\b|[A-Z0-9_])/,
  /\b(?:collect|convert|decorate|expand|parse|render|replace|resolve|scan)[-_.](?:emoji[-_.])?(?:shortcodes?|ranges?)\b/i,
  /\b(?:EmojiShortcode|EmojiRange|EmojiWidget|EmojiDecoration|EmojiSelector|EmojiPicker|EmojiPalette|EmojiMenu|EmojiChooser)(?:\b|[A-Z0-9_])/,
  /\b(?:emojiShortcode|emojiWidget|emojiDecoration|emojiSelector|emojiPicker|emojiPalette|emojiMenu|emojiChooser)(?:\b|[A-Z0-9_])/,
  /\b(?:open|show|toggle|select|insert)(?:EmojiSelector|EmojiPicker|EmojiPalette|EmojiMenu|EmojiChooser|EmojiShortcode)(?:\b|[A-Z0-9_])/,
  /\b(?:open|show|toggle|select|insert)[-_.]emoji[-_.](?:selector|picker|palette|menu|chooser|shortcode)\b/i,
  /meo-[A-Za-z0-9_-]*emoji[A-Za-z0-9_-]*(?:shortcode|widget|selector|picker|palette|menu|chooser)?/i
];
const emojiShortcodeSettingKey = /["'][^"']*emoji[-_.]?(?:shortcode|conversion|selector|picker|palette|menu|chooser|enabled|setting)[^"']*["']\s*:/i;
const directEmojiRegexDependency = /["']emoji-regex["']\s*:/i;
const bunRootEmojiRegexDependency = /^\s*["']emoji-regex["']\s*:\s*["'][^"']+["']\s*,?\s*$/i;
const hasRemovedEmojiShortcodeCapability = (text: string, path: string): boolean => {
  if (path === 'package.json' && /^\s*"test(?::[^"]*)?"\s*:/.test(text)) return false;
  if (/^(?:src|webview\/src)\//.test(path) && /\bemoji-regex\b/i.test(text)) return true;
  if (path === 'package.json' && directEmojiRegexDependency.test(text)) return true;
  if (/^bun\.lockb?$/i.test(path) && bunRootEmojiRegexDependency.test(text)) return true;
  if (removedEmojiShortcodeTokens.some((pattern) => pattern.test(text))) return true;
  if (path === 'package.json' && emojiShortcodeSettingKey.test(text)) return true;
  const words = normalizeCapabilityWords(text);
  for (let start = 0; start < words.length; start += 1) {
    const window = words.slice(start, start + 9);
    const wordSet = new Set(window);
    if (!wordSet.has('emoji')) continue;
    const hasShortcodeConversion = wordSet.has('shortcode') || wordSet.has('shortcodes')
      ? ['convert', 'conversion', 'expand', 'parse', 'render', 'replace', 'transform']
        .some((word) => wordSet.has(word))
      : false;
    const hasSelector = ['selector', 'picker', 'palette', 'menu', 'chooser']
      .some((word) => wordSet.has(word));
    const hasProductAction = ['choose', 'insert', 'open', 'select', 'show', 'toggle']
      .some((word) => wordSet.has(word));
    if (hasShortcodeConversion || (hasSelector && hasProductAction)) return true;
  }
  return false;
};
for (const path of emojiShortcodeCapabilityScope) {
  if (/^(?:src|webview\/src)\//.test(path) && hasRemovedEmojiShortcodeCapability(path, path)) {
    failures.push(`ARCH017 已删除的 Emoji shortcode 转换或选择器重新出现: ${path}:1`);
    continue;
  }
  const lines = readTrackedProjectFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (hasRemovedEmojiShortcodeCapability(lines[index], path)) {
      failures.push(`ARCH017 已删除的 Emoji shortcode 转换或选择器重新出现: ${path}:${index + 1}`);
    }
  }
}

// Product deletion guard: Mermaid is supported only through standard fenced code blocks.
// Ordinary colon text and standard Mermaid language/rendering owners remain valid.
const mermaidColonCapabilityScope = projectFilesForCapabilityGuard().filter((path) => (
  path === 'package.json' ||
  /^README(?:\.[^/]+)?\.md$/i.test(path) ||
  /^docs\/.*\.md$/i.test(path) ||
  /^(?:src|webview\/src)\/.*\.(?:ts|tsx|css|json|md|html)$/i.test(path)
));
const removedMermaidColonTokens = [
  /:::mermaid\b/i,
  /\b(?:MermaidColon|ColonMermaid)(?:Block|Blocks|Container|Containers|Decoration|Decorations|Fence|Fences|Range|Ranges|Syntax)?(?:\b|[A-Z0-9_])/,
  /\b(?:mermaidColon|colonMermaid)(?:Block|Blocks|Container|Containers|Decoration|Decorations|Fence|Fences|Range|Ranges|Syntax)?(?:\b|[A-Z0-9_])/,
  /\b(?:collect|detect|get|normalize|parse|render|scan)(?:MermaidColon|ColonMermaid)(?:Block|Blocks|Container|Containers|Fence|Fences|Range|Ranges|Syntax)?(?:\b|[A-Z0-9_])/,
  /\b(?:collect|detect|get|normalize|parse|render|scan)[-_.](?:mermaid[-_.]colon|colon[-_.]mermaid)(?:[-_.](?:blocks?|containers?|fences?|ranges?|syntax))?\b/i,
  /meo-[A-Za-z0-9_-]*colon[-_]?fence[A-Za-z0-9_-]*/i
];
const hasRemovedMermaidColonCapability = (text: string, path: string): boolean => {
  if (path === 'package.json' && /^\s*"test(?::[^"]*)?"\s*:/.test(text)) return false;
  if (removedMermaidColonTokens.some((pattern) => pattern.test(text))) return true;
  const words = normalizeCapabilityWords(text);
  for (let start = 0; start < words.length; start += 1) {
    const window = words.slice(start, start + 10);
    const wordSet = new Set(window);
    if (!wordSet.has('mermaid') || !wordSet.has('colon')) continue;
    if (window.some((word) => (
      /^(?:block|blocks|cache|container|containers|decoration|decorations|detect|detection|export|fence|fences|host|live|normalize|normalization|parse|parser|preview|protocol|range|ranges|render|renderer|setting|settings|source|syntax)$/.test(word)
    ))) return true;
  }
  return false;
};
for (const path of mermaidColonCapabilityScope) {
  if (/^(?:src|webview\/src)\//.test(path) && hasRemovedMermaidColonCapability(path, path)) {
    failures.push(`ARCH018 已删除的 Mermaid colon fence 语法重新出现: ${path}:1`);
    continue;
  }
  const lines = readTrackedProjectFile(path).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (hasRemovedMermaidColonCapability(lines[index], path)) {
      failures.push(`ARCH018 已删除的 Mermaid colon fence 语法重新出现: ${path}:${index + 1}`);
    }
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
