import type {
  SignatureReferenceAnalysis,
  SignatureReferenceAnalyzerInput,
  SignatureReferenceAnalyzerPort,
  SignatureReferenceKind,
  SignatureReferenceLocation,
} from '@ai-sdlc/application/ports';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.vitest',
  '.turbo',
  '.next',
  '.output',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.pytest_cache',
  'temp',
  '.git',
  '.ai-orchestrator',
  '.ai-worktrees',
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function canonicalizePath(path: string, cache: Map<string, string>): string {
  const normalized = normalizePath(path);
  if (cache.has(normalized)) {
    return cache.get(normalized)!;
  }

  let canonical = normalized;

  if (ts.sys.realpath) {
    try {
      canonical = normalizePath(ts.sys.realpath(normalized));
    } catch {
      canonical = normalized;
    }
  }

  canonical = ts.sys.useCaseSensitiveFileNames ? canonical : canonical.toLowerCase();
  cache.set(normalized, canonical);
  return canonical;
}

function relativeToRoot(
  root: string,
  filePath: string,
  canonicalize: (path: string) => string,
): string {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);
  if (normalizedFile.startsWith(normalizedRoot + '/')) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  const canonicalRoot = canonicalize(root);
  const canonicalFile = canonicalize(filePath);
  if (canonicalFile.startsWith(canonicalRoot + '/')) {
    return canonicalFile.slice(canonicalRoot.length + 1);
  }
  if (canonicalFile === canonicalize(normalizedFile)) {
    return filePath;
  }
  return canonicalFile;
}

function isExcludedPath(
  path: string,
  root: string,
  canonicalize: (path: string) => string,
): boolean {
  const rel = relativeToRoot(root, path, canonicalize);
  const parts = rel.split('/');
  return parts.some((part) => EXCLUDED_DIRS.has(part));
}

function discoverSourceFiles(root: string, canonicalize: (path: string) => string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = ts.sys.readDirectory(dir, [...SUPPORTED_EXTENSIONS], ['node_modules', '.git']);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = normalizePath(entry);
      if (isExcludedPath(fullPath, root, canonicalize)) continue;

      if (ts.sys.fileExists?.(fullPath)) {
        const ext = fullPath.slice(fullPath.lastIndexOf('.'));
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(root);
  return files;
}

function getPathMappings(
  root: string,
  canonicalize: (path: string) => string,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};

  function scan(dir: string) {
    if (isExcludedPath(dir, root, canonicalize)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    let hasPackageJson = false;
    for (const entry of entries) {
      if (entry === 'package.json') {
        hasPackageJson = true;
        break;
      }
    }

    if (hasPackageJson) {
      try {
        const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkgJson.name) {
          const relDir = relativeToRoot(root, dir, canonicalize);
          const srcDir = join(dir, 'src');
          let targetPath = relDir;
          try {
            if (statSync(srcDir).isDirectory()) {
              targetPath = join(relDir, 'src');
            }
          } catch {}

          paths[pkgJson.name] = [join(targetPath, 'index.ts'), targetPath];
          paths[`${pkgJson.name}/*`] = [join(targetPath, '*')];
        }
      } catch {}
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          scan(fullPath);
        }
      } catch {}
    }
  }

  scan(root);
  return paths;
}
function createLanguageServiceHost(
  root: string,
  files: string[],
  canonicalize: (path: string) => string,
): ts.LanguageServiceHost {
  const compilerOptions = getCompilerOptions(root, canonicalize);
  const snapCache = new Map<string, ts.IScriptSnapshot>();

  return {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => files,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      if (!snapCache.has(fileName)) {
        const content = ts.sys.readFile?.(fileName);
        if (content === undefined) return undefined;
        snapCache.set(fileName, ts.ScriptSnapshot.fromString(content));
      }
      return snapCache.get(fileName);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames ?? true,
    readFile: (path) => ts.sys.readFile?.(path),
    fileExists: (path) => ts.sys.fileExists?.(path) ?? false,
    directoryExists: (dirName) => ts.sys.directoryExists?.(dirName) ?? false,
    getDirectories: (dir) => ts.sys.getDirectories?.(dir) ?? [],
    getNewLine: () => ts.sys.newLine ?? '\n',
    readDirectory: (path, extensions, excludes, includes, depth) =>
      ts.sys.readDirectory?.(path, extensions, excludes, includes, depth) ?? [],
  };
}

function getCompilerOptions(
  root: string,
  canonicalize: (path: string) => string,
): ts.CompilerOptions {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {};
  if (configPath) {
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
  } else {
    options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
    };
  }

  options.baseUrl = root;
  options.paths = {
    ...options.paths,
    ...getPathMappings(root, canonicalize),
  };

  return options;
}

