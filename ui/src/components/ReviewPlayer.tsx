import { useEffect, useState } from 'react';
import type { CostRow, RunJob } from '../api.ts';
import { getCosts, mediaUrl } from '../api.ts';

interface ReviewPlayerProps {
  projectId: string;
  job: RunJob;
}

/**
 * Review pane once a run has finished (or errored): plays the final render,
 * shows every round's Director summary and Critic verdict/issues, and the
 * token-cost ledger from src/state/project-store.ts.
 */
export function ReviewPlayer({ projectId, job }: ReviewPlayerProps) {
  const [costs, setCosts] = useState<CostRow[]>([]);

  useEffect(() => {
    if (job.status !== 'done' && job.status !== 'error') return;
    getCosts(projectId)
      .then(setCosts)
      .catch(() => setCosts([]));
  }, [projectId, job.status]);

  if (job.status === 'running') return null;
  if (job.status === 'error') {
    return (
      <section className="panel">
        <h2>Run failed</h2>
        <p className="error">{job.error}</p>
      </section>
    );
  }
  if (!job.result) return null;

  return (
    <>
      <section className="panel">
        <h2>
          Final render <span className={`badge done ${job.result.verdict.toLowerCase()}`}>{job.result.verdict}</span>
        </h2>
        <p className="subtitle">Duration: {(job.result.finalDurationMs / 1000).toFixed(1)}s</p>
        <video controls src={mediaUrl(job.result.finalOutputPath)} />
      </section>

      <section className="panel">
        <h2>Round history</h2>
        {job.result.rounds.map((round) => (
          <div className="round-card" key={round.round}>
            <h3>
              Round {round.round} — <span className={`badge done ${round.critique.verdict.toLowerCase()}`}>{round.critique.verdict}</span>
            </h3>
            <p className="subtitle">{(round.durationMs / 1000).toFixed(1)}s</p>
            <p>{round.critique.summary}</p>
            {round.critique.issues.map((issue, index) => (
              <div className="issue" key={index}>
                <span className={`severity ${issue.severity}`}>{issue.severity}</span>
                <span>[{issue.category}]</span> {issue.description}
                {issue.suggestion && <div className="subtitle">→ {issue.suggestion}</div>}
              </div>
            ))}
          </div>
        ))}
      </section>

      {costs.length > 0 && (
        <section className="panel">
          <h2>Costs and tokens</h2>
          <table className="cost-table">
            <thead>
              <tr>
                <th>Round</th>
                <th>Role</th>
                <th>Verdict</th>
                <th>Tokens in/out</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((row) => (
                <tr key={row.id}>
                  <td>{row.round}</td>
                  <td>{row.role}</td>
                  <td>{row.verdict ?? '—'}</td>
                  <td>
                    {row.input_tokens ?? '—'}/{row.output_tokens ?? '—'}
                  </td>
                  <td>{row.cost_usd !== null ? `$${row.cost_usd.toFixed(4)}` : 'unknown (rate not configured)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
