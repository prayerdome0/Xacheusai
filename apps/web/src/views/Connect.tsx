/**
 * Xacheus Connect — integrations, permissions and devices.
 *
 * The rule this screen exists to enforce: you always know whether an integration
 * is live or merely simulated, what it is missing, and what Xacheus is allowed to
 * do without asking.
 */
import { useState } from 'react';
import { api, type ConnectorView } from '../api';
import { useAsync } from '../hooks';

export function ConnectView() {
  const [tab, setTab] = useState<'connectors' | 'permissions' | 'devices'>('connectors');
  const pending = useAsync(() => api.pendingRuns(), []);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Xacheus Connect</h1>
          <div className="sub">Every integration is a tool. You authorize it, Xacheus uses it, and the audit log records it.</div>
        </div>
        <div className="row">
          <button className={tab === 'connectors' ? 'primary' : ''} onClick={() => setTab('connectors')}>
            🔌 Connectors
          </button>
          <button className={tab === 'permissions' ? 'primary' : ''} onClick={() => setTab('permissions')}>
            🛡️ Permissions
          </button>
          <button className={tab === 'devices' ? 'primary' : ''} onClick={() => setTab('devices')}>
            📱 Devices
          </button>
        </div>
      </div>
      {pending.data?.runs.length ? (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          {pending.data.runs.length} action(s) are waiting for your approval — see the Dashboard or the chat thread.
        </div>
      ) : null}
      {tab === 'connectors' ? <ConnectorsTab /> : tab === 'permissions' ? <PermissionsTab /> : <DevicesTab />}
    </div>
  );
}

