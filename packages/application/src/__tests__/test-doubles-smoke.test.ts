import { describe, expect, it } from 'vitest';
import {
  FakeRepositoryPort,
  FakeJobQueuePort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
  FakeGitHubPort,
  FakeGitPort,
  FakeValidationPort,
  FakeArtifactStore,
  FakeAgentPort,
  FakeFixDiffInspector,
  makeFixDiffInspector,
} from '../test-doubles/index.js';

describe('test-doubles barrel', () => {
  it('every fake instantiates', () => {
    const repos = new FakeRepositoryPort([]);
    const registry = new FakeWorkerRegistryPort();
    expect(new FakeJobQueuePort(repos)).toBeDefined();
    expect(new FakeWorkerLeasePort(registry)).toBeDefined();
    expect(new FakeGitHubPort()).toBeDefined();
    expect(new FakeGitPort()).toBeDefined();
    expect(new FakeValidationPort()).toBeDefined();
    expect(new FakeArtifactStore()).toBeDefined();
    expect(new FakeAgentPort()).toBeDefined();
    expect(new FakeFixDiffInspector()).toBeDefined();
    expect(makeFixDiffInspector(new FakeFixDiffInspector())).toBeDefined();
  });
});
