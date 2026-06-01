'use client';

import { useState } from 'react';
import { Tabs } from './Tabs';
import { LiveLogViewer } from '@/app/runs/[id]/LiveLogViewer';
import { ArtifactViewer } from './ArtifactViewer';
import { ValidationPanel } from './ValidationPanel';
import { TimelineIsland } from '@/app/runs/[id]/timeline-island';
import type { RunDto, FailureDto, ArtifactFile } from '@/lib/api-client';

interface RunDetailTabsProps {
  run: RunDto;
  failure: FailureDto | null;
  files: ArtifactFile[];
  initialCombinedContent: string;
}

const TAB_ITEMS = [
  { id: 'logs', label: 'Logs' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'validation', label: 'Validation' },
  { id: 'failure', label: 'Failure' },
  { id: 'timeline', label: 'Timeline' },
];

export function RunDetailTabs({ run, failure, files, initialCombinedContent }: RunDetailTabsProps) {
  const [activeTab, setActiveTab] = useState('logs');

  return (
    <Tabs tabs={TAB_ITEMS} active={activeTab} onChange={setActiveTab}>
      {activeTab === 'logs' && (
        <LiveLogViewer
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
                <ArtifactViewer runId={run.uuid} fileName={f.path} fileSize={f.size} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeTab === 'validation' && <ValidationPanel runUuid={run.uuid} />}

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

      {activeTab === 'timeline' && <TimelineIsland runUuid={run.uuid} />}
    </Tabs>
  );
}
