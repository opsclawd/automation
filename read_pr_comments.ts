import { openDatabase, PrReviewRepository } from '@ai-sdlc/infrastructure';
import { RunId } from '@ai-sdlc/domain';
import { join } from 'node:path';

const repoRoot = process.cwd();
const runsDir = join(repoRoot, '.ai-runs');
const dbPath = join(runsDir, 'orchestrator.sqlite');

try {
  const db = openDatabase(dbPath);
  const repo = new PrReviewRepository(db);
  // List all runs that have comments
  const runsWithComments = db.prepare('SELECT DISTINCT run_uuid FROM pr_review_comments').all() as { run_uuid: string }[];

  if (runsWithComments.length === 0) {
    console.log("No PR comments found in database.");
  } else {
    for (const { run_uuid } of runsWithComments) {
      console.log(`Run: ${run_uuid}`);
      const comments = repo.listComments(RunId(run_uuid));
      for (const c of comments) {
        console.log(`[${c.commentId}] ${c.reviewer}: ${c.body}`);
        if (c.state === 'replied' || c.state === 'processed') {
           const replies = repo.listReplies(RunId(run_uuid)).filter(r => r.commentId === c.commentId);
           for (const r of replies) {
             console.log(`  -> Reply: ${r.body}`);
           }
        }
      }
    }
  }
} catch (err) {
  console.error("Error reading PR comments:", err);
}
