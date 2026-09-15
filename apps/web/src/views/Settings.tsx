/**
 * Settings — the model layer, Firebase, storage and the security posture.
 * Everything here reports the truth about what is configured: Xacheus must never
 * imply a capability it does not have.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';

export function SettingsView() {
  const models = useAsync(() => api.models(), []);
  const status = useAsync(() => api.status(), []);
  const agents = useAsync(() => api.agents(), []);
  const [probes, setProbes] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const select = async (id: string) => {
    setMessage(null);
    try {
      const result = await api.selectModel(id);
      setMessage(`Model layer switched to ${result.label}.`);
      models.reload();
      status.reload();
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : String(problem));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">The model layer is modular: switch between the built-in planner, a local model and hosted APIs without changing anything else.</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>🧠 Model layer</h3>
          <p className="small">
            The built-in planner is deterministic: no network, no cost, and it drives routing, tools, memory and knowledge. A real
            language model adds conversational phrasing and more flexible planning.
          </p>
          <div className="list">
            {(models.data?.available ?? []).map((entry: any) => (
              <div className="list-item" key={entry.id}>
                <div className="row between">
                  <div>
                    <div className="title">
                      {entry.label}{' '}
                      <span className={`badge ${entry.locality === 'builtin' ? 'sandbox' : entry.locality === 'local' ? 'info' : 'live'}`}>
                        {entry.locality}
                      </span>
                    </div>
                    <div className="meta mono small">{entry.id}</div>
                  </div>
                  <button className={entry.selected ? 'small' : 'small primary'} disabled={entry.selected} onClick={() => select(entry.id)}>
                    {entry.selected ? 'Active' : 'Use'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => api.probeModels().then((data) => setProbes(data.probes))}>Probe providers</button>
          </div>
          {probes.length ? (
            <div className="list" style={{ marginTop: 10 }}>
              {probes.map((probe) => (
                <div className="list-item" key={probe.id}>
                  <div className={`badge ${probe.available ? 'live' : 'danger'}`}>{probe.available ? 'available' : 'unavailable'}</div>
                  <div className="small">
                    <strong>{probe.label}</strong> — {probe.detail}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {message ? (
            <div className="banner info" style={{ marginTop: 10 }}>
              {message}
            </div>
          ) : null}
          <div className="banner warn" style={{ marginTop: 10 }}>
            Run a local model with Ollama: install it, then <code>ollama pull llama3.1:8b</code> and set <code>XACHEUS_MODEL=ollama</code>{' '}
            (or paste OLLAMA_BASE_URL in Connectors → configure). Nothing leaves your machine.
          </div>
        </div>

        <div className="card">
          <h3>⚙️ Runtime</h3>
          {status.data ? (
            <table>
              <tbody>
                <tr>
                  <td className="muted">Storage driver</td>
                  <td>
                    <span className={status.data.storage.ok ? 'badge live' : 'badge danger'}>{status.data.storage.id}</span>
                    <div className="small muted">{status.data.storage.detail}</div>
                  </td>
                </tr>
                <tr>
                  <td className="muted">Workspace root (Code Agent)</td>
                  <td className="mono small">{status.data.workspaceRoot}</td>
                </tr>
                <tr>
                  <td className="muted">Data directory</td>
                  <td className="mono small">{status.data.dataDir}</td>
                </tr>
                <tr>
                  <td className="muted">Tools registered</td>
                  <td>{agents.data?.agents.reduce((sum: number, agent: any) => sum + agent.tools.length, 0) ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="empty">Loading…</div>
          )}
        </div>

        <div className="card">
          <h3>🔐 Security posture</h3>
          <div className="list">
            <div className="list-item">
              <div className="title">High-impact actions ask first</div>
              <div className="meta">
                Publishing, sending, calling, device settings and code execution are confirmation-gated by default. Change that per
                tool in Connect → Permissions (not recommended for anything that leaves the machine).
              </div>
            </div>
            <div className="list-item">
              <div className="title">Every step is audited</div>
              <div className="meta">
                Auth, permission decisions, confirmations, validation and execution are all written to the audit log with the actor,
                tool, mode and outcome.
              </div>
            </div>
            <div className="list-item">
              <div className="title">Sandbox is always labelled</div>
              <div className="meta">
                If a connector lacks credentials, its results say “simulated” and the mode badge reads sandbox. Xacheus never claims a
                simulated action happened.
              </div>
            </div>
            <div className="list-item">
              <div className="title">What Xacheus will not do</div>
              <div className="meta">
                It will not bypass Android permissions or a platform's rules, will not scrape content behind a login in violation of
                terms, and cannot control a device that exposes no authorized interface.
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>🔥 Firebase &amp; Cloudinary</h3>
          <p className="small">
            Firebase provides authentication and optional Firestore storage; Cloudinary stores media and documents. Both are
            optional — Xacheus runs on local JSON storage and local files without them.
          </p>
          <FirebaseBlock />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Agents and their tools</h3>
        <div className="grid cols-2">
          {(agents.data?.agents ?? []).map((agent: any) => (
            <div className="list-item" key={agent.id}>
              <div className="title">
                {agent.icon} {agent.name}
              </div>
              <div className="meta">{agent.description}</div>
              <div className="row small" style={{ marginTop: 6 }}>
                <span className="badge">{agent.tools.length} tools</span>
                {agent.policy ? <span className={`badge ${agent.policy.enabled ? 'live' : 'danger'}`}>{agent.policy.enabled ? 'enabled' : 'disabled'}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FirebaseBlock() {
  const [config, setConfig] = useState<any>(null);
  useEffect(() => {
    api.publicConfig().then(setConfig).catch(() => undefined);
  }, []);
  if (!config) return <div className="empty">Loading…</div>;

  const enabled = config.auth.firebaseEnabled;
  return (
    <div>
      <div className={`banner ${enabled ? 'info' : 'warn'}`}>
        {enabled
          ? `Firebase project ${config.firebase.projectId} is configured. Sign-in is available; the API accepts Firebase ID tokens verified against Google's public keys.`
          : 'Firebase is not configured yet. Add the web keys in Connectors → Firebase and restart, or keep using the local owner passcode.'}
      </div>
      <table style={{ marginTop: 10 }}>
        <tbody>
          <tr>
            <td className="muted">Project</td>
            <td className="mono small">{config.firebase.projectId || '—'}</td>
          </tr>
          <tr>
            <td className="muted">Auth domain</td>
            <td className="mono small">{config.firebase.authDomain || '—'}</td>
          </tr>
          <tr>
            <td className="muted">API auth mode</td>
            <td>{config.auth.mode}</td>
          </tr>
        </tbody>
      </table>
      <div className="small muted" style={{ marginTop: 10 }}>
        The Firebase web API key is public by design — it ships inside every browser bundle. Real protection comes from Firebase Auth,
        your Firestore security rules, and the owner check on this API.
      </div>
    </div>
  );
}
