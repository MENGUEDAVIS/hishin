import { useRef, useState } from 'react';
import type { ProjectManifest } from '../api.ts';
import { getProject, startRun, uploadProject } from '../api.ts';

interface ProjectFormProps {
  onIngested: (manifest: ProjectManifest) => void;
  onRunStarted: (jobId: string) => void;
  manifest: ProjectManifest | null;
  running?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const VIDEO_PATTERN = /\.(mov|mp4|m4v|avi|mkv)$/i;
const IMAGE_PATTERN = /\.(jpe?g|png|webp|gif|bmp|tiff)$/i;

/**
 * One continuous flow: brief + script, drop/select real video and photo
 * files (uploaded to the server, not typed as a server-side path), upload
 * them, then confirm which resulting takes to send to the Director/Critic
 * run — every uploaded photo is automatically made available to the agent
 * for narration/photo segments.
 */
export function ProjectForm({ onIngested, onRunStarted, manifest, running = false }: ProjectFormProps) {
  const [projectId, setProjectId] = useState('');
  const [brief, setBrief] = useState('');
  const [script, setScript] = useState('');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(45);
  const [outputFormat, setOutputFormat] = useState<'mp4' | 'mov'>('mp4');

  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [ingestError, setIngestError] = useState<string | null>(null);

  const [selectedTakeIds, setSelectedTakeIds] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const accepted = [...list].filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('image/') || VIDEO_PATTERN.test(f.name) || IMAGE_PATTERN.test(f.name),
    );
    setFiles((prev) => [...prev, ...accepted]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleIngest(event: React.FormEvent) {
    event.preventDefault();
    setIngestError(null);
    if (files.length === 0) {
      setIngestError('Add at least one video or photo file (drag and drop, or browse).');
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const result = await uploadProject(files, projectId.trim() || undefined, setUploadProgress);
      const full = await getProject(result.projectId);
      onIngested(full);
      setSelectedTakeIds(full.takes.map((t) => t.takeId));
      setProjectId(full.projectId);
    } catch (error) {
      setIngestError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }

  async function handleStartRun(event: React.FormEvent) {
    event.preventDefault();
    if (!manifest) return;
    setRunError(null);
    if (!brief.trim() || selectedTakeIds.length === 0) {
      setRunError('Fill in the brief and keep at least one take selected.');
      return;
    }
    setStarting(true);
    try {
      const { jobId } = await startRun(manifest.projectId, {
        brief: brief.trim(),
        ...(script.trim() ? { script: script.trim() } : {}),
        targetDurationSeconds,
        outputFormat,
        takeIds: selectedTakeIds,
      });
      onRunStarted(jobId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  function toggleTake(takeId: string) {
    setSelectedTakeIds((prev) => (prev.includes(takeId) ? prev.filter((id) => id !== takeId) : [...prev, takeId]));
  }

  return (
    <section className="panel">
      <h2>Brief & media</h2>

      <form onSubmit={manifest ? handleStartRun : handleIngest}>
        <label htmlFor="brief">What story do you want to tell?</label>
        <textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="A short product presentation video, with a hook, an explanation, and a call to action."
        />

        <label htmlFor="script">Shooting script (optional)</label>
        <textarea
          id="script"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder="Hi, my name is... Today I'm showing you... Visit our website to learn more."
        />

        <div className="field-row">
          <div>
            <label htmlFor="target">Target duration (seconds)</label>
            <input
              id="target"
              type="number"
              min={1}
              value={targetDurationSeconds}
              onChange={(e) => setTargetDurationSeconds(Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="format">Output format</label>
            <select id="format" value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as 'mp4' | 'mov')}>
              <option value="mp4">mp4</option>
              <option value="mov">mov</option>
            </select>
          </div>
        </div>

        {!manifest && (
          <>
            <label htmlFor="projectId">Project ID (optional)</label>
            <input
              id="projectId"
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="proj_demo (generated if left blank)"
            />

            <label>Video rushes and photos</label>
            <div
              className={`dropzone${dragActive ? ' active' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="Add videos or photos"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              <p>
                Drag and drop your videos and photos here, or click to browse.
                <br />
                Photos can be used by the agent (visual behind a generated narration, closing card…).
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,image/*,.mov,.mp4,.m4v,.avi,.mkv,.jpg,.jpeg,.png,.webp"
                multiple
                hidden
                onChange={(e) => addFiles(e.target.files)}
              />
            </div>

            {files.length > 0 && (
              <ul className="take-list">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    <span style={{ flex: 1 }}>
                      {file.type.startsWith('image/') || IMAGE_PATTERN.test(file.name) ? 'PHOTO ·' : 'VIDEO ·'} {file.name} —{' '}
                      {formatBytes(file.size)}
                    </span>
                    <button type="button" className="secondary small" onClick={() => removeFile(index)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {uploading && (
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.round(uploadProgress * 100)}%` }} />
              </div>
            )}

            <button type="submit" disabled={uploading || files.length === 0}>
              {uploading ? `Uploading… ${Math.round(uploadProgress * 100)}%` : 'Import media'}
            </button>
            {ingestError && <p className="error">{ingestError}</p>}
          </>
        )}

        {manifest && (
          <>
            {manifest.warnings.map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
            <p className="subtitle">
              Project <strong>{manifest.projectId}</strong> — {manifest.takes.length} take(s), {manifest.photos.length} photo(s)
            </p>
            <ul className="take-list">
              {manifest.takes.map((take) => (
                <li key={take.takeId}>
                  <input
                    type="checkbox"
                    checked={selectedTakeIds.includes(take.takeId)}
                    onChange={() => toggleTake(take.takeId)}
                    id={`take-${take.takeId}`}
                  />
                  <label htmlFor={`take-${take.takeId}`} style={{ margin: 0, color: 'inherit', flex: 1 }}>
                    {take.takeId} — {(take.durationMs / 1000).toFixed(1)}s
                    {!take.mediaMetadata.hasAudio && ' (no audio)'}
                  </label>
                </li>
              ))}
              {manifest.photos.map((photo) => (
                <li key={photo.photoId}>
                  <span style={{ flex: 1 }}>
                    {photo.photoId} — {photo.width}×{photo.height} (available to the agent)
                  </span>
                </li>
              ))}
            </ul>
            <button type="submit" disabled={starting || running}>
              {running ? 'Editing in progress…' : starting ? 'Starting…' : 'Start the edit'}
            </button>
            {runError && <p className="error">{runError}</p>}
          </>
        )}
      </form>
    </section>
  );
}
