import { randomUUID } from 'node:crypto';
import { orchestrate, type OrchestrateInput, type OrchestrateResult } from '../agents/run-loop.js';
import { recoverJobs, saveJob } from '../state/job-store.js';

/**
 * A run of the Director<->Critic loop takes minutes (real Bedrock/ffmpeg
 * calls), far too long for a single HTTP request. Jobs are tracked
 * in-memory for active polling and atomically on disk for historical review.
 * Interrupted jobs are marked explicitly on process restart.
 */

export interface Job {
  id: string;
  projectId: string;
  status: 'running' | 'done' | 'error';
  input: OrchestrateInput;
  result?: OrchestrateResult;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, Job>();
let loaded = false;

function loadJobs(): void {
  if (loaded) return;
  for (const job of recoverJobs()) jobs.set(job.id, job);
  loaded = true;
}

export function listJobs(): Job[] {
  loadJobs();
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function startJob(input: OrchestrateInput): Job {
  loadJobs();
  if ([...jobs.values()].some((job) => job.projectId === input.projectId && job.status === 'running')) {
    throw new Error('Un montage est déjà en cours pour ce projet.');
  }
  if (process.env.NODE_ENV === 'production' && [...jobs.values()].some(job => job.status === 'running')) {
    throw new Error('Le studio traite déjà un montage. Réessayez une fois le rendu terminé.');
  }
  const job: Job = {
    id: randomUUID(),
    projectId: input.projectId,
    status: 'running',
    input,
    startedAt: new Date().toISOString(),
  };
  saveJob(job);
  jobs.set(job.id, job);

  orchestrate({ ...input, jobId: job.id })
    .then((result) => {
      job.status = 'done';
      job.result = result;
      job.finishedAt = new Date().toISOString();
      saveJob(job);
    })
    .catch((error: unknown) => {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      try { saveJob(job); } catch (persistenceError) { console.error('Could not persist failed job', persistenceError); }
    });

  return job;
}

export function getJob(jobId: string): Job | undefined {
  loadJobs();
  return jobs.get(jobId);
}

export function listJobsForProject(projectId: string): Job[] {
  return listJobs().filter((j) => j.projectId === projectId);
}
