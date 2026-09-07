import { useCallback, useEffect, useRef, useState } from 'react';
import { getLibrary, getCosts, type CostRow, mediaUrl, type Library, type ProjectManifest, type RenderVersion, type RunJob } from './api.ts';
import { ProjectForm } from './components/ProjectForm.tsx';
import { RunTrace } from './components/RunTrace.tsx';
type Page = 'dashboard' | 'new' | 'history';
const labels: Record<Page, string> = { dashboard: 'Dashboard', new: 'New edit', history: 'History' };
const date = (value: string) => new Date(value).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const duration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function Status({ render }: {
  render: RenderVersion;
}) {
  return <span
    className={`badge ${render.critique?.verdict === 'PASS' ? 'pass' : render.critique?.verdict === 'REVISE' ? 'revise' : ''}`}>{render.critique?.verdict === 'PASS' ? 'Passed' : render.critique?.verdict === 'REVISE' ? 'Needs revision' : 'Archived'}</span>;
}
export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [library, setLibrary] = useState<Library>({ projects: [], renders: [], jobs: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<RunJob | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); try {
      setLibrary(await getLibrary());
      setError('');
    }
      catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const running = library.jobs.filter(j => j.status === 'running');
  useEffect(() => {
    if (!running.length)
      return; const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer);
  }, [running.length, refresh]);
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'error')
      void refresh();
  }, [job?.status, refresh]);
  const navigate = (next: Page) => { setPage(next); setSelectedId(null); };
  const selected = library.renders.find(r => r.id === selectedId);
  const filtered = library.renders.filter(r => `${r.projectId} ${r.objective} ${r.directorSummary ?? ''}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || (filter === 'archive' ? !r.critique : r.critique?.verdict === filter)));
  const renderRows = (renders: RenderVersion[]) =>
    <div className="render-list">
      {renders.map((r) =>
        <button
          className="render-row"
          key={r.id}
          onClick={() => { setSelectedId(r.id); setPage('history'); }}>
          <span className="render-thumb">{r.available ?
            <video src={mediaUrl(r.outputPath)} preload="metadata" muted aria-label={`Preview ${r.projectId}`} />
            : <span>HI—SHIN</span>}<span className="timecode">{duration(r.durationMs)}</span></span><span className="render-name"><span className="eyebrow">{r.round ? `ROUND ${r.round}` : 'EDIT'} · {date(r.createdAt)}</span><strong>{r.projectId}</strong><span className="muted line-clamp">{r.objective || 'Archived edit'}</span></span>
          <Status render={r} />
          <span className="row-arrow" aria-hidden="true">↗</span>
        </button>
      )}
    </div>
    ;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('dashboard'); }}>HI<span>—</span>SHIN<i>EDITING STUDIO</i></a>
      <div className="sidebar-label">
        WORKSPACE
      </div>
      <nav aria-label="Main navigation">
        {(['dashboard', 'new', 'history'] as Page[]).map((p, i) =>
          <button
            key={p}
            className={page === p ? 'nav-item active' : 'nav-item'}
            aria-current={page === p ? 'page' : undefined}
            onClick={() => navigate(p)}>
            <span className="nav-symbol" aria-hidden="true">{['▦', '+', '◷'][i]}</span>{labels[p]}{p === 'history' && <span className="nav-count">{library.renders.length}</span>}
          </button>
        )}
      </nav>
      <div className="sidebar-bottom">
        <span className="status-dot" />
        Director & Critic<p>From your rushes to your story.</p><span className="edition">HI—SHIN / VIDEO STUDIO</span>
      </div>
    </aside>
    <main>
      <header className="topbar">
        <span>Studio <span className="slash">/</span> {selected ? 'Edit detail' : labels[page]}</span>
        <button className="text-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </header>
      <div className="workspace">
        {error &&
          <div className="notice error" role="alert">
            Could not load the library: {error}
            <button className="secondary small" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        }{library.warnings.length > 0 &&
          <details className="notice">
            <summary>
              {library.warnings.length} note(s) about the library
            </summary>
            {library.warnings.map((w, i) => <p key={i}>{w}</p>)}
          </details>
        }
        {page === 'dashboard' &&
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR EDITING DESK</p><h1>Overview<span className="accent">.</span></h1><p className="muted">Your projects, your agents, and every version of your story.</p>
              </div>
              <button onClick={() => navigate('new')}>
                + New edit
              </button>
            </div>
            <section className="stats" aria-label="Statistics">
              <div>
                <span>Projects</span><strong>{library.projects.length.toString().padStart(2, '0')}</strong>
              </div>
              <div>
                <span>Archived edits</span><strong>{library.renders.length.toString().padStart(2, '0')}</strong>
              </div>
              <div>
                <span>Agents at work</span><strong className={running.length ? 'accent' : ''}>{running.length.toString().padStart(2, '0')}</strong>
              </div>
              <div>
                <span>Needs revision</span><strong>{library.renders.filter(r => r.critique?.verdict === 'REVISE').length.toString().padStart(2, '0')}</strong>
              </div>
            </section>
            <div className="dashboard-columns">
              <section>
                <div className="section-heading">
                  <h2>Latest edits</h2>
                  <button className="text-button" onClick={() => navigate('history')}>
                    Full history ↗
                  </button>
                </div>
                {library.renders.length ? renderRows(library.renders.slice(0, 4)) :
                  <Empty
                    loading={loading}
                    title="Your first story starts here."
                    text="Import your rushes and let the agents propose a first edit."
                    action={() => navigate('new')} />
                }
              </section>
              <section className="activity">
                <div className="section-heading">
                  <h2>Agent activity</h2><span className="eyebrow">{library.jobs.length}</span>
                </div>
                {!library.jobs.length && <p className="muted">Upcoming editing sessions will appear here.</p>}{library.jobs.slice(0, 5).map(j =>
                  <article className="activity-item" key={j.id}>
                    <span className={`activity-dot ${j.status}`} />
                    <div>
                      <strong>{j.projectId}</strong><span className="muted">{j.status === 'running' ? 'Editing in progress' : j.status === 'error' ? 'Edit failed' : 'Session finished'}</span><small>{date(j.startedAt)}</small>{j.error && <p className="error">{j.error}</p>}
                    </div>
                  </article>
                )}
              </section>
            </div>
            {library.projects.length > 0 &&
              <section className="projects-section">
                <div className="section-heading">
                  <h2>Your projects</h2><span className="muted">{library.projects.length} in your studio</span>
                </div>
                <div className="project-list">
                  {library.projects.map(p =>
                    <div className="project-item" key={p.projectId}>
                      <strong>{p.projectId}</strong><span>{p.takeCount} take(s) · {p.photoCount} photo(s)</span><span>{p.renderCount} edit(s)</span>
                      <button
                        className="text-button"
                        onClick={() => { setSearch(p.projectId); setFilter('all'); navigate('history'); }}>
                        View edits ↗
                      </button>
                    </div>
                  )}
                </div>
              </section>
            }
          </>
        }

        <div hidden={page !== 'new'}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">A NEW STORY</p><h1>New edit<span className="accent">.</span></h1><p className="muted">Give the direction. The agents handle the cut.</p>
            </div>
            {manifest &&
              <button
                className="secondary"
                onClick={() => { setManifest(null); setJobId(null); setJob(null); setFormKey(v => v + 1); }}>
                Create another project
              </button>
            }
          </div>
          <div className="creation-layout">
            <div>
              <ProjectForm
                key={formKey}
                manifest={manifest}
                running={!!jobId && (!job || job.status === 'running')}
                onIngested={m => { setManifest(m); setJobId(null); setJob(null); void refresh(); }}
                onRunStarted={id => { setJobId(id); setJob(null); void refresh(); }} />
              {manifest && jobId &&
                <RunTrace projectId={manifest.projectId} jobId={jobId} job={job} onUpdate={setJob} />
              }{job?.status === 'done' &&
                <div className="notice success">
                  Edit finished. Every version is kept.
                  <button
                    className="text-button"
                    onClick={() => { setSearch(manifest?.projectId ?? ''); navigate('history'); }}>
                    View edits ↗
                  </button>
                </div>
              }
            </div>
            <aside className="workflow-note">
              <span className="eyebrow">THE JOURNEY</span>
              <ol>
                <li>
                  <strong>Your intent</strong><p>The brief sets the tone, pacing, and goal of the edit.</p>
                </li>
                <li>
                  <strong>Your footage</strong><p>Import the videos and photos that tell your story.</p>
                </li>
                <li>
                  <strong>The agents' eye</strong><p>Director proposes a cut. Critic evaluates it and asks for adjustments if needed.</p>
                </li>
              </ol>
              <p className="note-footer">Every iteration stays available in your history.</p>
            </aside>
          </div>
        </div>
        {page === 'history' && (selected ?
          <RenderDetail
            key={selected.id}
            render={selected}
            versions={library.renders.filter(r => r.projectId === selected.projectId)}
            onSelect={setSelectedId}
            onBack={() => setSelectedId(null)} />
          :
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">NOTHING IS EVER LOST</p><h1>History<span className="accent">.</span></h1><p className="muted">Find your cuts, your edits, and every one of their iterations.</p>
              </div>
              <span className="archive-count">{library.renders.length} versions</span>
            </div>
            <div className="filters">
              <label className="search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Search an edit"
                  placeholder="Search a project, an intent…"
                  value={search}
                  onChange={e => setSearch(e.target.value)} />
              </label>
              <select aria-label="Filter by verdict" value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="all">All verdicts</option><option value="PASS">Passed</option><option value="REVISE">Needs revision</option><option value="archive">No evaluation</option>
              </select>
            </div>
            {filtered.length ? renderRows(filtered) :
              <Empty
                loading={loading}
                title={library.renders.length ? 'No edit matches.' : 'A library waiting to be built.'}
                text={library.renders.length ? 'Try another term or another verdict.' : 'Your edits and their versions will appear here as soon as the first render is done.'}
                action={library.renders.length ? () => { setSearch(''); setFilter('all'); } : () => navigate('new')}
                actionLabel={library.renders.length ? 'Clear filters' : 'Create an edit'} />
            }
          </>
        )}

      </div>
      <footer className="app-footer">
        <span>HI—SHIN</span><span>Human intent. Agent precision.</span>
      </footer>
    </main>
  </div>
    ;
}
function Empty({ loading, title, text, action, actionLabel = 'Create an edit' }: {
  loading: boolean;
  title: string;
  text: string;
  action: () => void;
  actionLabel?: string;
}) {
  return <div className="empty-state">
    <span className="empty-mark" aria-hidden="true">▤</span><h3>{loading ? 'Loading your studio…' : title}</h3><p>{text}</p>{!loading &&
      <button className="secondary" onClick={action}>
        {actionLabel} ↗
      </button>
    }
  </div>
    ;
}
function RenderDetail({ render, versions, onSelect, onBack }: {
  render: RenderVersion;
  versions: RenderVersion[];
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const [cut, setCut] = useState(false);
  const hasMix = render.outputPath !== render.assembledPath;
  const player = useRef<HTMLVideoElement>(null);
  const [costs, setCosts] = useState<CostRow[]>([]);
  const [costLoading, setCostLoading] = useState(true);
  const [costError, setCostError] = useState('');
  useEffect(() => {
    let cancelled = false;
    getCosts(render.projectId).then(rows => { if (!cancelled) setCosts(rows); })
      .catch(() => { if (!cancelled) setCostError('This project\'s usage is temporarily unavailable.'); })
      .finally(() => { if (!cancelled) setCostLoading(false); });
    return () => { cancelled = true; };
  }, [render.projectId]);
  const available = cut ? render.assembledAvailable : render.available;
  return <>
    <button className="text-button back-link" onClick={onBack}>
      ← All edits
    </button>
    <div className="page-heading">
      <div>
        <p className="eyebrow">{date(render.createdAt)}{render.round ? ` · ROUND ${render.round}` : ''}</p><h1 className="project-title">{render.projectId}</h1><p className="muted">{render.objective || 'Archived edit'}</p>
      </div>
      <Status render={render} />
    </div>
    <div className="detail-layout">
      <section>
        <div className="player-toolbar">
          <div className="segmented">
            <button className={!cut ? 'selected' : ''} aria-pressed={!cut} onClick={() => setCut(false)}>
              {hasMix ? 'Final render' : 'Assembled cut'}
            </button>
            {hasMix &&
              <button className={cut ? 'selected' : ''} aria-pressed={cut} onClick={() => setCut(true)}>
                Assembled cut
              </button>
            }
          </div>
          <span className="muted">{duration(render.durationMs)}</span>
        </div>
        <div className="video-stage">
          {available ?
            <video
              key={cut ? render.assembledPath : render.outputPath}
              ref={player}
              controls
              preload="metadata"
              src={mediaUrl(cut ? render.assembledPath : render.outputPath)} />
            : <p>This video file is no longer available in storage.</p>}
        </div>
        <div className="player-caption">
          <span>{!hasMix ? 'Assembled cut · mix not saved' : cut ? 'Cut before mixing' : 'Render with final mix'}</span>{available && <a download href={mediaUrl(cut ? render.assembledPath : render.outputPath)}>Download ↗</a>}
        </div>
        <section className="segments">
          <div className="section-heading">
            <h2>Segments used</h2><span className="muted">{render.segments.length}</span>
          </div>
          {render.segments.length ? render.segments.map((s, i) =>
            <article className="segment" key={`${s.id}-${i}`}>
              <button
                className="segment-time"
                disabled={!available || s.startMs === undefined}
                aria-label={`Go to segment ${i + 1}`}
                onClick={() => {
                  if (player.current && s.startMs !== undefined)
                    player.current.currentTime = s.startMs / 1000;
                }}>
                {s.startMs !== undefined ? duration(s.startMs) : String(i + 1).padStart(2, '0')}
              </button>
              <div>
                <strong>{s.role || s.kind}</strong><span className="eyebrow">{s.id}</span><p>{s.reason || 'No justification recorded.'}</p>{s.sourceStartMs !== undefined && <small className="muted">Source: {duration(s.sourceStartMs)}{s.sourceEndMs !== undefined ? ` → ${duration(s.sourceEndMs)}` : ''}</small>}
              </div>
            </article>
          ) : <p className="muted">Segment details are not available for this older version.</p>}
        </section>
      </section>
      <aside>
        <section className="detail-panel">
          <h2>Project versions</h2>
          <label htmlFor="version">
            Select a version
          </label>
          <select id="version" value={render.id} onChange={e => onSelect(e.target.value)}>
            {versions.map((v, i) => <option key={v.id} value={v.id}>{date(v.createdAt)} · {v.round ? `Round ${v.round}` : `Version ${versions.length - i}`}</option>)}
          </select>
          <p className="muted">{versions.length} version(s) kept, including edits needing revision.</p>
        </section>
        <section className="detail-panel">
          <span className="agent-label">01 / DIRECTOR</span><h2>Editorial intent</h2><p>{render.directorSummary || 'The Director\'s summary was not recorded for this older version.'}</p>
        </section>
        <section className="detail-panel">
          <span className="agent-label">02 / CRITIC</span>
          <div className="section-heading">
            <h2>Critical review</h2>
            <Status render={render} />
          </div>
          <p>{render.critique?.summary || 'No evaluation recorded for this version.'}</p>{render.critique?.issues.map((issue, i) =>
            <article className="issue" key={i}>
              <span className={`severity ${issue.severity}`}>{issue.severity === 'blocker' ? 'To fix' : 'Note'} · {issue.category}</span><p>{issue.description}</p>{issue.suggestion && <p className="muted">{issue.suggestion}</p>}
            </article>
          )}
        </section>
        {render.warnings.length > 0 &&
          <section className="detail-panel">
            <h2>Render notes</h2>{render.warnings.map((w, i) => <p key={i}>{w}</p>)}
          </section>
        }
      <details className="detail-panel consumption">
            <summary>Project usage</summary>
            <p className="muted">Total across every session of this project, not attributed to this version specifically.</p>
            {costLoading ? <p className="muted">Loading…</p> : costError ? <p className="error">{costError}</p> : !costs.length ? <p className="muted">No usage recorded.</p> : <>
              <p>{costs.reduce((sum, row) => sum + (row.input_tokens ?? 0) + (row.output_tokens ?? 0), 0).toLocaleString('en-US')} tokens recorded</p>
              <p>{costs.some(row => row.cost_usd !== null) ? `$${costs.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0).toFixed(4)} in known costs` : 'Cost unavailable: rate not configured.'}</p>
              {costs.some(row => row.cost_usd === null) && costs.some(row => row.cost_usd !== null) && <p className="muted">Partial total: some rows have no known rate.</p>}
            </>}
          </details>
          </aside>
    </div>
  </>
    ;
}
