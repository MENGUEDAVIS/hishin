import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, projectDir } from '../media/paths.js';
import type { Job } from '../server/jobs.js';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** Atomic snapshots survive server restarts; temporary files are never read as jobs. */
export function saveJob(job: Job): void {
  if (!safeId.test(job.id)) throw new Error('Invalid job ID');
  const directory = join(projectDir(job.projectId), 'jobs');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${job.id}.json`);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, JSON.stringify(job, null, 2));
  renameSync(temporary, destination);
}

export function readSavedJobs(): Job[] {
  const root = join(dataDir(), 'projects');
  let projects;
  try { projects = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const jobs: Job[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || !safeId.test(project.name)) continue;
    const directory = join(root, project.name, 'jobs');
    let files: string[];
    try { files = readdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const job = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Job;
      if (!safeId.test(job.id) || job.projectId !== project.name || file !== `${job.id}.json`
        || !['running', 'done', 'error'].includes(job.status) || !job.startedAt) {
        throw new Error(`Invalid saved job: ${project.name}/${file}`);
      }
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A restarted process cannot resume an old in-flight model invocation. */
export function recoverJobs(): Job[] {
  return readSavedJobs().map((job) => {
    if (job.status === 'running') {
      job.status = 'error';
      job.error = 'Montage interrompu par le redémarrage du serveur. Les rendus déjà produits restent dans l’historique.';
      job.finishedAt = new Date().toISOString();
      saveJob(job);
    }
    return job;
  });
}