function getDeclarationLocation(
  symbol: ts.Symbol,
): { file: string; line: number; column: number } | undefined {
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return undefined;

  const decl = declarations[0]!;
  const sourceFile = decl.getSourceFile();
  if (!sourceFile) return undefined;
  const pos = decl.getStart();
  const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, pos);

  return {
    file: sourceFile.fileName,
    line: line + 1,
    column: character + 1,
  };
}

function findSymbol(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  symbolName: string,
): { symbol: ts.Symbol; pos: number } | undefined {
  const checker = program.getTypeChecker();

  if (symbolName.includes('.')) {
    const parts = symbolName.split('.');
    const ownerName = parts[0]!;
    const memberName = parts[1]!;
    return findQualifiedMember(program, sourceFile, ownerName, memberName);
  }

  function checkStatement(statement: ts.Statement): { symbol: ts.Symbol; pos: number } | undefined {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && statement.name.text === symbolName) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) {
          return { symbol, pos: statement.name.getStart() };
        }
      }
      return undefined;
    }

    if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name && statement.name.text === symbolName) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) {
          return { symbol, pos: statement.name.getStart() };
        }
      }
      return undefined;
    }

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          const symbol = checker.getSymbolAtLocation(decl.name);
          if (symbol) {
            return { symbol, pos: decl.name.getStart() };
          }
        }
      }
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const spec of statement.exportClause.elements) {
          if (spec.name.text === symbolName) {
            const target = spec.propertyName ?? spec.name;
            const symbol = checker.getSymbolAtLocation(target);
            if (symbol) {
              const resolved =
                symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
              return { symbol: resolved, pos: target.getStart() };
            }
          }
        }
      }
    }

    return undefined;
  }

  for (const statement of sourceFile.statements) {
    const result = checkStatement(statement);
    if (result) return result;
  }

  return undefined;
}

function findQualifiedMember(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  ownerName: string,
  memberName: string,
): { symbol: ts.Symbol; pos: number } | undefined {
  const checker = program.getTypeChecker();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isClassDeclaration(statement)
    ) {
      continue;
    }

    if (statement.name!.text !== ownerName) continue;

    const ownerSymbol = checker.getSymbolAtLocation(statement.name!);
    if (!ownerSymbol) continue;

    const ownerType = checker.getDeclaredTypeOfSymbol(ownerSymbol);
    const memberSymbol = ownerType.getProperty(memberName);

    if (memberSymbol) {
      const decls = memberSymbol.getDeclarations();
      if (decls && decls.length > 0) {
        const firstDecl = decls[0]!;
        let identPos = firstDecl.getStart();
        ts.forEachChild(firstDecl, (node) => {
          if (ts.isIdentifier(node)) {
            identPos = node.getStart();
          }
        });
        return { symbol: memberSymbol, pos: identPos };
      }
    }
  }

  return undefined;
}

function isImportOrExportReference(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isImportDeclaration(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isExportDeclaration(parent)
  );
}

function isTypeReference(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isTypeReferenceNode(parent);
}

function isBindingPatternNode(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isArrayBindingPattern(parent) || ts.isObjectBindingPattern(parent);
}

function classifyKind(
  node: ts.Node,
  _declFile: string,
  _refFile: string,
): SignatureReferenceKind | null {
  const parent = node.parent;

  if (ts.isCallExpression(parent) && parent.expression === node) return 'call';
  if (ts.isNewExpression(parent) && parent.expression === node) return 'construct';

  if (ts.isDecorator(parent) && parent.expression === node) return 'value';
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const grandparent = parent.parent;
    if (ts.isCallExpression(grandparent) && grandparent.expression === parent) {
      return 'call';
    }
    return 'value';
  }

  if (
    ts.isBinaryExpression(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isYieldExpression(parent) ||
    ts.isThrowStatement(parent)
  ) {
    return 'value';
  }

  if (
    isBindingPatternNode(node) ||
    isTypeReference(node) ||
    isImportOrExportReference(node) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent)
  ) {
    return null;
  }

  return 'value';
}

