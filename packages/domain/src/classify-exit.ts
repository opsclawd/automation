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
   *  the classifier skips `timeout` classification when the run was too short
   *  to plausibly have timed out. */
  elapsedMs?: number;
  /** The configured timeout in milliseconds for the invocation. When provided
   *  alongside `elapsedMs`, prevents false-positive timeout classification
   *  for fast failures. */
  timeoutMs?: number;
}
