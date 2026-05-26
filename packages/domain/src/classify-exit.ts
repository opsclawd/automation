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
  /** Wall-clock duration of the child process in milliseconds. When provided,
   *  the classifier skips `timeout` classification when the run completed in
   *  under 30 seconds — too fast for any legitimate timeout to have fired. */
  elapsedMs?: number;
}
