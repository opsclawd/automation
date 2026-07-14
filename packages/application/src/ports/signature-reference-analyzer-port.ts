export interface DeclaredSignatureChange {
  declarationFile: string;
  symbol: string;
}

export type SignatureReferenceKind = 'call' | 'construct' | 'value';

export interface SignatureReferenceLocation {
  file: string;
  line: number;
  column: number;
  kind: SignatureReferenceKind;
}

export interface SignatureReferenceAnalysis {
  change: DeclaredSignatureChange;
  declaration?: { file: string; line: number; column: number };
  references: SignatureReferenceLocation[];
  unresolvedDiagnostic?: string;
}

export interface SignatureReferenceAnalyzerInput {
  worktreeRoot: string;
  changes: DeclaredSignatureChange[];
}

export interface SignatureReferenceAnalyzerPort {
  analyze(input: SignatureReferenceAnalyzerInput): Promise<SignatureReferenceAnalysis[]>;
}