function ConnectorsTab() {
  const connectors = useAsync(() => api.connectors(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async (connector: ConnectorView) => {
    setBusy(true);
    try {
      const payload = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      if (!Object.keys(payload).length) {
        setStatus((current) => ({ ...current, [connector.manifest.id]: 'Nothing to save yet.' }));
        return;
      }
      const result = await api.saveConnectorConfig(payload);
      setStatus((current) => ({ ...current, [connector.manifest.id]: `Saved. Model layer: ${result.model}` }));
      setValues({});
      connectors.reload();
    } catch (problem) {
      setStatus((current) => ({ ...current, [connector.manifest.id]: problem instanceof Error ? problem.message : String(problem) }));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (connector: ConnectorView) => {
    setStatus((current) => ({ ...current, [connector.manifest.id]: 'Checking…' }));
    const result = await api.verifyConnector(connector.manifest.id);
    setStatus((current) => ({ ...current, [connector.manifest.id]: (result.ok ? '✓ ' : '✕ ') + result.detail }));
  };

  return (
    <div className="grid cols-2">
      {(connectors.data?.connectors ?? []).map((connector) => {
        const isOpen = open === connector.manifest.id;
        return (
          <div className="card" key={connector.manifest.id}>
            <div className="row between">
              <h3>
                {connector.manifest.name}{' '}
                <span className={`badge ${connector.status.mode === 'live' ? 'live' : 'sandbox'}`}>{connector.status.mode}</span>
              </h3>
              <div className="row">
                <button className="small" onClick={() => verify(connector)}>
                  Test
                </button>
                <button className="small" onClick={() => setOpen(isOpen ? null : connector.manifest.id)}>
                  {isOpen ? 'Close' : 'Configure'}
                </button>
              </div>
            </div>

            <p className="small">{connector.manifest.description}</p>
            <div className="row small">
              {connector.manifest.capabilities.slice(0, 4).map((capability) => (
                <span className="badge" key={capability}>
                  {capability}
                </span>
              ))}
            </div>

            {connector.status.missingFields.length ? (
              <div className="banner warn" style={{ marginTop: 10 }}>
                Running in sandbox mode — nothing is sent anywhere. Missing: {connector.status.missingFields.join(', ')}
              </div>
            ) : (
              <div className="banner info" style={{ marginTop: 10 }}>
                Credentials present. Calls go to the real service.
              </div>
            )}

            {isOpen ? (
              <div style={{ marginTop: 10 }}>
                {connector.manifest.fields.map((field) => (
                  <div key={field.key}>
                    <label>
                      {field.label}
                      {field.required ? ' *' : ''}
                    </label>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      placeholder={connector.status.display[field.key] ?? field.hint ?? ''}
                      value={values[field.key] ?? ''}
                      onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                    />
                    {field.hint ? <div className="field-hint">{field.hint}</div> : null}
                  </div>
                ))}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="primary" disabled={busy} onClick={() => save(connector)}>
                    Save credentials
                  </button>
                  {connector.manifest.docsUrl ? (
                    <a className="button small" href={connector.manifest.docsUrl} target="_blank" rel="noreferrer">
                      Documentation
                    </a>
                  ) : null}
                </div>
                {status[connector.manifest.id] ? (
                  <div className="banner info" style={{ marginTop: 10 }}>
                    {status[connector.manifest.id]}
                  </div>
                ) : null}
                <div className="small muted" style={{ marginTop: 10 }}>
                  Secrets are stored server-side and never sent back to this browser — reads are masked. Prefer the .env file for
                  anything long-lived.
                </div>

                <h4 style={{ marginTop: 14 }}>Tools from this connector</h4>
                <table>
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Risk</th>
                      <th>Approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connector.operations.map((operation) => (
                      <tr key={operation.id}>
                        <td className="mono small">{operation.toolId}</td>
                        <td>
                          <span className={`badge risk-${operation.risk}`}>{operation.risk}</span>
                        </td>
                        <td className="small muted">{operation.requiresConfirmation ? 'always asks' : 'per policy'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PermissionsTab() {
  const permissions = useAsync(() => api.permissions(), []);
  const [busy, setBusy] = useState(false);
  const granted: string[] = permissions.data?.grantedScopes ?? [];
  const all: string[] = permissions.data?.allScopes ?? [];

  const toggle = async (scope: string) => {
    setBusy(true);
    try {
      await api.setScopes([scope], !granted.includes(scope));
      permissions.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Permission scopes</h3>
        <p className="small">
          Xacheus ships able to read, draft and compute. Anything that reaches other people or changes your world — publishing,
          sending, controlling devices, running commands — stays off until you grant it here.
        </p>
        <div className="list scroll-y">
          {all.map((scope) => {
            const on = granted.includes(scope);
            return (
              <div className="list-item" key={scope}>
                <div className="row between">
                  <span className="mono">{scope}</span>
                  <button className={`small ${on ? 'danger' : 'primary'}`} disabled={busy} onClick={() => toggle(scope)}>
                    {on ? 'Revoke' : 'Grant'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h3>Tool policies</h3>
        <p className="small">
          Per-tool control: switch a tool off entirely, or change when it must ask for confirmation. Revoking takes effect
          immediately — the agent reports the block instead of failing silently.
        </p>
        <div className="scroll-y">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Enabled</th>
                <th>Confirmation</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(permissions.data?.tools ?? {}).slice(0, 120).map(([id, policy]: [string, any]) => (
                <tr key={id}>
                  <td className="mono small">{id}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={policy.enabled}
                      onChange={(event) => api.setToolPolicy(id, { enabled: event.target.checked }).then(() => permissions.reload())}
                    />
                  </td>
                  <td>
                    <select
                      value={policy.confirmation}
                      onChange={(event) => api.setToolPolicy(id, { confirmation: event.target.value }).then(() => permissions.reload())}
                    >
                      <option value="risk-based">risk-based</option>
                      <option value="always">always ask</option>
                      <option value="never">never ask</option>
                    </select>
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

function DevicesTab() {
  const devices = useAsync(() => api.devices(), []);
  const [pairId, setPairId] = useState('');
  const [pairName, setPairName] = useState('');
  const [command, setCommand] = useState('device.info');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string | null>(null);

  const connected = devices.data?.connected ?? [];
  const paired = devices.data?.paired ?? [];
  const target = connected[0]?.deviceId ?? paired[0]?.id;

  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Android devices</h3>
        <p className="small">
          The companion app dials this backend over a WebSocket, so the phone stays behind NAT and Android keeps full control of
          permissions, battery and privacy. Xacheus can ask the phone to do something; the phone decides whether it may.
        </p>

        <h4>Connected now</h4>
        <div className="list">
          {connected.map((device: any) => (
            <div className="list-item" key={device.deviceId}>
              <div className="row between">
                <div>
                  <div className="title">{device.name}</div>
                  <div className="meta mono small">{device.deviceId}</div>
                </div>
                <span className="badge live">connected</span>
              </div>
              <div className="meta small">capabilities: {device.capabilities?.length ?? 0} commands</div>
            </div>
          ))}
          {!connected.length ? <div className="empty">No device connected. Open the Xacheus Android app to pair.</div> : null}
        </div>

        <h4 style={{ marginTop: 14 }}>Paired</h4>
        <div className="list">
          {paired.map((device: any) => (
            <div className="list-item" key={device.id}>
              <div className="row between">
                <div>
                  <div className="title">{device.name}</div>
                  <div className="meta small">paired {new Date(device.pairedAt).toLocaleString()}</div>
                </div>
                <button className="small danger" onClick={() => api.unpairDevice(device.id).then(() => devices.reload())}>
                  Unpair
                </button>
              </div>
            </div>
          ))}
          {!paired.length ? <div className="empty">Nothing paired yet.</div> : null}
        </div>

        <h4 style={{ marginTop: 14 }}>Pair manually</h4>
        <div className="row">
          <input placeholder="device id" value={pairId} onChange={(event) => setPairId(event.target.value)} />
          <input placeholder="name" value={pairName} onChange={(event) => setPairName(event.target.value)} />
          <button
            className="primary"
            disabled={!pairId.trim()}
            onClick={() => api.pairDevice(pairId.trim(), pairName.trim() || 'Android device').then(() => devices.reload())}
          >
            Pair
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Send a device command</h3>
        <p className="small">
          Direct tester for the bridge. Commands that need approval (calls, SMS, settings) are gated by policy — this panel bypasses
          the conversational planner, not the permission engine.
        </p>
        <label>Command</label>
        <select value={command} onChange={(event) => setCommand(event.target.value)}>
          {(devices.data?.commands ?? ['device.info']).map((name: string) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label>Arguments (JSON)</label>
        <textarea rows={3} value={args} onChange={(event) => setArgs(event.target.value)} />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            disabled={!target}
            onClick={async () => {
              try {
                const parsed = args.trim() ? JSON.parse(args) : {};
                const response = await api.deviceCommand(target, command, parsed);
                setResult(`${response.result.mode}: ${response.result.summary}`);
              } catch (problem) {
                setResult(problem instanceof Error ? problem.message : String(problem));
              }
            }}
          >
            Send
          </button>
          {!target ? <span className="small muted">No device to send to.</span> : null}
        </div>
        {result ? (
          <div className="banner info" style={{ marginTop: 10 }}>
            {result}
          </div>
        ) : null}

        <h4 style={{ marginTop: 16 }}>Recent commands</h4>
        <div className="list scroll-y">
          {(devices.data?.recentCommands ?? []).map((entry, index) => (
            <div className="list-item" key={index}>
              <div className={`badge ${entry.mode === 'live' ? 'live' : 'sandbox'}`}>{entry.mode}</div>
              <div className="small">{entry.summary}</div>
            </div>
          ))}
          {!devices.data?.recentCommands?.length ? <div className="empty">No commands sent yet.</div> : null}
        </div>
      </div>
    </div>
  );
}
