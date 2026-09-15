/**
 * Business — the Xacheus Business Agent's data, editable.
 * Company details, the brief, pipeline, tasks, products and customers.
 */
import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';

export function BusinessView() {
  const business = useAsync(() => api.business(), []);
  const [busy, setBusy] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', value: '', note: '' });
  const [newTask, setNewTask] = useState('');

  const snapshot = business.data?.snapshot;
  const currency = snapshot?.company?.currency ?? '';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Business</h1>
          <div className="sub">The data your Business Agent answers from. Everything here is yours and editable.</div>
        </div>
        <button onClick={() => business.reload()}>Refresh</button>
      </div>

      {!snapshot ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card stat">
              <span className="value">
                {currency} {snapshot.salesThisMonth.revenue.toFixed(2)}
              </span>
              <span className="label">Revenue this month</span>
            </div>
            <div className="card stat">
              <span className="value">{snapshot.leads.filter((lead: any) => !['won', 'lost'].includes(lead.stage)).length}</span>
              <span className="label">Active leads</span>
            </div>
            <div className="card stat">
              <span className="value">{snapshot.tasks.filter((task: any) => !task.done).length}</span>
              <span className="label">Open tasks</span>
            </div>
            <div className="card stat">
              <span className="value">{snapshot.products.length}</span>
              <span className="label">Products</span>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>🏢 Company</h3>
              <label>Name</label>
              <input
                defaultValue={snapshot.company.name}
                onBlur={(event) =>
                  event.target.value !== snapshot.company.name &&
                  api.updateCompany({ name: event.target.value }).then(() => business.reload())
                }
              />
              <label>Industry</label>
              <input
                defaultValue={snapshot.company.industry}
                onBlur={(event) =>
                  event.target.value !== snapshot.company.industry &&
                  api.updateCompany({ industry: event.target.value }).then(() => business.reload())
                }
              />
              <label>Currency</label>
              <input
                defaultValue={snapshot.company.currency}
                onBlur={(event) =>
                  event.target.value !== snapshot.company.currency &&
                  api.updateCompany({ currency: event.target.value }).then(() => business.reload())
                }
              />
              <div className="field-hint">Changes apply immediately — ask Xacheus about your business afterwards.</div>
            </div>

            <div className="card">
              <h3>✅ Tasks</h3>
              <div className="row">
                <input value={newTask} placeholder="Add a task" onChange={(event) => setNewTask(event.target.value)} />
                <button
                  className="primary"
                  disabled={busy || !newTask.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.addTask(newTask.trim());
                      setNewTask('');
                      business.reload();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Add
                </button>
              </div>
              <div className="list scroll-y" style={{ marginTop: 10 }}>
                {snapshot.tasks.map((task: any) => (
                  <div className="list-item" key={task.id}>
                    <div className="row between">
                      <span className={task.done ? 'muted' : ''}>
                        {task.done ? '☑' : '☐'} {task.title}
                      </span>
                      {!task.done ? (
                        <button
                          className="small ghost"
                          onClick={() =>
                            api.addTask(`(complete) ${task.title}`).then(() => business.reload()).catch(() => business.reload())
                          }
                        >
                          mark done in chat
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {!snapshot.tasks.length ? <div className="empty">No tasks.</div> : null}
              </div>
              <div className="field-hint">Say “complete the task …” in chat to close one out.</div>
            </div>

            <div className="card">
              <h3>🎯 Pipeline</h3>
              <div className="grid cols-3">
                <input placeholder="Lead name" value={newLead.name} onChange={(event) => setNewLead({ ...newLead, name: event.target.value })} />
                <input placeholder="Value" value={newLead.value} onChange={(event) => setNewLead({ ...newLead, value: event.target.value })} />
                <button
                  className="primary"
                  disabled={!newLead.name.trim()}
                  onClick={async () => {
                    await api.addLead({ name: newLead.name, value: Number(newLead.value) || 0, note: newLead.note || undefined });
                    setNewLead({ name: '', value: '', note: '' });
                    business.reload();
                  }}
                >
                  Add lead
                </button>
              </div>
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Stage</th>
                    <th>Value</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.leads.map((lead: any) => (
                    <tr key={lead.id}>
                      <td>
                        {lead.name}
                        {lead.note ? <div className="meta small muted">{lead.note}</div> : null}
                      </td>
                      <td>
                        <span className={`badge ${['won'].includes(lead.stage) ? 'live' : lead.stage === 'stale' ? 'danger' : 'info'}`}>{lead.stage}</span>
                      </td>
                      <td>
                        {currency} {lead.value.toFixed(2)}
                      </td>
                      <td className="small muted">{new Date(lead.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!snapshot.leads.length ? <div className="empty">No leads yet.</div> : null}
            </div>

            <div className="card">
              <h3>📦 Products</h3>
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Price</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.products.map((product: any) => (
                    <tr key={product.id}>
                      <td>
                        {product.name}
                        <div className="meta small muted">{product.blurb}</div>
                      </td>
                      <td>
                        {currency} {product.price.toFixed(2)}
                      </td>
                      <td className="small muted">{product.tags.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field-hint">
                Import a real catalogue by talking to Xacheus (“import this CSV”) or through the business.importCsv tool.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
