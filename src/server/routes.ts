import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ingest } from '../pipeline/01-ingest.js';
import { ingestPhotos } from '../pipeline/01b-ingest-photos.js';
import { dataDir, projectDir, photosDir, rawDir, tracesFile } from '../media/paths.js';
import { listRuns } from '../state/project-store.js';
import { getJob, listJobs, listJobsForProject, startJob } from './jobs.js';
import { readLibrary } from '../state/library.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { canAccessProject, checkOrigin, localMode, projectAccess, withinDirectory } from './access.js';
import { listProjectIdsForOwner, recordProjectOwnerIfAbsent } from '../state/ownership.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']);

function isImageFile(file: { originalname: string; mimetype: string }): boolean {
  return file.mimetype.startsWith('image/') || IMAGE_EXTENSIONS.has(extname(file.originalname).toLowerCase());
}

async function readPhotoManifest(projectId: string): Promise<{ photoId: string }[]> {
  try {
    const manifest = JSON.parse(await readFile(join(photosDir(projectId), 'manifest.json'), 'utf8'));
    return manifest.photos ?? [];
  } catch {
    return [];
  }
}

async function readPhotoIds(projectId: string): Promise<string[]> {
  return (await readPhotoManifest(projectId)).map((p) => p.photoId);
}

/**
 * Minimal REST API for project creation and review (brief's Step 5).
 * Every mutating action delegates to the same pipeline/agent code paths
 * used by the CLI scripts — this is a thin transport layer, not a second
 * implementation.
 */

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function isValidProjectId(value: string): boolean {
  return PROJECT_ID.test(value);
}

export const apiRouter = Router();
apiRouter.use(requireAuth, checkOrigin);
apiRouter.get('/me', (req: AuthedRequest, res) => res.json({ user: req.user, local: localMode() }));
apiRouter.use('/projects/:projectId', (req, res, next) => {
  if (req.params.projectId === 'upload') { next(); return; }
  void projectAccess(req, res, next).catch(next);
});

apiRouter.get('/library', async (req: AuthedRequest, res) => {
  try {
    const allowed = localMode() ? undefined : new Set(await listProjectIdsForOwner(req.user!.id));
    const library = await readLibrary(allowed);
    res.json({ ...library, jobs: listJobs().filter(job => !allowed || allowed.has(job.projectId)) });
  } catch {
    res.status(500).json({ error: 'Impossible de lire l’historique des montages.' });
  }
});

/**
 * Staging area for browser uploads, cleaned up per-request right after
 * ingest() has copied each file into the project's own raw/ directory —
 * this is scratch space, not where uploaded video lives long-term.
 */
const uploadStagingDir = join(tmpdir(), 'hishin-uploads');
mkdirSync(uploadStagingDir, { recursive: true });
const upload = multer({
  // multer's default disk storage drops the original extension; 01-ingest
  // (and everything downstream that derives a takeId from the stored
  // file's basename) needs a real extension to probe/copy correctly.
  storage: multer.diskStorage({
    destination: uploadStagingDir,
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024, files: 10, fields: 2 },
  fileFilter: (_req, file, callback) => {
    if (!/\.(mov|mp4|m4v|avi|mkv|jpe?g|png|webp)$/i.test(file.originalname)) { callback(new Error('Format de fichier non autorisé.')); return; }
    callback(null, true);
  },
});

/**
 * Real browser upload: multipart form with one or more video and/or photo
 * files plus an optional projectId field. Videos go through 01-ingest,
 * images through 01b-ingest-photos, in the same request — this is the
 * primary way a human uses the UI. `POST /projects` (JSON, server-side
 * paths) stays around for scripted/CLI callers that already have files on
 * the server's filesystem.
 */
apiRouter.post('/projects/upload', upload.array('files'), async (req: AuthedRequest, res) => {
  const files = req.files;
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'no files uploaded' });
    return;
  }

  const projectIdRaw = typeof req.body.projectId === 'string' ? req.body.projectId.trim() : '';
  if (projectIdRaw && !isValidProjectId(projectIdRaw)) {
    res.status(400).json({ error: 'invalid projectId' });
    await Promise.allSettled(files.map((f) => rm(f.path, { force: true })));
    return;
  }
  const projectId = localMode() ? projectIdRaw || `proj_${randomUUID()}` : `proj_${randomUUID()}`;

  const videoFiles = files.filter((f) => !isImageFile(f));
  const photoFiles = files.filter(isImageFile);

  try {
    if (!localMode()) {
      await mkdir(resolve(dataDir(), 'projects'), { recursive: true });
      await mkdir(projectDir(projectId));
      await recordProjectOwnerIfAbsent(projectId, req.user!.id);
    }
    const [videoResult, photoResult] = await Promise.all([
      videoFiles.length > 0
        ? ingest({ projectId, sources: videoFiles.map((f) => ({ path: f.path })) })
        : Promise.resolve(null),
      photoFiles.length > 0
        ? ingestPhotos({ projectId, sources: photoFiles.map((f) => ({ path: f.path })) })
        : Promise.resolve(null),
    ]);
    res.status(201).json({
      projectId,
      takes: videoResult?.takes ?? [],
      photos: photoResult?.photos ?? [],
      warnings: [...(videoResult?.warnings ?? []), ...(photoResult?.warnings ?? [])],
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await Promise.allSettled(files.map((f) => rm(f.path, { force: true })));
  }
});

