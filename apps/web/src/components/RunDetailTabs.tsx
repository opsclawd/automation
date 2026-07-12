'use client';

import { useState } from 'react';
import { Tabs } from './Tabs';
import { LiveLogViewer } from './LiveLogViewer';
import { ArtifactViewer } from './ArtifactViewer';
import { ValidationPanel } from './ValidationPanel';
import { PrReviewPanel } from './PrReviewPanel';
import { ReviewFixPanel } from './ReviewFixPanel';
import { TimelineIsland } from './TimelineIsland';
import type { RunDto, FailureDto, ArtifactFile } from '@/lib/api-client';

interface RunDetailTabsProps {
  repositoryId: string;
  run: RunDto;
  failure: FailureDto | null;
  files: ArtifactFile[];
  initialCombinedContent: string;
}

const TAB_ITEMS = [
  { id: 'logs', label: 'Logs' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'validation', label: 'Validation' },
  { id: 'review-fix', label: 'Review/Fix' },
  { id: 'pr-review', label: 'PR Review' },
  { id: 'failure', label: 'Failure' },
  { id: 'timeline', label: 'Timeline' },
];

export function RunDetailTabs({
  repositoryId,
  run,
  failure,
  files,
  initialCombinedContent,
}: RunDetailTabsProps) {
  const [activeTab, setActiveTab] = useState('logs');

  return (
    <Tabs tabs={TAB_ITEMS} active={activeTab} onChange={setActiveTab}>
      {activeTab === 'logs' && (
        <LiveLogViewer
          repositoryId={repositoryId}
          runId={run.uuid}
          runStatus={run.status}
          initialContent={initialCombinedContent}
        />
      )}

      {activeTab === 'artifacts' && (
        <div className="space-y-4">
          <ul className="text-sm space-y-1">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <ArtifactViewer
                  repositoryId={repositoryId}
                  runId={run.uuid}
                  fileName={f.path}
                  fileSize={f.size}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeTab === 'validation' && (
        <ValidationPanel repositoryId={repositoryId} runUuid={run.uuid} />
      )}

      {activeTab === 'review-fix' && (
        <ReviewFixPanel repositoryId={repositoryId} runUuid={run.uuid} />
      )}

      {activeTab === 'pr-review' && (
        <PrReviewPanel repositoryId={repositoryId} runUuid={run.uuid} />
      )}

      {activeTab === 'failure' && failure && (
        <div className="rounded border bg-red-50 p-3 text-sm space-y-1">
          <div>
            <b>Kind:</b> {failure.kind}
          </div>
          {failure.phase != null && (
            <div>
              <b>Phase:</b> {failure.phase}
            </div>
          )}
          {failure.exitCode !== undefined && (
            <div>
              <b>Exit code:</b> {failure.exitCode}
            </div>
          )}
          <div>
            <b>Message:</b> <pre className="inline whitespace-pre-wrap">{failure.message}</pre>
          </div>
          <div>
            <b>Suggested action:</b> {failure.suggestedAction}
          </div>
        </div>
      )}

      {activeTab === 'timeline' && (
        <TimelineIsland repositoryId={repositoryId} runUuid={run.uuid} />
      )}
    </Tabs>
  );
}
