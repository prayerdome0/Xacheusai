/**
 * Library — memory, knowledge and the calendar.
 * The owner's data, reviewable and correctable: every memory can be edited,
 * pinned or forgotten, and every document can be removed.
 */
import { useRef, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';

const MEMORY_KINDS = ['long-term', 'company', 'task', 'knowledge', 'conversation'];

export function LibraryView() {
  const [tab, setTab] = useState<'memory' | 'knowledge' | 'calendar'>('memory');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <div className="sub">What Xacheus knows: memory it can correct, documents it can cite, and your schedule.</div>
        </div>
        <div className="row">
          <button className={tab === 'memory' ? 'primary' : ''} onClick={() => setTab('memory')}>
            🧠 Memory
          </button>
          <button className={tab === 'knowledge' ? 'primary' : ''} onClick={() => setTab('knowledge')}>
            📚 Knowledge
          </button>
          <button className={tab === 'calendar' ? 'primary' : ''} onClick={() => setTab('calendar')}>
            📅 Calendar
          </button>
        </div>
      </div>
      {tab === 'memory' ? <MemoryTab /> : tab === 'knowledge' ? <KnowledgeTab /> : <CalendarTab />}
    </div>
  );
}

function MemoryTab() {
  const [kind, setKind] = useState<string>('');
  const memory = useAsync(() => api.memory(kind || undefined), [kind]);
  const [draft, setDraft] = useState({ key: '', value: '', kind: 'long-term', pinned: false });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!draft.value.trim()) return;
    setBusy(true);
    try {
      await api.addMemory({ ...draft, source: 'control-center' });
      setDraft({ key: '', value: '', kind: draft.kind, pinned: false });
      memory.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Teach Xacheus something</h3>
        <p className="small">
          Long-term memory is anything you explicitly choose to retain. Company memory is business context every agent can use.
        </p>
        <label>What to remember</label>
        <textarea rows={3} value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} placeholder="Our refund window is 14 days from delivery." />
        <div className="grid cols-2">
          <div>
            <label>Key (optional)</label>
            <input value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} placeholder="refund_window" />
          </div>
          <div>
            <label>Kind</label>
            <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
              {MEMORY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="toggle" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />
          Always include in context (pinned)
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy || !draft.value.trim()} onClick={add}>
            Remember this
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <h3>Stored memory ({memory.data?.records.length ?? 0})</h3>
          <select value={kind} onChange={(event) => setKind(event.target.value)} style={{ width: 160 }}>
            <option value="">All kinds</option>
            {MEMORY_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        {memory.data?.counts ? (
          <div className="row small" style={{ marginBottom: 10 }}>
            {Object.entries(memory.data.counts).map(([key, value]) => (
              <span className="badge" key={key}>
                {key}: {value}
              </span>
            ))}
          </div>
        ) : null}
        <div className="list scroll-y">
          {(memory.data?.records ?? []).map((record: any) => (
            <div className="list-item" key={record.id}>
              <div className="row between">
                <div className="title">
                  {record.key} <span className="badge">{record.kind}</span>
                  {record.pinned ? <span className="badge info">pinned</span> : null}
                </div>
                <div className="row">
                  <button
                    className="small ghost"
                    onClick={() => api.updateMemory(record.id, { pinned: !record.pinned }).then(() => memory.reload())}
                  >
                    {record.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button className="small danger" onClick={() => api.forgetMemory(record.id).then(() => memory.reload())}>
                    Forget
                  </button>
                </div>
              </div>
              <EditableValue record={record} onSaved={() => memory.reload()} />
              <div className="meta">
                source: {record.source} · confidence {record.confidence} · updated {new Date(record.updatedAt).toLocaleString()}
              </div>
            </div>
          ))}
          {memory.data && !memory.data.records.length ? <div className="empty">Nothing stored yet.</div> : null}
        </div>
      </div>
    </div>
  );
}

