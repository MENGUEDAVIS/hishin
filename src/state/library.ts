import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { dataDir, projectDir } from '../media/paths.js';
import { CritiqueSchema } from '../contracts/critique.js';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const segmentSchema = z.object({
  kind: z.string().optional(), segment_id: z.string().optional(), narration_id: z.string().optional(),
  photo_id: z.string().optional(), role: z.string().optional(), reason: z.string().optional(),
});
const timelineSchema = z.object({
  output_start_ms: z.number().optional(), output_end_ms: z.number().optional(),
  source_start_ms: z.number().optional(), source_end_ms: z.number().optional(),
});
const manifestSchema = z.object({
  outputPath: z.string(), durationMs: z.number(), createdAt: z.string(),
  editPlan: z.object({ objective: z.string().optional(), segments: z.array(segmentSchema) }),
  timeline: z.array(timelineSchema).default([]), warnings: z.array(z.string()).default([]),
});
const reviewSchema = z.object({
  jobId: z.string().optional(), round: z.number().optional(), directorSummary: z.string().optional(),
  critique: CritiqueSchema.optional(),
});

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function optionalJson(path: string): Promise<unknown> {
  try { return await jsonFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function scopedMedia(projectId: string, path: string): string {
  const rel = relative(resolve(projectDir(projectId)), resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Media path outside project');
  return path;
}

async function available(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isFile()).catch(() => false);
}

export interface RenderSegment {
  id: string; kind: string; role: string; reason: string;
  startMs?: number; endMs?: number; sourceStartMs?: number; sourceEndMs?: number;
}

export interface RenderVersion {
  id: string; projectId: string; createdAt: string; outputPath: string; assembledPath: string;
  durationMs: number; available: boolean; assembledAvailable: boolean; objective: string;
  segments: RenderSegment[]; warnings: string[];
  jobId?: string; round?: number; directorSummary?: string; critique?: z.infer<typeof CritiqueSchema>;
}

export interface ProjectSummary {
  projectId: string; takeCount: number; photoCount: number; renderCount: number; updatedAt: string;
}

/** Discover the existing on-disk manifests, including CLI renders predating the UI. */
export async function readLibrary(): Promise<{ projects: ProjectSummary[]; renders: RenderVersion[]; warnings: string[] }> {
  const root = join(dataDir(), 'projects');
  const projects: ProjectSummary[] = [];
  const renders: RenderVersion[] = [];
  const warnings: string[] = [];
  let directories;
  try { directories = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects, renders, warnings };
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || !idPattern.test(directory.name)) continue;
    const projectId = directory.name;
    const base = projectDir(projectId);
    const summary: ProjectSummary = {
      projectId, takeCount: 0, photoCount: 0, renderCount: 0,
      updatedAt: (await stat(base)).mtime.toISOString(),
    };
    for (const [folder, field] of [['raw', 'takes'], ['photos', 'photos']] as const) {
      try {
        const file = await optionalJson(join(base, folder, 'manifest.json'));
        if (file !== undefined) {
          const manifest = z.object({ [field]: z.array(z.unknown()) }).parse(file);
          if (field === 'takes') summary.takeCount = manifest[field]!.length;
          else summary.photoCount = manifest[field]!.length;
        }
      } catch { warnings.push(`Médias du projet ${projectId} : manifeste ${folder} illisible.`); }
    }
    const rendersRoot = join(base, 'renders');
    const entries = await readdir(rendersRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') warnings.push(`Rendus du projet ${projectId} inaccessibles.`);
      return [];
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const renderRoot = join(rendersRoot, entry.name);
        const manifest = manifestSchema.parse(await jsonFile(join(renderRoot, 'manifest.json')));
        const assembledPath = scopedMedia(projectId, manifest.outputPath);
        const renderWarnings = [...manifest.warnings];
        let outputPath = assembledPath;
        let durationMs = manifest.durationMs;
        try {
          const mix = await optionalJson(join(renderRoot, 'mix-manifest.json'));
          if (mix !== undefined) {
            const parsed = z.object({ outputPath: z.string(), durationMs: z.number(), warnings: z.array(z.string()).default([]) }).parse(mix);
            outputPath = scopedMedia(projectId, parsed.outputPath);
            durationMs = parsed.durationMs;
            renderWarnings.push(...parsed.warnings);
          }
        } catch { renderWarnings.push('Métadonnées du mixage illisibles ; la coupe assemblée reste disponible.'); }
        let review: z.infer<typeof reviewSchema> = {};
        try { review = reviewSchema.parse(await optionalJson(join(renderRoot, 'review.json')) ?? {}); }
        catch { renderWarnings.push('Compte rendu des agents illisible.'); }
        const segments: RenderSegment[] = manifest.editPlan.segments.map((segment, index) => {
          const timing = manifest.timeline[index];
          return {
            id: segment.segment_id ?? segment.narration_id ?? segment.photo_id ?? `segment_${index + 1}`,
            kind: segment.kind ?? 'take', role: segment.role ?? '', reason: segment.reason ?? '',
            ...(timing?.output_start_ms !== undefined ? { startMs: timing.output_start_ms } : {}),
            ...(timing?.output_end_ms !== undefined ? { endMs: timing.output_end_ms } : {}),
            ...(timing?.source_start_ms !== undefined ? { sourceStartMs: timing.source_start_ms } : {}),
            ...(timing?.source_end_ms !== undefined ? { sourceEndMs: timing.source_end_ms } : {}),
          };
        });
        const render: RenderVersion = {
          id: `${projectId}/${entry.name}`, projectId, createdAt: manifest.createdAt,
          outputPath, assembledPath, durationMs, available: await available(outputPath),
          assembledAvailable: await available(assembledPath), objective: manifest.editPlan.objective ?? '',
          segments, warnings: renderWarnings,
          ...(review.jobId ? { jobId: review.jobId } : {}),
          ...(review.round !== undefined ? { round: review.round } : {}),
          ...(review.directorSummary ? { directorSummary: review.directorSummary } : {}),
          ...(review.critique ? { critique: review.critique } : {}),
        };
        renders.push(render);
        summary.renderCount += 1;
        if (render.createdAt > summary.updatedAt) summary.updatedAt = render.createdAt;
      } catch { warnings.push(`Rendu ${projectId}/${entry.name} : manifeste absent ou illisible.`); }
    }
    projects.push(summary);
  }
  projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { projects, renders, warnings };
}
