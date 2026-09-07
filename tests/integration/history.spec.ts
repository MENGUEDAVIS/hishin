import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readLibrary } from '../../src/state/library.ts';
import { saveJob } from '../../src/state/job-store.ts';

test('history discovers older revisions, preserves missing-file metadata and survives a process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hishin-history-'));
  const original = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  try {
    assert.deepEqual(await readLibrary(), { projects: [], renders: [], warnings: [] });
    const project = join(directory, 'projects', 'demo');
    await mkdir(join(project, 'raw'), { recursive: true });
    await writeFile(join(project, 'raw', 'manifest.json'), JSON.stringify({ takes: [{ takeId: 'take_01' }] }));
    for (const version of [1, 2]) {
      const render = join(project, 'renders', `assemble_${version}`);
      await mkdir(render, { recursive: true });
      await writeFile(join(render, 'assembled.mp4'), 'fixture; not playable');
      await writeFile(join(render, 'manifest.json'), JSON.stringify({
        outputPath: join(render, 'assembled.mp4'), durationMs: 1200,
        createdAt: `2026-09-0${version}T10:00:00.000Z`,
        editPlan: { objective: 'Démo', segments: [{ kind: 'take', segment_id: 'take_01_s01', role: 'hook', reason: 'Accroche' }] },
        timeline: [{ output_start_ms: 0, output_end_ms: 1200, source_start_ms: 500, source_end_ms: 1700 }],
      }));
      if (version === 2) {
        await writeFile(join(render, 'mix-manifest.json'), JSON.stringify({ outputPath: join(render, 'final.mp4'), durationMs: 1200 }));
        await writeFile(join(render, 'review.json'), JSON.stringify({
          jobId: 'job_saved', round: 2, directorSummary: 'Conserver cette accroche.',
          critique: { verdict: 'REVISE', summary: 'CTA absent.', issues: [{ category: 'cta', severity: 'warning', description: 'Ajouter un appel à l’action.' }] },
        }));
      }
    }
    const library = await readLibrary();
    assert.equal(library.renders.length, 2);
    assert.equal(library.projects[0]?.takeCount, 1);
    assert.equal(library.projects[0]?.renderCount, 2);
    assert.equal(library.renders[0]?.id, 'demo/assemble_2');
    assert.equal(library.renders[0]?.available, false);
    assert.equal(library.renders[0]?.assembledAvailable, true);
    assert.equal(library.renders[0]?.critique?.verdict, 'REVISE');
    assert.equal(library.renders[0]?.segments[0]?.sourceStartMs, 500);
    assert.equal(library.renders[1]?.critique, undefined);
    assert.equal(library.renders[1]?.available, true);

    const input = { projectId: 'demo', brief: 'Démo', targetDurationSeconds: 45, outputFormat: 'mp4' as const, takeIds: ['take_01'] };
    saveJob({ id: 'job_saved', projectId: 'demo', input, status: 'done', startedAt: '2026-09-01T10:00:00.000Z',
      result: { finalOutputPath: 'final.mp4', finalDurationMs: 1200, verdict: 'REVISE', rounds: [] } });
    saveJob({ id: 'job_interrupted', projectId: 'demo', input, status: 'running', startedAt: '2026-09-02T10:00:00.000Z' });
    const moduleUrl = pathToFileURL(resolve('src/state/job-store.ts')).href;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { recoverJobs } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(recoverJobs()));`],
    { env: { ...process.env, DATA_DIR: directory }, encoding: 'utf8' });
    const saved = JSON.parse(output);
    assert.equal(saved.find((job: { id: string }) => job.id === 'job_saved').result.verdict, 'REVISE');
    const interrupted = saved.find((job: { id: string }) => job.id === 'job_interrupted');
    assert.equal(interrupted.status, 'error');
    assert.match(interrupted.error, /redémarrage/);

    await writeFile(join(project, 'renders', 'assemble_2', 'manifest.json'), '{broken');
    const partial = await readLibrary();
    assert.equal(partial.renders.length, 1);
    assert.equal(partial.warnings.length, 1);
  } finally {
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