function EditableValue({ record, onSaved }: { record: any; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(record.value);
  if (!editing) {
    return (
      <div onClick={() => setEditing(true)} style={{ cursor: 'text' }} title="Click to correct">
        {record.value}
      </div>
    );
  }
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <input value={value} onChange={(event) => setValue(event.target.value)} />
      <button
        className="small primary"
        onClick={() => {
          api.updateMemory(record.id, { value }).then(() => {
            setEditing(false);
            onSaved();
          });
        }}
      >
        Save
      </button>
      <button className="small ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}

function KnowledgeTab() {
  const knowledge = useAsync(() => api.knowledge(), []);
  const [over, setOver] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [status, setStatus] = useState<string>('');
  const [collection, setCollection] = useState('general');
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setStatus(`Uploading ${files.length} file(s)…`);
    for (const file of Array.from(files)) {
      try {
        const result = await api.uploadDocument(file, { collection, tags: 'uploaded' });
        const warning = result.extraction.warning ? ` — ${result.extraction.warning}` : '';
        setStatus(
          `${file.name}: indexed via ${result.extraction.method} (${result.extraction.characters} characters, ${result.document.chunkCount} chunk(s), stored in ${result.attachment.provider})${warning}`,
        );
      } catch (problem) {
        setStatus(`${file.name} failed: ${problem instanceof Error ? problem.message : String(problem)}`);
      }
    }
    knowledge.reload();
  };

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Add documents</h3>
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void upload(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <div style={{ fontSize: 26 }}>📄</div>
          <div>Drop PDFs, Word, Excel, PowerPoint, CSV, Markdown or text here</div>
          <div className="small muted">or click to choose files</div>
          <input ref={inputRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ minWidth: 160 }}>
            <label>Collection</label>
            <input value={collection} onChange={(event) => setCollection(event.target.value)} />
          </div>
          <div className="small muted" style={{ flex: 1, minWidth: 200 }}>
            Files go to Cloudinary when it is configured, otherwise they are stored on this server and served from /api/files.
          </div>
        </div>
        {status ? (
          <div className="banner info" style={{ marginTop: 10 }}>
            {status}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Search</h3>
        <div className="row">
          <input
            value={query}
            placeholder="Ask your documents a question"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && query.trim()) api.knowledgeSearch(query).then((data) => setHits(data.hits));
            }}
          />
          <button className="primary" onClick={() => query.trim() && api.knowledgeSearch(query).then((data) => setHits(data.hits))}>
            Search
          </button>
        </div>
        <div className="list scroll-y" style={{ marginTop: 12 }}>
          {hits.map((hit) => (
            <div className="list-item" key={hit.chunkId}>
              <div className="title">
                {hit.documentTitle} <span className="badge">score {hit.score.toFixed(3)}</span>
              </div>
              <div className="small">{hit.text.slice(0, 420)}</div>
            </div>
          ))}
          {hits.length === 0 ? <div className="empty">Search runs over the indexed passages of your own files.</div> : null}
        </div>
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="row between">
          <h3>Indexed documents ({knowledge.data?.documents.length ?? 0})</h3>
          <div className="row small muted">
            <span>{knowledge.data?.stats?.chunks ?? 0} passages</span>
            <span>·</span>
            <span>{knowledge.data?.stats?.terms ?? 0} terms</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Collection</th>
              <th>Source</th>
              <th>Chunks</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(knowledge.data?.documents ?? []).map((document: any) => (
              <tr key={document.id}>
                <td>{document.title}</td>
                <td>
                  <span className="badge">{document.collection}</span>
                </td>
                <td className="mono small truncate" style={{ maxWidth: 260 }}>
                  {document.provider === 'cloudinary' ? (
                    <a href={document.url} target="_blank" rel="noreferrer">
                      cloudinary
                    </a>
                  ) : (
                    document.source
                  )}
                </td>
                <td>{document.chunkCount}</td>
                <td className="small muted">{new Date(document.createdAt).toLocaleDateString()}</td>
                <td>
                  <button className="small danger" onClick={() => api.deleteKnowledge(document.id).then(() => knowledge.reload())}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {knowledge.data && !knowledge.data.documents.length ? <div className="empty">No documents yet.</div> : null}
      </div>
    </div>
  );
}

function CalendarTab() {
  const calendar = useAsync(() => api.calendar(14), []);
  const [draft, setDraft] = useState({ title: '', when: 'tomorrow at 9am', kind: 'event' });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Add something</h3>
        <label>What</label>
        <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Call the supplier" />
        <label>When</label>
        <input value={draft.when} onChange={(event) => setDraft({ ...draft, when: event.target.value })} />
        <div className="field-hint">Xacheus understands “tomorrow morning”, “friday at 3pm”, “in 2 hours”, or an ISO timestamp.</div>
        <label>Type</label>
        <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
          <option value="event">Event</option>
          <option value="reminder">Reminder</option>
          <option value="task-block">Task block</option>
        </select>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={!draft.title.trim()}
            onClick={() =>
              api
                .addEvent(draft)
                .then(() => {
                  setError(null);
                  setDraft({ ...draft, title: '' });
                  calendar.reload();
                })
                .catch((problem) => setError(problem.message))
            }
          >
            Add
          </button>
        </div>
        {error ? (
          <div className="banner danger" style={{ marginTop: 10 }}>
            {error}
          </div>
        ) : null}
        <div className="small muted" style={{ marginTop: 10 }}>
          When a paired Android device is connected, events are mirrored onto the phone's own calendar.
        </div>
      </div>

      <div className="card">
        <h3>Next 14 days</h3>
        <div className="list scroll-y">
          {(calendar.data?.events ?? []).map((event: any) => (
            <div className="list-item" key={event.id}>
              <div className="row between">
                <div>
                  <div className="title">
                    {event.kind === 'reminder' ? '⏰ ' : '📅 '}
                    {event.title}
                  </div>
                  <div className="meta"> {new Date(event.start).toLocaleString()} {event.mirroredToDevice ? '· mirrored to phone' : ''}
                  </div>
                </div>
                <button className="small danger" onClick={() => api.deleteEvent(event.id).then(() => calendar.reload())}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {calendar.data && !calendar.data.events.length ? <div className="empty">Nothing scheduled.</div> : null}
        </div>
      </div>
    </div>
  );
}
