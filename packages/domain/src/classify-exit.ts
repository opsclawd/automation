export interface ClassifyExitInput {
  exitCode: number;
  combinedLogTail: string;
  runUuid: string;
  artifacts?: string[];
  detectedAt?: Date;
}