apiRouter.post('/projects', async (req, res) => {
  if (!localMode()) { res.status(403).json({ error: 'Import par chemin serveur désactivé. Utilisez l’upload.' }); return; }
  const schema = z.object({
    projectId: z.string().regex(PROJECT_ID).optional(),
    sources: z
      .array(z.object({ path: z.string().min(1), takeId: z.string().regex(PROJECT_ID).optional() }))
      .min(1),
  });
  try {
    const body = schema.parse(req.body);
    const projectId = body.projectId ?? `proj_${randomUUID().slice(0, 8)}`;
    const result = await ingest({
      projectId,
      sources: body.sources.map((s) => (s.takeId ? { path: s.path, takeId: s.takeId } : { path: s.path })),
    });
    res.status(201).json({ ...result, photos: await readPhotoManifest(projectId) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRouter.get('/projects/:projectId', async (req, res) => {
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: 'invalid projectId' });
    return;
  }
  try {
    const manifest = JSON.parse(await readFile(resolve(rawDir(projectId), 'manifest.json'), 'utf8'));
    const photos = await readPhotoManifest(projectId);
    res.json({ ...manifest, photos });
  } catch {
    res.status(404).json({ error: 'project not found or not ingested yet' });
  }
});

apiRouter.post('/projects/:projectId/runs', async (req, res) => {
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: 'invalid projectId' });
    return;
  }
  const schema = z.object({
    brief: z.string().min(1).max(10000),
    script: z.string().min(1).max(20000).optional(),
    targetDurationSeconds: z.number().positive().max(300),
    outputFormat: z.enum(['mp4', 'mov']).default('mp4'),
    takeIds: z.array(z.string().regex(PROJECT_ID)).min(1),
    // Opt-in only: without this, the Director cannot generate Polly narration for this run.
    allowNarration: z.boolean().default(false),
  });
  try {
    const { script, ...body } = schema.parse(req.body);
    const photoIds = await readPhotoIds(projectId);
    const job = startJob({
      projectId,
      ...body,
      ...(script ? { script } : {}),
      ...(photoIds.length > 0 ? { photoIds } : {}),
    });
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRouter.get('/projects/:projectId/runs', (req, res) => {
  res.json(listJobsForProject(req.params.projectId));
});

apiRouter.get('/projects/:projectId/runs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.projectId !== req.params.projectId) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(job);
});

apiRouter.get('/projects/:projectId/traces', async (req, res) => {
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: 'invalid projectId' });
    return;
  }
  try {
    const raw = await readFile(tracesFile(projectId), 'utf8');
    res.json(
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  } catch {
    res.json([]);
  }
});

apiRouter.get('/projects/:projectId/costs', async (req, res) => {
  const { projectId } = req.params;
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: 'invalid projectId' });
    return;
  }
  res.json(await listRuns(projectId));
});

/**
 * Serves one file from inside DATA_DIR — never an arbitrary filesystem
 * path. `path` is expected to be exactly what a pipeline result already
 * returned (e.g. `data/projects/<id>/renders/.../final.mp4`).
 */
apiRouter.get('/media', async (req: AuthedRequest, res) => {
  const requested = req.query.path;
  if (typeof requested !== 'string' || requested.length === 0) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  const root = resolve(dataDir());
  const resolved = resolve(requested);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.status(403).json({ error: 'path escapes the data directory' });
    return;
  }
  const parts = rel.split(/[\\/]/);
  const projectId = parts[0] === 'projects' ? parts[1] : undefined;
  if (!projectId || !await canAccessProject(req.user!.id, projectId) || !/\.(mp4|mov|m4v|jpg|jpeg|png|webp|srt|vtt)$/i.test(resolved)) {
    res.status(404).json({ error: 'Média introuvable.' }); return;
  }
  try {
    await withinDirectory(projectDir(projectId), resolved);
    await stat(resolved);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  res.sendFile(resolved);
});