function collectReferences(
  languageService: ts.LanguageService,
  program: ts.Program,
  symbol: ts.Symbol,
  fileName: string,
  pos: number,
  root: string,
  canonicalize: (path: string) => string,
): SignatureReferenceLocation[] {
  const references: SignatureReferenceLocation[] = [];

  const refs = languageService.findReferences(fileName, pos);
  if (!refs) return [];

  for (const ref of refs) {
    for (const entry of ref.references) {
      if (entry.isDefinition) continue;

      const entryFileName = normalizePath(entry.fileName);

      if (isExcludedPath(entryFileName, root, canonicalize)) continue;

      const sourceFile = program.getSourceFile(entryFileName);
      if (!sourceFile) continue;

      const entryStart = entry.textSpan.start;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = (ts as any).getTokenAtPosition(sourceFile, entryStart);
      const kind = classifyKind(node, fileName, entryFileName);
      if (!kind) continue;

      const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, entryStart);

      references.push({
        file: relativeToRoot(root, entryFileName, canonicalize),
        line: line + 1,
        column: character + 1,
        kind,
      });
    }
  }

  const seen = new Set<string>();
  const deduped: SignatureReferenceLocation[] = [];
  for (const ref of references) {
    const key = `${ref.file}:${ref.line}:${ref.column}:${ref.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ref);
    }
  }

  deduped.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.kind.localeCompare(b.kind);
  });

  return deduped;
}

export function createSignatureReferenceAnalyzer(): SignatureReferenceAnalyzerPort {
  return {
    async analyze(input: SignatureReferenceAnalyzerInput): Promise<SignatureReferenceAnalysis[]> {
      const { worktreeRoot, changes } = input;

      let root: string;
      try {
        statSync(worktreeRoot);
        root = worktreeRoot;
      } catch {
        return changes.map((change) => ({
          change,
          references: [],
          unresolvedDiagnostic: `Worktree root does not exist: ${worktreeRoot}`,
        }));
      }

      const canonicalPathCache = new Map<string, string>();
      const canonicalize = (path: string) => canonicalizePath(path, canonicalPathCache);

      const sourceFiles = discoverSourceFiles(root, canonicalize);
      if (sourceFiles.length === 0) {
        return changes.map((change) => ({
          change,
          references: [],
          unresolvedDiagnostic: `No TypeScript source files found in: ${root}`,
        }));
      }

      const host = createLanguageServiceHost(root, sourceFiles, canonicalize);
      const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
      const program = languageService.getProgram();
      if (!program) {
        return changes.map((change) => ({
          change,
          references: [],
          unresolvedDiagnostic: `Could not create TypeScript program`,
        }));
      }

      let canonicalSourceFiles: Map<string, ts.SourceFile> | undefined;

      const results: SignatureReferenceAnalysis[] = [];

      for (const change of changes) {
        const normalizedFile = normalizePath(change.declarationFile);
        let fullPath: string;

        if (normalizedFile.startsWith('/') || /^[A-Za-z]:/.test(normalizedFile)) {
          fullPath = normalizedFile;
        } else {
          fullPath = normalizePath(`${root}/${normalizedFile}`);
        }

        let resolvedPath: string | undefined;
        for (const candidate of [
          fullPath,
          fullPath + '.ts',
          fullPath + '.tsx',
          fullPath + '.js',
          fullPath + '.jsx',
        ]) {
          if (ts.sys.fileExists?.(candidate)) {
            resolvedPath = candidate;
            break;
          }
        }

        if (!resolvedPath) {
          results.push({
            change,
            references: [],
            unresolvedDiagnostic: `Declaration file not found: ${change.declarationFile}`,
          });
          continue;
        }

        let sourceFile = program.getSourceFile(resolvedPath);
        if (!sourceFile) {
          canonicalSourceFiles ??= new Map(
            program.getSourceFiles().map((file) => [canonicalize(file.fileName), file]),
          );
          sourceFile = canonicalSourceFiles.get(canonicalize(resolvedPath));
        }
        if (!sourceFile) {
          results.push({
            change,
            references: [],
            unresolvedDiagnostic: `Could not load source file: ${change.declarationFile}`,
          });
          continue;
        }

        const symbolInfo = findSymbol(program, sourceFile, change.symbol);
        if (!symbolInfo) {
          results.push({
            change,
            references: [],
            unresolvedDiagnostic: `Could not resolve symbol '${change.symbol}' in: ${change.declarationFile}`,
          });
          continue;
        }

        const { symbol, pos } = symbolInfo;
        const declaration = getDeclarationLocation(symbol);
        const references = collectReferences(
          languageService,
          program,
          symbol,
          sourceFile.fileName,
          pos,
          root,
          canonicalize,
        );

        const result: SignatureReferenceAnalysis = {
          change,
          references,
        };
        if (declaration) {
          result.declaration = {
            file: relativeToRoot(root, normalizePath(declaration.file), canonicalize),
            line: declaration.line,
            column: declaration.column,
          };
        }
        results.push(result);
      }

      return results;
    },
  };
}
