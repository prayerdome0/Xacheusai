/**
 * Small hooks: data loading, polling, the live event stream, and browser voice.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectEvents } from './api';

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((problem) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}

/** Poll an endpoint on an interval (paused when the tab is hidden). */
export function usePolling<T>(loader: () => Promise<T>, intervalMs = 15000): {
  data: T | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(() => {
    loaderRef.current().then(setData).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs]);

  return { data, reload: load };
}

export interface LiveEvent {
  id?: string;
  name: string;
  at?: string;
  payload?: any;
}

/** Subscribe to the backend's event bus. */
export interface LiveFeed {
  events: LiveEvent[];
  /** How the feed is actually arriving — so the UI never implies a live stream it lacks. */
  transport: 'websocket' | 'polling' | 'idle';
}

export function useLiveFeed(onEvent?: (event: LiveEvent) => void, enabled = true): LiveFeed {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [transport, setTransport] = useState<'websocket' | 'polling' | 'idle'>('idle');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setTransport('idle');
      return;
    }
    const channel = connectEvents(
      (event) => {
        if (event.name === 'hello') {
          setEvents((Array.isArray(event.payload) ? event.payload : []).slice(0, 30));
          return;
        }
        setEvents((current) => [event, ...current].slice(0, 60));
        handler.current?.(event);
      },
      (next) => setTransport(next),
    );
    return () => channel.close();
  }, [enabled]);

  return { events, transport };
}

/** Backwards-compatible helper for callers that only want the event list. */
export function useLiveEvents(onEvent?: (event: LiveEvent) => void, enabled = true): LiveEvent[] {
  return useLiveFeed(onEvent, enabled).events;
}

/** --------------------------------------------------------------- voice input */

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

export interface VoiceResult {
  supported: boolean;
  listening: boolean;
  transcript: string;
  interim: string;
  error: string | null;
  start: (options?: { continuous?: boolean; wakeWord?: string; onCommand?: (text: string) => void }) => void;
  stop: () => void;
}

/**
 * Browser speech recognition.
 *
 * This is the web half of the voice story. A truly always-on wake word cannot be
 * done from a browser tab (and shouldn't be able to be): that lives in the Android
 * app behind a foreground service the owner enables. Here we support push-to-talk
 * plus an optional continuous mode that only forwards utterances starting with the
 * wake word.
 */
export function useVoice(): VoiceResult {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const optionsRef = useRef<{ wakeWord?: string; onCommand?: (text: string) => void }>({});

  const SpeechRecognition =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
  const supported = Boolean(SpeechRecognition);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback<VoiceResult['start']>(
    (options = {}) => {
      if (!supported) {
        setError('This browser has no speech recognition. Chrome, Edge or the Android app are the supported options.');
        return;
      }
      optionsRef.current = { wakeWord: options.wakeWord ?? 'xacheus', onCommand: options.onCommand };
      const recognition: SpeechRecognitionLike = new SpeechRecognition();
      recognition.continuous = options.continuous ?? false;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';

      recognition.onresult = (event: any) => {
        let finalText = '';
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) finalText += result[0].transcript;
          else interimText += result[0].transcript;
        }
        setInterim(interimText);
        if (!finalText) return;

        const text = finalText.trim();
        setTranscript(text);

        const wake = (optionsRef.current.wakeWord ?? 'xacheus').toLowerCase();
        if (optionsRef.current.onCommand) {
          if (text.toLowerCase().startsWith(wake)) {
            optionsRef.current.onCommand(text.slice(wake.length).replace(/^[,.\s]+/, '').trim());
          } else if (!options.continuous) {
            optionsRef.current.onCommand(text);
          }
          // In continuous mode, ignore speech that did not address Xacheus.
        }
      };
      recognition.onerror = (event: any) => {
        const code = event?.error ?? 'unknown';
        setError(
          code === 'not-allowed'
            ? 'Microphone access was denied. Allow the microphone in your browser settings.'
            : code === 'no-speech'
              ? null
              : `Speech recognition error: ${code}`,
        );
        setListening(false);
      };
      recognition.onend = () => {
        setListening(false);
        if (options.continuous && recognitionRef.current) {
          // Keep the wake-word listener alive across silent periods.
          try {
            recognition.start();
            setListening(true);
          } catch {
            /* ignore restart races */
          }
        }
      };

      recognitionRef.current = recognition;
      setError(null);
      try {
        recognition.start();
        setListening(true);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [SpeechRecognition, supported],
  );

  useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, transcript, interim, error, start, stop };
}

/** Text-to-speech for the assistant's replies. */
export function speak(text: string, enabled: boolean): void {
  if (!enabled || !('speechSynthesis' in window) || !text.trim()) return;
  const clean = text.replace(/[*_`#>]/g, '').slice(0, 1200);
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.02;
  utterance.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((voice) => /Google UK English Male|Daniel|Alex/.test(voice.name)) ?? voices.find((voice) => voice.lang.startsWith('en'));
  if (preferred) utterance.voice = preferred;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}
