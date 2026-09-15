/**
 * Chat + voice — the primary interface.
 *
 * Everything the assistant does is visible: the plan, which tool ran, whether it
 * was live or simulated, and — when an action reaches other people — an explicit
 * approve/decline gate before anything happens.
 */
import { useEffect, useRef, useState } from 'react';
import { api, getSessionId, setToken, getToken, type AgentRun, type ChatMessage } from '../api';
import { speak, useVoice } from '../hooks';

const QUICK_PROMPTS = [
  'What do I have today?',
  'Create a Facebook post for this product',
  'Summarise my email',
  'Turn off everything downstairs',
  'Research this company and prepare a prospect report',
  'Remind me tomorrow morning to check the website',
];

export function ChatView({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [wakeMode, setWakeMode] = useState(false);
  const sessionId = getSessionId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const voice = useVoice();

  useEffect(() => {
    api
      .session(sessionId)
      .then((data) => setMessages(data.messages))
      .catch(() => undefined);
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setInput('');

    const optimistic: ChatMessage = {
      id: `local_${Date.now()}`,
      sessionId,
      role: 'owner',
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);

    try {
      const result = await api.chat(trimmed, sessionId);
      setRuns((current) => ({ ...current, [result.run.id]: result.run }));
      setMessages((current) => [...current.filter((message) => message.id !== optimistic.id), ...result.messages]);
      if (speakReplies) speak(result.run.response, true);
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      setError(message);
      if (/unauthor/i.test(message)) setToken('');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (run: AgentRun, stepId: string, approve: boolean) => {
    setBusy(true);
    try {
      const result = await api.confirm(run.id, stepId, approve);
      setRuns((current) => ({ ...current, [result.run.id]: result.run }));
      setMessages((current) => [
        ...current,
        {
          id: `confirm_${Date.now()}`,
          sessionId,
          role: 'xacheus',
          text: result.run.response,
          createdAt: new Date().toISOString(),
          runId: result.run.id,
        },
      ]);
      if (speakReplies) speak(result.run.response, true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const pendingRuns = Object.values(runs).filter((run) => run.status === 'awaiting_confirmation');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Talk to Xacheus</h1>
          <div className="sub">
            Speak or type. Say “Xacheus, …” — every action is shown, and anything that reaches other people waits for your approval.
          </div>
        </div>
        <div className="row">
          <label className="toggle" title="Read replies aloud">
            <input type="checkbox" checked={speakReplies} onChange={(event) => setSpeakReplies(event.target.checked)} />
            Speak replies
          </label>
          <button
            className="small"
            onClick={() => {
              api.clearSession(sessionId).then(() => setMessages([])).catch(() => undefined);
            }}
          >
            Clear thread
          </button>
          {getToken() ? (
            <button
              className="small ghost"
              onClick={() => {
                setToken('');
                location.reload();
              }}
            >
              Lock
            </button>
          ) : null}
        </div>
      </div>

      {!voice.supported ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          This browser has no speech recognition, so voice input is unavailable here. Typing works identically — and the Android app
          provides always-on wake-word listening through a foreground service you control.
        </div>
      ) : null}

      {error ? (
        <div className="banner danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      {pendingRuns.map((run) => {
        const step = run.plan.find((entry) => entry.status === 'awaiting_confirmation');
        if (!step) return null;
        return (
          <div className="approval" key={`${run.id}-${step.id}`} style={{ marginBottom: 12 }}>
            <div className="row between">
              <div>
                <strong>Approval needed</strong>
                <div className="small muted">
                  {step.title} — {step.confirmationReason}
                </div>
                <div className="small muted mono">input: {JSON.stringify(step.input).slice(0, 240)}</div>
              </div>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => decide(run, step.id, true)}>
                  Approve &amp; run
                </button>
                <button className="danger" disabled={busy} onClick={() => decide(run, step.id, false)}>
                  Decline
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <div className="chat">
        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="card">
              <h3>🧠 Xacheus is ready</h3>
              <p>
                No language model is configured, so Xacheus is using its built-in deterministic planner: intent routing, memory,
                knowledge search, business data, connectors and automations all work. Add a local model (Ollama) in Settings for
                conversational phrasing.
              </p>
              <div className="row">
                {QUICK_PROMPTS.map((prompt) => (
                  <button key={prompt} className="small" onClick={() => void send(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message) => {
            if (message.role === 'system') return null;
            const run = message.runId ? runs[message.runId] : undefined;
            return (
              <div key={message.id} className={`bubble ${message.role === 'owner' ? 'owner' : 'xacheus'}`}>
                <div className="who">{message.role === 'owner' ? 'You' : 'Xacheus'}</div>
                <div>{message.text}</div>

                {run && message.role !== 'owner' ? (
                  <>
                    <div className="plan">
                      {run.plan.map((step) => (
                        <div key={step.id} className={`plan-step ${step.status}`}>
                          <span className="dot" />
                          <span className="mono">{step.tool}</span>
                          <span className="muted">
                            {step.status}
                            {step.result ? ` · ${step.result.mode}` : ''}
                            {step.result?.durationMs ? ` · ${step.result.durationMs} ms` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="row small muted" style={{ marginTop: 8 }}>
                      <span className="badge">agent: {run.agent}</span>
                      <span className="badge">{run.model}</span>
                      {run.usedFallbackPlanner ? <span className="badge sandbox">built-in planner</span> : null}
                    </div>
                    {stepSuggestions(run).length ? (
                      <div className="row" style={{ marginTop: 10 }}>
                        {stepSuggestions(run).map((suggestion) => (
                          <button key={suggestion} className="small" onClick={() => void send(suggestion)}>
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {run.plan.some((step) => step.result?.ui?.length) ? (
                      <div className="row" style={{ marginTop: 8 }}>
                        {run.plan.flatMap((step) => step.result?.ui ?? []).map((action, index) =>
                          action.type === 'navigate' ? (
                            <button key={index} className="small" onClick={() => onNavigate(action.target)}>
                              {action.label ?? `Open ${action.target}`}
                            </button>
                          ) : action.type === 'open-url' ? (
                            <a key={index} className="button small" href={action.target} target="_blank" rel="noreferrer">
                              {action.label ?? 'Open link'}
                            </a>
                          ) : null,
                        )}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}

          {busy ? <div className="bubble xacheus muted">Working…</div> : null}
        </div>

        <div>
          <div className="composer">
            <textarea
              value={input}
              placeholder="Ask Xacheus, or press the mic and speak…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
            />
            <button
              className={`mic ${voice.listening ? 'listening' : ''}`}
              title={voice.listening ? 'Listening…' : 'Speak to Xacheus'}
              onClick={() => {
                if (voice.listening) voice.stop();
                else voice.start({ continuous: false, wakeWord: 'xacheus', onCommand: (text) => void send(text) });
              }}
            >
              🎙️
            </button>
            <button className="primary" disabled={busy || !input.trim()} onClick={() => void send(input)}>
              Send
            </button>
          </div>

          <div className="row small muted" style={{ marginTop: 8 }}>
            <label className="toggle" title="Listen continuously and only respond when you say “Xacheus”">
              <input
                type="checkbox"
                checked={wakeMode}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setWakeMode(enabled);
                  if (enabled) voice.start({ continuous: true, wakeWord: 'xacheus', onCommand: (text) => void send(text) });
                  else voice.stop();
                }}
              />
              Wake-word listening (“Xacheus…”)
            </label>
            <span>
              Browser tabs can only listen while this page is open — the Android app runs the always-on wake word as a foreground
              service, with the microphone indicator always visible.
            </span>
          </div>
          {voice.interim ? <div className="small muted">heard: {voice.interim}</div> : null}
        </div>
      </div>
    </div>
  );
}

function stepSuggestions(run: AgentRun): string[] {
  const fromSteps = run.plan.flatMap((step) => step.result?.suggestions ?? []);
  return [...new Set([...(run.suggestions ?? []), ...fromSteps])].slice(0, 4);
}
