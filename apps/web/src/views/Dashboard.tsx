/**
 * Dashboard — the home of the Control Center.
 * What's moving, what is waiting on you, and quiet proof the system is healthy.
 */
import { useEffect, useState } from 'react';
import { api, type AgentRun } from '../api';
import { useLiveFeed, useAsync, usePolling } from '../hooks';

interface FeedLine {
  at: string;
  text: string;
  kind: 'ok' | 'warn' | 'info' | 'accent' | 'dim';
}

export function DashboardView({ onNavigate }: { onNavigate: (view: string) => void }) {
  const stats = usePolling(() => api.stats(), 12000);
  const status = useAsync(() => api.status(), []);
  const brief = useAsync(() => api.businessBrief(), []);
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [pending, setPending] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);

  const feed = useLiveFeed((event) => {
    setLines((current) =>
      [
        {
          at: new Date().toLocaleTimeString(),
          text: `${event.name}${describeEvent(event) ? ` — ${describeEvent(event)}` : ''}`,
          kind: kindFor(event.name),
        },
        ...current,
      ].slice(0, 40),
    );
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
  const connectorProblems = (data?.connectors?.items ?? []).filter(
    (connector: any) => connector.status === 'sandbox' || connector.mode === 'sandbox',
  );
  const waitingCount = pending.length + connectorProblems.length;

  const storageOk = status.data?.storage?.ok !== false;
  const modelNotes = status.data?.model?.notes?.length ?? 0;
  const systemOk = status.loading ? true : storageOk && modelNotes === 0;

  const dateLine = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="dash-date">{dateLine}</div>
          <h1>{greeting()}, here’s what’s moving.</h1>
          <div className="sub">Your agent, your world, and everything waiting on you.</div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => onNavigate('chat')}>
            🎙️ Talk to Xacheus
          </button>
        </div>
      </div>

      <div className="dash-pills">
        <span className="pill">
          <span className={`dot ${systemOk ? 'ok' : 'bad'}`} />
          <span>System</span>
          <strong>{systemOk ? 'all normal' : 'needs attention'}</strong>
        </span>
        <span className="pill" title={modelNotes ? status.data.model.notes[0] : undefined}>
          <span className={`dot ${status.data?.model?.builtin ? 'mid' : 'ok'}`} />
          <span>Model</span>
          <strong>{status.data?.model?.label ?? '…'}</strong>
        </span>
        <span className="pill">
          <span className={`dot ${storageOk ? 'ok' : 'bad'}`} />
          <span>Storage</span>
          <strong>{status.data?.storage?.id ?? '…'}</strong>
        </span>
      </div>

      {waitingCount ? (
        <div className="card attention" style={{ marginBottom: 14 }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <h3>
              ⏳ Waiting for you{' '}
              <span className="badge" style={{ marginLeft: 2 }}>
                {waitingCount}
              </span>
            </h3>
            {connectorProblems.length ? (
              <button className="small" onClick={() => onNavigate('connect')}>
                Open connectors
              </button>
            ) : null}
          </div>
          <div className="list">
            {pending.map((run) => {
              const step = run.plan.find((entry) => entry.status === 'awaiting_confirmation');
              return (
                <div className="list-item" key={run.id}>
                  <div className="row between">
                    <div>
                      <div className="title">
                        <span className="list-kind approval">approval</span> {step?.title ?? run.request}
                      </div>
                      <div className="meta">
                        {run.request}
                        {step?.confirmationReason ? ` · ${step.confirmationReason}` : ''}
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
            {connectorProblems.slice(0, 4).map((connector: any) => (
              <div className="list-item" key={connector.id}>
                <div className="row between">
                  <div>
                    <div className="title">
                      <span className="list-kind connector">connector</span> {connector.id}
                    </div>
                    <div className="meta">
                      {connector.missingFields?.length ? `missing: ${connector.missingFields.join(', ')}` : 'not connected yet'}
                    </div>
                  </div>
                  <button className="small" onClick={() => onNavigate('connect')}>
                    Configure
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatCard icon="🤖" value={data?.agents ?? '—'} label="Agents" sub="specialists on deck" />
        <StatCard icon="🧰" value={data?.tools ?? '—'} label="Tools" sub="ready to use" />
        <StatCard
          icon="🔌"
          value={data?.connectors ? `${data.connectors.live}/${data.connectors.total}` : '—'}
          label="Connectors"
          sub={data?.connectors ? `${data.connectors.sandbox ?? 0} in sandbox` : undefined}
        />
        <StatCard icon="📚" value={data?.knowledge?.documents ?? 0} label="Documents" sub="in your knowledge base" />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="row between">
            <h3>💼 Your day</h3>
            <button className="small" onClick={() => onNavigate('business')}>
              Business view
            </button>
          </div>
          {brief.error ? (
            <div className="empty">Your daily brief is unavailable right now.</div>
          ) : brief.data ? (
            <>
              <pre className="brief-text">{brief.data.text}</pre>
              {brief.data.priorities?.length ? (
                <div className="list">
                  {brief.data.priorities.slice(0, 3).map((priority: any, index: number) => (
                    <div className="list-item" key={index}>
                      <div className="row between">
                        <span className="title">{priority.title}</span>
                        <span className={`badge risk-${priority.weight === 'high' ? 'high' : 'low'}`}>{priority.weight}</span>
                      </div>
                      <div className="meta">{priority.detail}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty">Loading your brief…</div>
          )}
        </div>

        <div className="card">
          <h3>🧩 Runtime</h3>
          {status.data ? (
            <div className="runtime-rows">
              <div className="runtime-row">
                <span className="k">Model</span>
                <span>
                  {status.data.model.label}{' '}
                  <span className={`badge ${status.data.model.builtin ? 'sandbox' : 'live'}`}>{status.data.model.locality}</span>
                </span>
              </div>
              <div className="runtime-row">
                <span className="k">Storage</span>
                <span>
                  {status.data.storage.id}{' '}
                  <span className={`badge ${status.data.storage.ok ? 'live' : 'danger'}`}>{status.data.storage.ok ? 'healthy' : 'problem'}</span>
                </span>
              </div>
              <div className="runtime-row">
                <span className="k">Android devices</span>
                <span>{status.data.devices.length ? status.data.devices.map((device: any) => device.name).join(', ') : 'none connected'}</span>
              </div>
              <div className="runtime-row">
                <span className="k">Automations</span>
                <span>
                  {status.data.automations.enabled} enabled of {status.data.automations.total}
                </span>
              </div>
              <div className="runtime-row">
                <span className="k">Workspace</span>
                <span className="mono small truncate" title={status.data.workspaceRoot}>
                  {status.data.workspaceRoot}
                </span>
              </div>
            </div>
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

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row between">
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
          <span className="small muted">{lines.length ? `${lines.length} recent events` : 'the event bus, live'}</span>
        </div>
        {lines.length ? (
          <div className="scroll-y feed">
            {lines.map((line, index) => (
              <div className="feed-line" key={index}>
                <span className={`feed-dot ${line.kind}`} />
                <span className="time">{line.at}</span>
                <span className="feed-text">{line.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">Quiet for now. Events stream here the moment agents start working.</div>
        )}
      </div>
    </div>
  );
}

/** A stat card with an icon and a human sub-label. Shows a shimmer while loading. */
function StatCard({ icon, value, label, sub }: { icon: string; value: string | number; label: string; sub?: string }) {
  // '—' is the placeholder used until the stats endpoint answers.
  const loading = value === '—';
  return (
    <div className="card stat">
      <span className="stat-icon">{icon}</span>
      <span className="value">{loading ? <span className="sk" /> : value}</span>
      <span className="label">{label}</span>
      <span className="stat-sub">{sub ?? '\u00A0'}</span>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function kindFor(name: string): FeedLine['kind'] {
  switch (name) {
    case 'run.completed':
    case 'document.ingested':
      return 'ok';
    case 'run.awaiting_confirmation':
    case 'connector.updated':
      return 'warn';
    case 'run.started':
      return 'info';
    case 'inquiry.received':
    case 'automation.fired':
      return 'accent';
    default:
      return 'dim';
  }
}

function describeEvent(event: { name: string; payload?: any }): string {
  const payload = event.payload ?? {};
  switch (event.name) {
    case 'run.started':
      return `run started — “${String(payload.request ?? '').slice(0, 60)}” (${payload.agent})`;
    case 'run.step':
      return `step ${payload.tool ?? ''} ${payload.status ?? ''}`.trim();
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
