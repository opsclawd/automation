import ts from 'typescript';
import { normalizeTaskPath, declaredTaskFiles } from './task-file-boundaries.js';
import type { TaskManifest } from './results/schemas/task-manifest.js';
import type { GitPort } from './ports/git-port.js';

export interface FindInheritedFormattingDebtInput {
  cwd: string;
  manifest: TaskManifest;
  currentTaskNumber: number;
  completedTaskNumbers: ReadonlySet<number>;
  candidateFiles: readonly string[];
  preStepHead: string;
  postStepHead: string;
  git: Pick<GitPort, 'fileContent'>;
}

type CanonicalNode = {
  kind: ts.SyntaxKind;
  flags: ts.NodeFlags;
  value?: string;
  isTypeOnly?: boolean;
  isExportEquals?: boolean;
  isTypeOf?: boolean;
  hasEscape?: boolean;
  semanticComments?: string[];
  children: CanonicalNode[];
};

function getExtension(filePath: string): string {
  const match = filePath.match(/\.([a-zA-Z0-9]+)$/);
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

function getScriptKind(ext: string): ts.ScriptKind | undefined {
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.json':
      return ts.ScriptKind.JSON;
    default:
      return undefined;
  }
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      if (
        current.parent &&
        ts.isExpressionStatement(current.parent) &&
        (ts.isStringLiteral(current.expression) || ts.isParenthesizedExpression(current.expression))
      ) {
        break;
      }
      current = current.expression;
    } else if (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
    } else {
      break;
    }
  }
  return current;
}

function getLeafValue(node: ts.Node, sourceFile?: ts.SourceFile): string | undefined {
  if (ts.isNumericLiteral(node)) {
    return sourceFile ? node.getText(sourceFile) : node.text;
  }
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  ) {
    return node.text;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return String(node.operator);
  }
  if (ts.isTypeOperatorNode(node)) {
    return String(node.operator);
  }
  if (ts.isHeritageClause(node)) {
    return String(node.token);
  }
  if ('token' in node && typeof (node as { token?: unknown }).token === 'number') {
    return String((node as { token: number }).token);
  }
  return undefined;
}

