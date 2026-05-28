export interface ClassifierEvent {
  phase?: string;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ClassifyExitInput {
  exitCode: number;
  combinedLogTail: string;
  runUuid: string;
  artifacts?: string[];
  detectedAt?: Date;
  /** Optional structured event stream from the wrapped run. When provided
   *  and a terminal event exists, the classifier prefers events over
   *  log scraping. */
  events?: ClassifierEvent[];
  invocation?: {
    outcome: 'success' | 'failed' | 'timeout' | 'contract_violation';
    stderrContent?: string;
    contractViolations?: string[];
  };
}
