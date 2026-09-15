/**
 * Landing page — the public face of Xacheus AI.
 *
 * Served at `/` (everything else is the Control Center at /console). It is
 * intentionally dependency-free: no images, no fonts, no data fetches — just
 * the same design language as the console, aimed outward.
 */
import { useEffect } from 'react';

export function Landing() {
  useLandingEffects();

  return (
    <div className="ln">
      <Nav />
      <main>
        <Hero />
        <TrustStrip />
        <Features />
        <HowItWorks />
        <Privacy />
        <QuickStart />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

function useLandingEffects() {
  useEffect(() => {
    document.title = 'Xacheus AI — Your private AI agent that does the work';
  }, []);

  // Reveal-on-scroll. A timeout fallback guarantees content is never left
  // hidden if IntersectionObserver is missing or stubbed (e.g. render checks).
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    const fallback = window.setTimeout(() => els.forEach((el) => el.classList.add('in')), 2500);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);
}

/* --------------------------------------------------------------------- nav */

function Nav() {
  const links = [
    { href: '#product', label: 'Product' },
    { href: '#how', label: 'How it works' },
    { href: '#privacy', label: 'Privacy' },
    { href: '#quickstart', label: 'Quick start' },
  ];
  return (
    <header className="ln-nav">
      <a className="ln-brand" href="/" aria-label="Xacheus AI home">
        <span className="ln-brand-mark">🧠</span>
        <span className="ln-brand-name">Xacheus AI</span>
      </a>
      <nav className="ln-nav-links" aria-label="Page sections">
        {links.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <a className="btn primary ln-nav-cta" href="/console">
        Open the console
      </a>
    </header>
  );
}

/* -------------------------------------------------------------------- hero */

function Hero() {
  return (
    <section className="ln-hero">
      <div className="ln-wrap ln-hero-grid">
        <div className="ln-hero-copy">
          <div className="ln-eyebrow reveal">
            <span className="ln-eyebrow-dot" /> Private by design · zero credentials to start
          </div>
          <h1 className="reveal">
            Your private AI agent
            <br />
            that <em>does</em> the work.
          </h1>
          <p className="reveal">
            You say <strong>“Xacheus, handle this for me.”</strong> It plans, uses your tools,
            remembers your context, acts on your world — and shows you every step. No shared cloud,
            no account, no data you can’t read.
          </p>
          <div className="ln-cta-row reveal">
            <a className="btn primary" href="/console">
              Open your console
            </a>
            <a className="btn ghost" href="#how">
              See how it works
            </a>
          </div>
          <ul className="ln-hero-facts reveal">
            <li>
              <span>🖥️</span> Runs on your machine
            </li>
            <li>
              <span>🗂️</span> Your data, in plain files
            </li>
            <li>
              <span>🔌</span> Built-in planner — or your own model
            </li>
          </ul>
        </div>
        <HeroMock />
      </div>
    </section>
  );
}

/** A living, animated mock of the real Control Center — pure HTML/CSS. */
function HeroMock() {
  return (
    <div className="lm reveal" aria-hidden="true">
      <div className="lm-bar">
        <span className="lm-tl" />
        <span className="lm-tl" />
        <span className="lm-tl" />
        <span className="lm-title">Xacheus — Control Center</span>
        <span className="lm-url">localhost:8787/console</span>
      </div>
      <div className="lm-body">
        <div className="lm-bubble owner">
          Xacheus, handle this for me — reply to Dana, book the 3 pm slot, and make sure the house
          is off when I leave.
        </div>
        <div className="lm-bubble agent">
          <div className="lm-who">
            <span className="lm-who-mark">🧠</span> Xacheus · planning
          </div>
          On it — three steps:
          <div className="lm-plan">
            <div className="lm-step s1">
              <span className="lm-step-dot" />
              <span className="lm-step-label">Draft reply to Dana</span>
              <span className="lm-step-state">✓ done</span>
            </div>
            <div className="lm-step s2">
              <span className="lm-step-dot" />
              <span className="lm-step-label">Book the 3:00 slot in your calendar</span>
              <span className="lm-step-state">✓ done</span>
            </div>
            <div className="lm-step s3">
              <span className="lm-step-dot" />
              <span className="lm-step-label">Smart home: lights off + alarm when you leave</span>
              <span className="lm-approve">Approve</span>
            </div>
          </div>
        </div>
        <div className="lm-feed">
          <span className="lm-feed-dots" />
          run completed in 4.2 s · memory updated · automation “morning brief” fired
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- trust strip */

function TrustStrip() {
  const items = [
    { icon: '🖥️', title: 'Runs on your machine', sub: 'The server is yours — your laptop, a homelab box, or wherever you deploy it.' },
    { icon: '🗂️', title: 'Plain-file data', sub: 'Readable, back-up-able, deletable. No black-box database you can’t open.' },
    { icon: '🔑', title: 'Zero credentials to start', sub: 'The built-in planner works out of the box. Add keys only for what you want live.' },
    { icon: '🧠', title: 'Your model, your choice', sub: 'Local, API, or built-in — swap model layers in one env variable.' },
  ];
  return (
    <section className="ln-strip">
      <div className="ln-wrap ln-strip-grid">
        {items.map((item, index) => (
          <div className="ln-strip-item reveal" key={item.title} style={{ transitionDelay: `${index * 70}ms` }}>
            <span className="ln-strip-icon">{item.icon}</span>
            <div>
              <div className="ln-strip-title">{item.title}</div>
              <div className="ln-strip-sub">{item.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- features */

function Features() {
  const features = [
    {
      icon: '🎙️',
      title: 'Voice & chat',
      body: 'Talk to it from the browser or your phone. Push-to-talk, wake word on Android, spoken replies — a real conversation, not a form.',
      tag: 'Control Center · Voice & Chat',
    },
    {
      icon: '🧠',
      title: 'Memory & knowledge',
      body: 'It remembers your context, indexes your documents, and searches them while it plans — then tells you what it remembers.',
      tag: 'Library',
    },
    {
      icon: '📅',
      title: 'Automations',
      body: 'Scheduled and triggered jobs that keep running your recurring life — briefs, check-ins, hand-offs — while you do anything else.',
      tag: 'Automations',
    },
    {
      icon: '📱',
      title: 'Phone & smart home',
      body: 'The Android companion bridges Xacheus to your device: wake word, notifications, device actions, and smart-home hand-off.',
      tag: 'Connect',
    },
    {
      icon: '✅',
      title: 'Approvals & audit',
      body: 'Risky steps pause for your explicit yes or no. Every action lands in an audit log you can read, filter, and keep.',
      tag: 'Control Center',
    },
    {
      icon: '🔌',
      title: 'Connectors',
      body: 'Mail, home, cloud, and more. Each runs in a safe sandbox until you hand over credentials — live the moment you do.',
      tag: 'Connect',
    },
  ];
  return (
    <section id="product" className="ln-section">
      <div className="ln-wrap">
        <div className="ln-section-head reveal">
          <div className="ln-kicker">Product</div>
          <h2>A control center for your agent</h2>
          <p>
            One interface for everything it does — chat and voice, memory, business context,
            automations, devices, and the audit trail.
          </p>
        </div>
        <div className="ln-feature-grid">
          {features.map((feature, index) => (
            <div className="ln-feature reveal" key={feature.title} style={{ transitionDelay: `${(index % 3) * 80}ms` }}>
              <div className="ln-feature-top">
                <span className="ln-feature-icon">{feature.icon}</span>
                <span className="ln-feature-tag">{feature.tag}</span>
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- how it works */

function HowItWorks() {
  const steps = [
    {
      n: '01',
      icon: '💬',
      title: 'Talk',
      body: '“Xacheus, handle this for me.” One sentence — voice or text — says it all. You never learn a prompt language.',
    },
    {
      n: '02',
      icon: '🧩',
      title: 'Plans & acts',
      body: 'The master agent breaks it into steps, delegates to specialist agents, and uses your tools and connectors to get it done.',
    },
    {
      n: '03',
      icon: '👁️',
      title: 'Shows you',
      body: 'Every step streams into the Control Center. It asks before anything risky, and the audit log keeps the receipts.',
    },
  ];
  return (
    <section id="how" className="ln-section ln-section-alt">
      <div className="ln-wrap">
        <div className="ln-section-head reveal">
          <div className="ln-kicker">How it works</div>
          <h2>Say it. It plans it. It does it. You see all of it.</h2>
        </div>
        <div className="ln-steps">
          {steps.map((step, index) => (
            <div className="ln-step reveal" key={step.n} style={{ transitionDelay: `${index * 90}ms` }}>
              <div className="ln-step-n">{step.n}</div>
              <div className="ln-step-icon">{step.icon}</div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- privacy */

function Privacy() {
  const points = [
    {
      title: 'Your data is plain files',
      body: 'On your machine, in formats you can open. Read them, back them up, delete them — “right to be forgotten” is one rm away.',
    },
    {
      title: 'No account, no lock-in',
      body: 'Starts with the built-in planner and zero credentials. Bring your own model API key or local model when you want more.',
    },
    {
      title: 'Gate it before you share it',
      body: 'Exposing it anywhere? Put a passcode or Firebase sign-in in front. The console warns you when the API is wide open.',
    },
    {
      title: 'Honest about what it can’t keep',
      body: 'Running serverless or on throwaway storage? The console tells you in plain words instead of silently forgetting things.',
    },
  ];
  return (
    <section id="privacy" className="ln-section">
      <div className="ln-wrap ln-privacy-grid">
        <div className="reveal">
          <div className="ln-kicker">Privacy</div>
          <h2>It belongs to you. Literally.</h2>
          <p>
            Most AI tools rent you a brain and keep the data. Xacheus is the opposite: a private
            personal and business agent that lives where you put it, remembers what you tell it to,
            and answers to nobody but you.
          </p>
          <div className="ln-privacy-points">
            {points.map((point) => (
              <div className="ln-privacy-point" key={point.title}>
                <span className="ln-privacy-check">✓</span>
                <div>
                  <div className="ln-privacy-title">{point.title}</div>
                  <div className="ln-privacy-sub">{point.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <TerminalCard reveal />
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- quick start */

function QuickStart() {
  return (
    <section id="quickstart" className="ln-section ln-section-alt">
      <div className="ln-wrap ln-quickstart">
        <div className="reveal">
          <div className="ln-kicker">Quick start</div>
          <h2>Five minutes to your agent</h2>
          <p>
            No accounts, no setup calls, no cloud signup. Clone, install, run — and the console is
            on your screen.
          </p>
          <ul className="ln-quicklist">
            <li>
              <span className="ln-quick-num">1</span> Clone the repo and install dependencies
            </li>
            <li>
              <span className="ln-quick-num">2</span> Copy <code>.env.example</code> — every value is optional
            </li>
            <li>
              <span className="ln-quick-num">3</span> Build and start
            </li>
            <li>
              <span className="ln-quick-num">4</span> Open the console at <code>/console</code>
            </li>
          </ul>
          <a className="btn primary" href="/console">
            Open the console
          </a>
        </div>
        <TerminalCard reveal />
      </div>
    </section>
  );
}

/** Shared terminal mock — used by Privacy and Quick start. */
function TerminalCard({ reveal = false }: { reveal?: boolean }) {
  const lines = [
    { prompt: true, text: 'git clone <your-repo> && cd Xacheusai' },
    { prompt: true, text: 'npm install' },
    { prompt: true, text: 'cp .env.example .env   # everything is optional' },
    { prompt: true, text: 'npm run build && npm start' },
    { prompt: false, text: '✓ XACHEUS AI — backend running' },
    { prompt: false, text: '  URL    http://localhost:8787', dim: true },
    { prompt: false, text: '  Auth   passcode   ·   Storage files (durable)', dim: true },
    { prompt: false, text: '  Model  built-in planner (local)', dim: true },
  ];
  return (
    <div className={`ln-term ${reveal ? 'reveal' : ''}`}>
      <div className="ln-term-bar">
        <span className="lm-tl" />
        <span className="lm-tl" />
        <span className="lm-tl" />
        <span className="ln-term-title">zsh — your machine</span>
      </div>
      <div className="ln-term-body">
        {lines.map((line, index) => (
          <div className="ln-term-line" key={index}>
            {line.prompt ? <span className="ln-term-prompt">$</span> : <span className="ln-term-prompt ok">·</span>}
            <span className={line.dim ? 'ln-term-dim' : ''}>{line.text}</span>
          </div>
        ))}
        <div className="ln-term-line">
          <span className="ln-term-prompt">·</span>
          <span className="ln-term-dim">console at /console · api at /api · zero accounts used</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- faq */

function Faq() {
  const faqs = [
    {
      q: 'Do I need an API key to use it?',
      a: 'No. The built-in planner runs with zero credentials, so the whole platform works out of the box. When you want stronger answers, put any model provider’s key in .env — the console shows you exactly which model layer is active.',
    },
    {
      q: 'Where does my data live?',
      a: 'In plain files on the machine that runs the server — readable, back-up-able, deletable. If you want shared or cloud storage, point XACHEUS_STORAGE at Firebase and it switches; the console always tells you which storage is live and whether it is durable.',
    },
    {
      q: 'Can it really control my phone or home?',
      a: 'Yes — through the Android companion app, which connects outbound (it dials the server, so no ports need opening) and exposes wake word, notifications, device actions, and smart-home hand-off. Connectors like mail and home run in a sandbox until you add credentials.',
    },
    {
      q: 'What happens if I expose it on the internet?',
      a: 'You should gate it: set XACHEUS_OWNER_PASSCODE or enable Firebase sign-in. Risky actions still pause for your explicit approval, and every action is written to the audit log. The console warns you when the API is open to anyone.',
    },
    {
      q: 'What does it cost?',
      a: 'The code is yours to clone and run. You pay only for whatever you choose to add: your own hosting, and any model API you opt into. The zero-credential path costs nothing but the machine it runs on.',
    },
  ];
  return (
    <section className="ln-section">
      <div className="ln-wrap ln-faq-wrap">
        <div className="ln-section-head reveal">
          <div className="ln-kicker">FAQ</div>
          <h2>Asked, honestly</h2>
        </div>
        <div className="ln-faq-list reveal">
          {faqs.map((faq) => (
            <details className="ln-faq" key={faq.q}>
              <summary>{faq.q}</summary>
              <p>{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- final CTA */

function FinalCta() {
  return (
    <section className="ln-final">
      <div className="ln-wrap reveal">
        <h2>Start talking to your agent.</h2>
        <p>No account. No cloud. Your machine, your rules.</p>
        <div className="ln-cta-row">
          <a className="btn primary" href="/console">
            Open the console
          </a>
          <a className="btn ghost" href="#quickstart">
            Get it running
          </a>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ footer */

function Footer() {
  return (
    <footer className="ln-footer">
      <div className="ln-wrap ln-footer-grid">
        <div>
          <a className="ln-brand" href="/">
            <span className="ln-brand-mark">🧠</span>
            <span className="ln-brand-name">Xacheus AI</span>
          </a>
          <div className="ln-footer-tag">Private personal + business AI agent.</div>
        </div>
        <div className="ln-footer-links">
          <a href="https://github.com/prayerdome0/Xacheusai" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="/console">Console</a>
          <a href="#product">Product</a>
          <a href="#privacy">Privacy</a>
        </div>
        <div className="ln-footer-copy">© 2026 Xacheus AI · Built to stay private.</div>
      </div>
    </footer>
  );
}
