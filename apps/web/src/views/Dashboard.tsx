/**
 * Dashboard — what is actually going on, at a glance.
 * Status, the day's brief, pending approvals, connectors that need you and a live
 * activity feed straight off the backend event bus.
 */
import { useEffect, useState } from 'react';
import { api, type AgentRun } from '../api';
import { useLiveFeed, useAsync, usePolling } from '../hooks';

export function DashboardView({ onNavigate }: { onNavigate: (view: string) => void }) {
  const stats = usePolling(() => api.stats(), 12000);
  const status = useAsync(() => api.status(), []);
  const brief = useAsync(() => api.businessBrief(), []);
  const [events, setEvents] = useState<string[]>([]);
  const [pending, setPending] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);

  const feed = useLiveFeed((event) => {
    setEvents((current) => [`${new Date().toLocaleTimeString()} · ${event.name} ${describeEvent(event)}`, ...current].slice(0, 40));
  });

  useEffect(() => {
    const load = () => api.pendingRuns().then((data) => setPending(data.runs)).catch(() => undefined);
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const decide = async (run: AgentRun, stepId: string, approve: boolean) => {
    setBusy(true);
    try {
      await api.confirm(run.id, stepId, approve);
      setPending((current) => current.filter((entry) => entry.id !== run.id));
    } finally {
      setBusy(false);
    }
  };

  const data = stats.data;
  const connectorProblems = (data?.connectors?.items ?? []).filter((connector: any) => connector.status === 'sandbox' || connector.mode === 'sandbox');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Control Center</h1>
          <div className="sub">Private agent status, your day, and everything waiting on you.</div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => onNavigate('chat')}>
            🎙️ Talk to Xacheus
          </button>
          <button onClick={() => onNavigate('connect')}>Connectors</button>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <span className="value">{data?.agents ?? 11}</span>
          <span className="label">Agents</span>
        </div>
        <div className="card stat">
          <span className="value">{data?.tools ?? '—'}</span>
          <span className="label">Tools</span>
        </div>
        <div className="card stat">
          <span className="value">
            {data?.connectors ? `${data.connectors.live}/${data.connectors.total}` : '—'}
          </span>
          <span className="label">Connectors live</span>
        </div>
        <div className="card stat">
          <span className="value">{data?.knowledge?.documents ?? 0}</span>
          <span className="label">Documents indexed</span>
        </div>
      </div>

      {pending.length ? (
        <div className="card" style={{ marginBottom: 14, borderColor: 'rgba(251,191,36,0.4)' }}>
          <h3>⏳ Waiting for your approval ({pending.length})</h3>
          <div className="list">
            {pending.map((run) => {
              const step = run.plan.find((entry) => entry.status === 'awaiting_confirmation');
              return (
                <div className="list-item" key={run.id}>
                  <div className="row between">
                    <div>
                      <div className="title">{step?.title ?? run.request}</div>
                      <div className="meta">
                        {run.request} · {step?.confirmationReason}
                      </div>
                    </div>
                    <div className="row">
                      <button className="primary small" disabled={busy || !step} onClick={() => step && decide(run, step.id, true)}>
                        Approve
                      </button>
                      <button className="danger small" disabled={busy || !step} onClick={() => step && decide(run, step.id, false)}>
                        Decline
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="grid cols-2">
        <div className="card">
          <h3>💼 Today</h3>
          {brief.data ? (
            <>
              <pre style={{ maxHeight: 260 }}>{brief.data.text}</pre>
              <div className="list">
                {brief.data.priorities?.slice(0, 3).map((priority: any, index: number) => (
                  <div className="list-item" key={index}>
                    <div className="title">
                      {priority.title} <span className={`badge risk-${priority.weight === 'high' ? 'high' : 'low'}`}>{priority.weight}</span>
                    </div>
                    <div className="meta">{priority.detail}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">Loading your brief…</div>
          )}
        </div>

        <div className="card">
          <h3>🧩 Runtime</h3>
          {status.data ? (
            <table>
              <tbody>
                <tr>
                  <td className="muted">Model</td>
                  <td>
                    {status.data.model.label} <span className={`badge ${status.data.model.builtin ? 'sandbox' : 'live'}`}>{status.data.model.locality}</span>
                  </td>
                </tr>
                <tr>
                  <td className="muted">Storage</td>
                  <td>
                    {status.data.storage.id} <span className={`badge ${status.data.storage.ok ? 'live' : 'danger'}`}>{status.data.storage.ok ? 'healthy' : 'problem'}</span>
                  </td>
                </tr>
                <tr>
                  <td className="muted">Android devices</td>
                  <td>{status.data.devices.length ? status.data.devices.map((device: any) => device.name).join(', ') : 'none connected'}</td>
                </tr>
                <tr>
                  <td className="muted">Automations</td>
                  <td>
                    {status.data.automations.enabled} enabled of {status.data.automations.total}
                  </td>
                </tr>
                <tr>
                  <td className="muted">Workspace</td>
                  <td className="mono small">{status.data.workspaceRoot}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="empty">Loading…</div>
          )}
          {status.data?.model?.notes?.length ? (
            <div className="banner warn" style={{ marginTop: 10 }}>
              {status.data.model.notes[0]}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="row between">
            <h3>🔌 Needs your attention</h3>
            <button className="small" onClick={() => onNavigate('connect')}>
              Configure
            </button>
          </div>
          {connectorProblems.length ? (
            <div className="list">
              {connectorProblems.slice(0, 6).map((connector: any) => (
                <div className="list-item" key={connector.id}>
                  <div className="row between">
                    <span className="title">{connector.id}</span>
                    <span className="badge sandbox">sandbox</span>
                  </div>
                  <div className="meta">
                    {connector.missingFields?.length ? `missing: ${connector.missingFields.join(', ')}` : 'not connected yet'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">Everything configured is live. Nothing is waiting on you.</div>
          )}
        </div>

        <div className="card">
          <h3>
            📡 Live activity{' '}
            {feed.transport === 'polling' ? (
              <span className="badge" title="This host cannot hold WebSockets, so the console polls the API instead.">
                polling
              </span>
            ) : feed.transport === 'websocket' ? (
              <span className="badge live">streaming</span>
            ) : null}
          </h3>
          {events.length ? (
            <div className="scroll-y list">
              {events.map((line, index) => (
                <div className="event-line" key={index}>
                  <span className="time">{line.split(' · ')[0]}</span>
                  <span>{line.split(' · ').slice(1).join(' · ')}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">Nothing yet. Events stream here as agents work.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function describeEvent(event: { name: string; payload?: any }): string {
  const payload = event.payload ?? {};
  switch (event.name) {
    case 'run.started':
      return `run started — “${String(payload.request ?? '').slice(0, 60)}” (${payload.agent})`;
    case 'run.step':
      return `step ${payload.tool ?? ''} ${payload.status ?? ''}`;
    case 'run.completed':
      return `run completed in ${payload.durationMs ?? '?'} ms`;
    case 'run.awaiting_confirmation':
      return `waiting for approval — ${payload.tool}`;
    case 'notification.created':
      return `notification: ${payload.title}`;
    case 'inquiry.received':
      return `inquiry via ${payload.channel} from ${payload.name}`;
    case 'document.ingested':
      return `ingested ${payload.title} (${payload.characters} chars)`;
    case 'automation.fired':
      return `automation “${payload.name}” → ${payload.status}`;
    case 'connector.updated':
      return String(payload.note ?? 'connector updated');
    case 'memory.updated':
      return `memory ${payload.action ?? 'updated'}: ${payload.key ?? payload.count ?? ''}`;
    default:
      return '';
  }
}
