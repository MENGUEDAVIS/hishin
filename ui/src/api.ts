/**
 * Thin typed fetch wrapper for the HI-SHIN server (src/server/). No
 * business logic lives here — every call maps 1:1 to a route in
 * src/server/routes.ts.
 */

const BASE = '/api';

export interface MediaMetadata {
  hasVideo: boolean;
  hasAudio: boolean;
  video?: { width: number; height: number; fps: number };
}

export interface RawTake {
  takeId: string;
  sourcePath: string;
  storedPath: string;
  durationMs: number;
  mediaMetadata: MediaMetadata;
}

export interface PhotoAsset {
  photoId: string;
  sourcePath: string;
  storedPath: string;
  width: number;
  height: number;
}

export interface ProjectManifest {
  projectId: string;
  takes: RawTake[];
  photos: PhotoAsset[];
  warnings: string[];
}

export interface CritiqueIssue {
  category: string;
  severity: 'blocker' | 'warning';
  description: string;
  suggestion?: string;
}

export interface Critique {
  verdict: 'PASS' | 'REVISE';
  summary: string;
  issues: CritiqueIssue[];
}

export interface OrchestrateRound {
  round: number;
  directorSummary: string;
  outputPath: string;
  durationMs: number;
  critique: Critique;
}

export interface OrchestrateResult {
  finalOutputPath: string;
  finalDurationMs: number;
  verdict: 'PASS' | 'REVISE';
  rounds: OrchestrateRound[];
}

export interface RunJob {
  id: string;
  projectId: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  startedAt: string;
  finishedAt?: string;
  result?: OrchestrateResult;
}

export interface TraceEvent {
  role: string;
  round: number;
  event: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  verdict?: string;
  projectId: string;
  ts: string;
}

export interface CostRow {
  id: number;
  project_id: string;
  role: string;
  round: number;
  verdict: string | null;
  output_path: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

/**
 * A 401 from this server only ever means one thing (see requireAuth in
 * src/server/auth.ts): the ALB session is gone. There's no in-app recovery
 * from that — polling on it forever just spams the console — so the one
 * correct response anywhere in the app is a hard navigation back through the
 * load balancer, which re-triggers real Cognito login. Guarded to fire once:
 * several polls in flight can all see the 401 before the navigation lands.
 */
let redirectingToLogin = false;
function handleUnauthorized(): never {
  if (!redirectingToLogin) {
    redirectingToLogin = true;
    window.location.href = '/app';
  }
  throw new Error('Session expired — redirecting to log in.');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 401) handleUnauthorized();
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

export function createProject(
  sources: { path: string; takeId?: string }[],
  projectId?: string,
): Promise<ProjectManifest> {
  return request('/projects', { method: 'POST', body: JSON.stringify({ projectId, sources }) });
}

/**
 * Real browser upload (multipart/form-data) with progress reporting — the
 * `fetch` API has no reliable cross-browser upload-progress event, so this
 * uses XMLHttpRequest instead, unlike every other call in this file.
 */
export function uploadProject(
  files: File[],
  projectId: string | undefined,
  onProgress: (fraction: number) => void,
): Promise<ProjectManifest> {
  return new Promise((resolvePromise, reject) => {
    const form = new FormData();
    if (projectId) form.set('projectId', projectId);
    for (const file of files) form.append('files', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/projects/upload`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        try {
          handleUnauthorized();
        } catch (error) {
          reject(error);
        }
        return;
      }
      let body: (ProjectManifest & { error?: string }) | undefined;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the generic error below
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolvePromise(body);
      } else {
        reject(new Error(body?.error ?? `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

export function getProject(projectId: string): Promise<ProjectManifest> {
  return request(`/projects/${projectId}`);
}

export function startRun(
  projectId: string,
  input: {
    brief: string;
    script?: string;
    targetDurationSeconds: number;
    outputFormat: 'mp4' | 'mov';
    takeIds: string[];
    allowNarration?: boolean;
  },
): Promise<{ jobId: string; status: string }> {
  return request(`/projects/${projectId}/runs`, { method: 'POST', body: JSON.stringify(input) });
}

export function getRun(projectId: string, jobId: string): Promise<RunJob> {
  return request(`/projects/${projectId}/runs/${jobId}`);
}

export function getTraces(projectId: string): Promise<TraceEvent[]> {
  return request(`/projects/${projectId}/traces`);
}

export function getCosts(projectId: string): Promise<CostRow[]> {
  return request(`/projects/${projectId}/costs`);
}

export function mediaUrl(path: string): string {
  return `${BASE}/media?path=${encodeURIComponent(path)}`;
}

export interface ProjectSummary { projectId: string; takeCount: number; photoCount: number; renderCount: number; updatedAt: string }
export interface RenderSegment { id: string; kind: string; role: string; reason: string; startMs?: number; endMs?: number; sourceStartMs?: number; sourceEndMs?: number }
export interface RenderVersion { id: string; projectId: string; createdAt: string; outputPath: string; assembledPath: string; durationMs: number; available: boolean; assembledAvailable: boolean; objective: string; segments: RenderSegment[]; warnings: string[]; jobId?: string; round?: number; directorSummary?: string; critique?: Critique }
export interface Library { projects: ProjectSummary[]; renders: RenderVersion[]; jobs: RunJob[]; warnings: string[] }
export function getLibrary(): Promise<Library> { return request('/library'); }
