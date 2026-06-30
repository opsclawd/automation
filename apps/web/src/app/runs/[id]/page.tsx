import { notFound } from 'next/navigation';
import { getRun, listArtifacts, getArtifact } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';
import { RunDetailTabs } from '@/components/RunDetailTabs';
import { RunActions } from '@/components/RunActions';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let run, failure;
  try {
    ({ run, failure } = await getRun(id));
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes(': 404')) notFound();
    throw e;
  }

  const files = await listArtifacts(id);
  const combined = files.find((f) => f.path === 'combined.log');
  const combinedContent = combined ? await getArtifact(id, 'combined.log') : '';

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex flex-wrap gap-4 items-center justify-between">
        <div className="flex flex-wrap gap-4 items-baseline">
          <h1 className="text-2xl font-semibold font-mono">{run.displayId}</h1>
          <span className="text-sm text-slate-600">Issue #{run.issueNumber}</span>
          <span className="text-sm text-slate-600">{formatDuration(run.durationMs)}</span>
        </div>
        <RunActions run={run} />
      </header>

      <RunDetailTabs
        run={run}
        failure={failure}
        files={files}
        initialCombinedContent={combinedContent}
      />
    </main>
  );
}
