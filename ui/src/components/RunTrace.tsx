import { useEffect, useState } from 'react';
import type { RunJob, TraceEvent } from '../api.ts';
import { getRun, getTraces } from '../api.ts';

interface RunTraceProps {
  projectId: string;
  jobId: string;
  job: RunJob | null;
  onUpdate: (job: RunJob) => void;
}

/**
 * Polls the run-trace log (src/observability/traces.ts) and job status while
 * a Director/Critic run is in flight. A run takes real minutes (real
 * Bedrock + ffmpeg calls), so polling — not a single request — is the
 * whole point of this component.
 */
export function RunTrace({ projectId, jobId, job, onUpdate }: RunTraceProps) {
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [pollError, setPollError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [latestJob, latestTraces] = await Promise.all([getRun(projectId, jobId), getTraces(projectId)]);
        if (cancelled) return;
        onUpdate(latestJob);
        setTraces(latestTraces.filter(event => new Date(event.ts).getTime() >= new Date(latestJob.startedAt).getTime()));
        setPollError('');
      } catch {
        if (!cancelled) setPollError('Live tracking is temporarily unavailable. Retrying automatically…');
      }
    }

    poll();
    const running = !job || job.status === 'running';
    const interval = running ? setInterval(poll, 3000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, jobId, job?.status]);

  if (!job) return <section className="panel" aria-live="polite"><h2>The agents are getting ready</h2><p className="muted">{pollError || "Connecting to the edit's live tracking…"}</p></section>;

  const badgeClass =
    job.status === 'running'
      ? 'running'
      : job.status === 'error'
        ? 'error'
        : `done ${job.result?.verdict.toLowerCase()}`;

  return (
    <section className="panel">
      <h2>
        Edit progress <span className={`badge ${badgeClass}`}>{job.status === 'done' ? (job.result?.verdict === 'PASS' ? 'Passed' : 'Needs revision') : job.status === 'running' ? 'In progress' : 'Interrupted'}</span>
      </h2>
      {pollError && <p className="error" role="status">{pollError}</p>}
      <p className="subtitle">Started at {new Date(job.startedAt).toLocaleTimeString()}</p>
      {job.error && <p className="error">{job.error}</p>}
      <div>
        {traces.length === 0 && <p className="subtitle">Waiting for the first events…</p>}
        {traces.map((event, index) => (
          <div className="trace-line" key={index}>
            [{new Date(event.ts).toLocaleTimeString()}] {event.role} · round {event.round} — {event.event}
            {event.verdict ? ` — ${event.verdict}` : ''}
            {event.usage ? ` — ${event.usage.inputTokens}in/${event.usage.outputTokens}out tokens` : ''}
          </div>
        ))}
      </div>
    </section>
  );
}
