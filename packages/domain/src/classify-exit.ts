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
  events?: ClassifierEvent[];
}