function hasDirectiveEscape(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (ts.isStringLiteral(node)) {
    try {
      const raw = node.getText(sourceFile);
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw.slice(1, -1) !== node.text;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function getSemanticComments(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const text = sourceFile.text;
  const comments: string[] = [];

  if (node.kind === ts.SyntaxKind.SourceFile && text.startsWith('#!')) {
    const lineEnd = text.indexOf('\n');
    const hashbang = (lineEnd === -1 ? text : text.slice(0, lineEnd)).trim();
    comments.push(hashbang);
  }

  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (ranges) {
    for (const range of ranges) {
      const comment = text.slice(range.pos, range.end).trim();
      if (comment.includes('@ts-') || comment.startsWith('#!')) {
        comments.push(comment);
      }
    }
  }

  return comments;
}

function toCanonicalNode(rawNode: ts.Node, sourceFile: ts.SourceFile): CanonicalNode {
  const node = unwrap(rawNode);
  const children: CanonicalNode[] = [];
  ts.forEachChild(node, (child) => {
    if (child.kind === ts.SyntaxKind.EndOfFileToken) return;
    if (ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) return;
    children.push(toCanonicalNode(child, sourceFile));
  });

  const value = getLeafValue(node, sourceFile);
  const n = node as unknown as {
    isTypeOnly?: boolean;
    isExportEquals?: boolean;
    isTypeOf?: boolean;
  };
  const isTypeOnly = typeof n.isTypeOnly === 'boolean' ? n.isTypeOnly : undefined;
  const isExportEquals = typeof n.isExportEquals === 'boolean' ? n.isExportEquals : undefined;
  const isTypeOf = typeof n.isTypeOf === 'boolean' ? n.isTypeOf : undefined;
  const hasEscape = hasDirectiveEscape(node, sourceFile) ? true : undefined;
  const semanticComments = getSemanticComments(rawNode, sourceFile);

  return {
    kind: node.kind,
    flags: node.flags,
    ...(value !== undefined ? { value } : {}),
    ...(isTypeOnly !== undefined ? { isTypeOnly } : {}),
    ...(isExportEquals !== undefined ? { isExportEquals } : {}),
    ...(isTypeOf !== undefined ? { isTypeOf } : {}),
    ...(hasEscape !== undefined ? { hasEscape } : {}),
    ...(semanticComments.length > 0 ? { semanticComments } : {}),
    children,
  };
}

function areCanonicalNodesEqual(a: CanonicalNode, b: CanonicalNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.flags !== b.flags) return false;
  if (a.value !== b.value) return false;
  if (a.isTypeOnly !== b.isTypeOnly) return false;
  if (a.isExportEquals !== b.isExportEquals) return false;
  if (a.isTypeOf !== b.isTypeOf) return false;
  if (a.hasEscape !== b.hasEscape) return false;
  if ((a.semanticComments?.length ?? 0) !== (b.semanticComments?.length ?? 0)) return false;
  if (a.semanticComments && b.semanticComments) {
    for (let i = 0; i < a.semanticComments.length; i++) {
      if (a.semanticComments[i] !== b.semanticComments[i]) return false;
    }
  }
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    if (!areCanonicalNodesEqual(a.children[i]!, b.children[i]!)) {
      return false;
    }
  }
  return true;
}

function isFormattingOnlyTsJs(
  path: string,
  beforeContent: string,
  afterContent: string,
  scriptKind: ts.ScriptKind,
): boolean {
  try {
    const beforeSf = ts.createSourceFile(
      path,
      beforeContent,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const afterSf = ts.createSourceFile(
      path,
      afterContent,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const beforeDiag = (beforeSf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    const afterDiag = (afterSf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    if ((beforeDiag && beforeDiag.length > 0) || (afterDiag && afterDiag.length > 0)) {
      return false;
    }

    const beforeCanonical = toCanonicalNode(beforeSf, beforeSf);
    const afterCanonical = toCanonicalNode(afterSf, afterSf);
    return areCanonicalNodesEqual(beforeCanonical, afterCanonical);
  } catch {
    return false;
  }
}

export function isFormattingOnlyChange(
  path: string,
  beforeContent: string,
  afterContent: string,
): boolean {
  const ext = getExtension(path);
  const scriptKind = getScriptKind(ext);
  if (scriptKind !== undefined) {
    return isFormattingOnlyTsJs(path, beforeContent, afterContent, scriptKind);
  }
  return false;
}

function isProtectedFilePath(path: string): boolean {
  const norm = normalizeTaskPath(path);
  return norm === '.gitignore' || norm === '.ai-orchestrator.json' || norm.startsWith('.github/');
}

export async function findInheritedFormattingDebtFiles(
  input: FindInheritedFormattingDebtInput,
): Promise<string[]> {
  const ownedFiles = new Set<string>();
  for (const task of input.manifest.tasks) {
    if (task.n < input.currentTaskNumber && input.completedTaskNumbers.has(task.n)) {
      const declared = declaredTaskFiles(task);
      for (const file of declared) {
        ownedFiles.add(normalizeTaskPath(file));
      }
    }
  }

  const exemptFiles: string[] = [];
  for (const candidate of input.candidateFiles) {
    const normPath = normalizeTaskPath(candidate);
    if (!normPath || isProtectedFilePath(normPath)) {
      continue;
    }
    if (!ownedFiles.has(normPath)) {
      continue;
    }

    let beforeContent: string;
    let afterContent: string;
    try {
      beforeContent = await input.git.fileContent(input.cwd, input.preStepHead, normPath);
      afterContent = await input.git.fileContent(input.cwd, input.postStepHead, normPath);
    } catch {
      continue;
    }

    if (isFormattingOnlyChange(normPath, beforeContent, afterContent)) {
      exemptFiles.push(normPath);
    }
  }

  return [...new Set(exemptFiles)].sort();
}
