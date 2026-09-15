/**
 * Automations + audit.
 * The automation engine is where a private agent earns its keep — and where the
 * "no unattended high-impact actions" rule is visible: steps that need approval
 * surface as notifications instead of running by themselves.
 */
import { useState } from 'react';
import { api } from '../api';
import { useAsync, usePolling } from '../hooks';

export function AutomateView() {
  const automations = useAsync(() => api.automations(), []);
  const audit = usePolling(() => api.audit({ limit: 80 }), 10000);
  const tools = useAsync(() => api.tools(), []);
  const [draft, setDraft] = useState({
    name: '',
    triggerType: 'schedule',
    at: '07:30',
    everyMinutes: '60',
    event: 'inquiry.received',
    actionTool: 'business.todayBrief',
    notify: true,
  });
  const [message, setMessage] = useState<string | null>(null);

  const create = async () => {
    setMessage(null);
    try {
      await api.createAutomation({
        name: draft.name || `${draft.triggerType} → ${draft.actionTool}`,
        trigger:
          draft.triggerType === 'schedule'
            ? { type: 'schedule', at: draft.at }
            : draft.triggerType === 'interval'
              ? { type: 'interval', everyMinutes: Number(draft.everyMinutes) }
              : draft.triggerType === 'event'
                ? { type: 'event', event: draft.event }
                : { type: 'manual' },
        actions: [{ tool: draft.actionTool, input: {} }],
        notify: draft.notify,
        enabled: true,
      });
      automations.reload();
      setMessage('Automation created.');
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : String(problem));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Automations &amp; activity</h1>
          <div className="sub">TRIGGER → CONDITION → PLAN → TOOLS → ACTION → RESULT → NOTIFICATION.</div>
        </div>
        <button onClick={() => automations.reload()}>Refresh</button>
      </div>

      <div className="banner info" style={{ marginBottom: 14 }}>
        Automations never perform an action that needs your approval. When a rule reaches such a step it raises an approval request
        instead, and the action runs only after you approve it.
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Create an automation</h3>
          <label>Name</label>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Morning brief" />
          <label>Trigger</label>
          <select value={draft.triggerType} onChange={(event) => setDraft({ ...draft, triggerType: event.target.value })}>
            <option value="schedule">Every day at a time</option>
            <option value="interval">Every N minutes</option>
            <option value="event">When an event happens</option>
            <option value="manual">Only when I ask</option>
          </select>
          {draft.triggerType === 'schedule' ? (
            <>
              <label>Time (HH:MM)</label>
              <input value={draft.at} onChange={(event) => setDraft({ ...draft, at: event.target.value })} />
            </>
          ) : draft.triggerType === 'interval' ? (
            <>
              <label>Minutes between runs</label>
              <input value={draft.everyMinutes} onChange={(event) => setDraft({ ...draft, everyMinutes: event.target.value })} />
            </>
          ) : draft.triggerType === 'event' ? (
            <>
              <label>Event</label>
              <select value={draft.event} onChange={(event) => setDraft({ ...draft, event: event.target.value })}>
                {['inquiry.received', 'message.received', 'document.ingested', 'run.completed', 'notification.created', 'automation.fired'].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label>Run this tool</label>
          <select value={draft.actionTool} onChange={(event) => setDraft({ ...draft, actionTool: event.target.value })}>
            {(tools.data?.tools ?? [])
              .filter((tool: any) => !tool.requiresConfirmation && tool.risk !== 'critical')
              .map((tool: any) => (
                <option key={tool.id} value={tool.id}>
                  {tool.id} — {tool.name}
                </option>
              ))}
          </select>
          <label className="toggle" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={draft.notify} onChange={(event) => setDraft({ ...draft, notify: event.target.checked })} />
            Notify me when it runs
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={create}>
              Create
            </button>
          </div>
          {message ? (
            <div className="banner info" style={{ marginTop: 10 }}>
              {message}
            </div>
          ) : null}
        </div>

        <div className="card">
          <h3>Your automations ({automations.data?.automations.length ?? 0})</h3>
          <div className="list scroll-y">
            {(automations.data?.automations ?? []).map((automation: any) => (
              <div className="list-item" key={automation.id}>
                <div className="row between">
                  <div className="title">
                    {automation.enabled ? '●' : '○'} {automation.name}
                  </div>
                  <div className="row">
                    <button
                      className="small"
                      onClick={() => api.updateAutomation(automation.id, { enabled: !automation.enabled }).then(() => automations.reload())}
                    >
                      {automation.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="small" onClick={() => api.runAutomation(automation.id).then(() => automations.reload())}>
                      Run now
                    </button>
                    <button className="small danger" onClick={() => api.deleteAutomation(automation.id).then(() => automations.reload())}>
                      Delete
                    </button>
                  </div>
                </div>
                <div className="meta">
                  {automation.trigger.type}
                  {automation.trigger.at ? ` at ${automation.trigger.at}` : ''}
                  {automation.trigger.everyMinutes ? ` every ${automation.trigger.everyMinutes}m` : ''}
                  {automation.trigger.event ? ` on ${automation.trigger.event}` : ''} → {automation.actions.map((action: any) => action.tool).join(', ')}
                  {automation.lastStatus ? ` · last: ${automation.lastStatus}` : ''} · runs: {automation.runCount}
                </div>
              </div>
            ))}
            {automations.data && !automations.data.automations.length ? <div className="empty">No automations yet.</div> : null}
          </div>

          <h3 style={{ marginTop: 16 }}>Starters</h3>
          <div className="list">
            {(automations.data?.starters ?? []).map((starter: any, index: number) => (
              <div className="list-item" key={starter.name}>
                <div className="row between">
                  <div>
                    <div className="title">{starter.name}</div>
                    <div className="meta">{starter.description}</div>
                  </div>
                  <button className="small primary" onClick={() => api.createStarter(index).then(() => automations.reload())}>
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row between">
          <h3>Audit log</h3>
          <div className="row small muted">
            <span>{audit.data?.stats?.total ?? 0} entries</span>
            <span>·</span>
            <span>{audit.data?.stats?.denied ?? 0} denied</span>
            <span>·</span>
            <span>{audit.data?.stats?.last24h ?? 0} in the last day</span>
          </div>
        </div>
        <div className="scroll-y">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Stage</th>
                <th>Decision</th>
                <th>Action</th>
                <th>Tool</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data?.entries ?? []).map((entry: any) => (
                <tr key={entry.id}>
                  <td className="small muted">{new Date(entry.at).toLocaleTimeString()}</td>
                  <td>
                    <span className="badge">{entry.stage}</span>
                  </td>
                  <td>
                    <span className={`badge ${entry.decision === 'denied' ? 'danger' : entry.decision === 'executed' ? 'live' : entry.decision === 'pending' ? 'sandbox' : ''}`}>
                      {entry.decision}
                    </span>
                  </td>
                  <td className="truncate" style={{ maxWidth: 220 }}>
                    {entry.action}
                  </td>
                  <td className="mono small">{entry.tool ?? '—'}</td>
                  <td className="small muted truncate" style={{ maxWidth: 300 }}>
                    {entry.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
