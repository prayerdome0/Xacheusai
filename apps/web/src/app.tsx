/**
 * App shell: unlock, navigation, and the Firebase-or-passcode sign-in gate.
 */
import { useEffect, useState } from 'react';
import { api, getToken, setToken, type PublicConfig } from './api';
import { ChatView } from './views/Chat';
import { DashboardView } from './views/Dashboard';
import { LibraryView } from './views/Library';
import { BusinessView } from './views/Business';
import { AutomateView } from './views/Automate';
import { ConnectView } from './views/Connect';
import { SettingsView } from './views/Settings';

const NAV = [
  { id: 'dashboard', label: 'Control Center', icon: '🧭' },
  { id: 'chat', label: 'Voice & Chat', icon: '🎙️' },
  { id: 'library', label: 'Library', icon: '📚' },
  { id: 'business', label: 'Business', icon: '💼' },
  { id: 'automate', label: 'Automations', icon: '⚙️' },
  { id: 'connect', label: 'Connect', icon: '🔌' },
  { id: 'settings', label: 'Settings', icon: '🧠' },
];

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [unlocked, setUnlocked] = useState(Boolean(getToken()));
  const [view, setView] = useState('dashboard');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Xacheus AI — Control Center';
    api
      .publicConfig()
      .then((data) => {
        setConfig(data);
        // No credentials required at all (local single-owner mode).
        if (!data.auth.requiresPasscode && !data.auth.firebaseEnabled) setUnlocked(true);
      })
      .catch((problem) => setError(problem instanceof Error ? problem.message : String(problem)));
  }, []);

  if (error) {
    return (
      <div className="main">
        <div className="banner danger">Could not reach the Xacheus backend: {error}</div>
      </div>
    );
  }

  if (!config) return <div className="main muted">Starting Xacheus…</div>;

  if (!unlocked) {
    return <UnlockScreen config={config} onUnlocked={() => setUnlocked(true)} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand brand-link" href="/" title="Back to the landing page">
          <div className="brand-mark">🧠</div>
          <div>
            <div className="brand-name">Xacheus AI</div>
            <div className="brand-sub">
              private agent · {config.features.storage}
              {config.features.durableStorage === false ? ' (temporary)' : ''}
            </div>
          </div>
        </a>
        {NAV.map((item) => (
          <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}>
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <div className="card tight">
          <div className="small muted">Model</div>
          <div className="small">{config.features.model}</div>
          {config.features.modelBuiltin ? <span className="badge sandbox">built-in planner</span> : <span className="badge live">model connected</span>}
        </div>
      </aside>

      <main className="main">
        {view === 'dashboard' ? <DashboardView onNavigate={setView} /> : null}
        {view === 'chat' ? <ChatView onNavigate={setView} /> : null}
        {view === 'library' ? <LibraryView /> : null}
        {view === 'business' ? <BusinessView /> : null}
        {view === 'automate' ? <AutomateView /> : null}
        {(config.features.durableStorage === false || config.features.websockets === false) && view === 'dashboard' ? (
          <div className="banner warn" style={{ marginBottom: 14 }}>
            <strong>This deployment is running without durable storage.</strong>{' '}
            {config.features.runtime === 'serverless'
              ? 'Serverless functions get a fresh, temporary filesystem per instance, so anything you store can disappear. Set '
              : 'The filesystem here is writable but temporary — set '}
            <code>XACHEUS_STORAGE=firestore</code> with a Firebase service account for persistence, and keep the audit log somewhere that survives.
            {config.features.websockets === false
              ? ' WebSockets are also unavailable on this host, so the console polls for updates and the Android app uses its polling device transport.'
              : ''}
            {' '}
            See <code>DEPLOY.md</code>.
          </div>
        ) : null}
        {view === 'connect' ? <ConnectView /> : null}
        {view === 'settings' ? <SettingsView /> : null}
      </main>
    </div>
  );
}

function UnlockScreen({ config, onUnlocked }: { config: PublicConfig; onUnlocked: () => void }) {
  const [passcode, setPasscode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'passcode' | 'firebase'>(config.auth.firebaseEnabled ? 'firebase' : 'passcode');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPasscode = async () => {
    setBusy(true);
    setError(null);
    try {
      setToken(passcode);
      await api.status();
      onUnlocked();
    } catch (problem) {
      setToken('');
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const submitFirebase = async () => {
    setBusy(true);
    setError(null);
    try {
      // Loaded lazily so the console works without Firebase configured.
      const { initializeApp } = await import('firebase/app');
      const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');
      const app = initializeApp({
        apiKey: config.firebase.apiKey,
        authDomain: config.firebase.authDomain,
        projectId: config.firebase.projectId,
        storageBucket: config.firebase.storageBucket,
        messagingSenderId: config.firebase.messagingSenderId,
        appId: config.firebase.appId,
      });
      const auth = getAuth(app);
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const token = await credential.user.getIdToken();
      setToken(token);
      await api.status();
      onUnlocked();
    } catch (problem) {
      setToken('');
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="main" style={{ maxWidth: 480, margin: '8vh auto' }}>
      <div className="card">
        <div className="brand" style={{ paddingBottom: 6 }}>
          <div className="brand-mark">🧠</div>
          <div>
            <div className="brand-name">Xacheus AI</div>
            <div className="brand-sub">private personal + business agent</div>
          </div>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <button className={mode === 'firebase' ? 'primary small' : 'small'} onClick={() => setMode('firebase')} disabled={!config.auth.firebaseEnabled}>
            Firebase sign-in
          </button>
          <button className={mode === 'passcode' ? 'primary small' : 'small'} onClick={() => setMode('passcode')} disabled={!config.auth.requiresPasscode}>
            Owner passcode
          </button>
        </div>

        {mode === 'firebase' && config.auth.firebaseEnabled ? (
          <>
            <label>Email</label>
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
            <label>Password</label>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={busy || !email || !password} onClick={submitFirebase}>
                Sign in
              </button>
              <span className="small muted">Project: {config.firebase.projectId}</span>
            </div>
          </>
        ) : (
          <>
            <label>Owner passcode</label>
            <input
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && passcode && submitPasscode()}
              placeholder="XACHEUS_OWNER_PASSCODE"
            />
            <div className="field-hint">The value you set in .env on the server. Stored only in this browser.</div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={busy || !passcode} onClick={submitPasscode}>
                Unlock
              </button>
            </div>
          </>
        )}

        {error ? (
          <div className="banner danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        {!config.auth.requiresPasscode && !config.auth.firebaseEnabled ? (
          <div className="banner warn" style={{ marginTop: 12 }}>
            No credentials are configured on the server, so the API is open to anyone who can reach it. Set
            XACHEUS_OWNER_PASSCODE before exposing this outside your own machine.
          </div>
        ) : null}
      </div>
    </div>
  );
}
