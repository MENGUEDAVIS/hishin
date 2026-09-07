import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { assertSafeId, ensureProjectDirs, photosDir } from '../media/paths.js';
import { probeMedia } from '../media/probe.js';

/**
 * 01b-ingest-photos: validates and copies still images into project
 * storage, alongside the video takes handled by 01-ingest. A photo is a
 * distinct asset type — it can be shown as its own segment or as the
 * visual behind a generated narration segment (see 04-assemble.js), but it
 * is never a source of spoken words the way a video take is.
 */

const PhotoSourceSchema = z.object({
  path: z.string().min(1),
  photoId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
});

const IngestPhotosInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  sources: z.array(PhotoSourceSchema).min(1),
});

/**
 * @typedef {object} IngestedPhoto
 * @property {string} photoId
 * @property {string} sourcePath
 * @property {string} storedPath
 * @property {string} sha256
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} IngestPhotosOutput
 * @property {string} projectId
 * @property {IngestedPhoto[]} photos
 * @property {string[]} warnings
 */

/** @param {string} filePath @returns {Promise<string>} */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** @param {number} index @returns {string} */
function defaultPhotoId(index) {
  return `photo_${String(index + 1).padStart(2, '0')}`;
}

/**
 * @param {unknown} input
 * @returns {Promise<IngestPhotosOutput>}
 */
export async function ingestPhotos(input) {
  const { projectId, sources } = IngestPhotosInputSchema.parse(input);
  await ensureProjectDirs(projectId);

  /** @type {string[]} */
  const warnings = [];
  /** @type {IngestedPhoto[]} */
  const photos = [];
  const usedIds = new Set();

  for (const [index, source] of sources.entries()) {
    const photoId = assertSafeId(source.photoId ?? defaultPhotoId(index), 'photoId');
    if (usedIds.has(photoId)) {
      throw new Error(`Duplicate photoId in ingest request: ${photoId}`);
    }
    usedIds.add(photoId);

    const info = await stat(source.path).catch(() => null);
    if (!info || !info.isFile()) {
      throw new Error(`Source file not found: ${source.path}`);
    }

    const storedPath = join(photosDir(projectId), `${photoId}${extname(source.path)}`);
    await copyFile(source.path, storedPath);

    const [sha256, metadata] = await Promise.all([sha256File(storedPath), probeMedia(storedPath)]);

    if (!metadata.hasVideo || !metadata.video) {
      warnings.push(`${photoId}: could not read image dimensions`);
    }

    photos.push({
      photoId,
      sourcePath: source.path,
      storedPath,
      sha256,
      width: metadata.video?.width ?? 0,
      height: metadata.video?.height ?? 0,
    });
  }

  const manifest = { projectId, photos, warnings, ingestedAt: new Date().toISOString() };
  await writeFile(join(photosDir(projectId), 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { projectId, photos, warnings };
}
