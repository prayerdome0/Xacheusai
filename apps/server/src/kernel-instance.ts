/**
 * Kernel reuse across invocations.
 *
 * On a long-lived process this is trivial: build once, keep it. On a serverless
 * platform it is the difference between "works" and "re-reads every collection on
 * every request" — so the built kernel is cached both in module scope (survives
 * between requests in a warm instance) and on `globalThis` (survives module
 * re-evaluation, which Node does more often than you would expect under load).
 *
 * It is deliberately honest about the consequence: separate warm instances keep
 * separate copies of anything held only in memory. Durable storage answers that;
 * the device bridge cannot, because a socket is by definition tied to one
 * process — which is exactly why phones get an HTTP polling transport too.
 */
import { DEFAULT_OWNER, createKernel, type Kernel } from '@xacheus/core';
import { buildServer, type BuildOptions, type BuiltServer } from './app.js';
import { inspectStorage, isEphemeralRuntime, type StorageVerdict } from './storage-guard.js';
import { describeAuth } from './guard.js';

interface Cached {
  built: BuiltServer;
  verdict: StorageVerdict;
  buildId: number;
}

const globalKey = '__xacheusKernel__';

function cacheOf(): Map<string, Cached> {
  const holder = globalThis as unknown as Record<string, Map<string, Cached> | undefined>;
  holder[globalKey] ??= new Map();
  return holder[globalKey]!;
}

function toleratesEphemeral(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env.XACHEUS_ALLOW_EPHEMERAL_STORAGE ?? '');
}

function cacheKey(options: BuildOptions, verdict: StorageVerdict): string {
  return [
    options.dataDir ?? process.env.XACHEUS_DATA_DIR ?? '.data',
    options.workspaceRoot ?? process.env.XACHEUS_WORKSPACE_ROOT ?? '',
    verdict.storage,
    process.env.XACHEUS_OWNER_PASSCODE ? 'passcode' : 'open',
  ].join('|');
}

export interface ServerHandle {
  built: BuiltServer;
  kernel: Kernel;
  storage: StorageVerdict;
  /** True when the kernel was already warm (a reused instance). */
  reused: boolean;
  /** True when memory-only state (device sockets) is per-instance here. */
  perInstance: boolean;
}

export async function getServer(options: BuildOptions = {}): Promise<ServerHandle> {
  const env = options.env ?? process.env;
  const storageName = (env.XACHEUS_STORAGE ?? 'json').toLowerCase();
  const dataDir = options.dataDir ?? env.XACHEUS_DATA_DIR ?? '.data';

  const verdict = await inspectStorage({ storage: storageName, dataDir, env });

  // Unsafe and not explicitly tolerated: refuse, loudly, before doing anything.
  if (!verdict.durable && verdict.warning && verdict.warning.startsWith('Refusing')) {
    throw new Error(verdict.warning);
  }

  const serverless = isEphemeralRuntime(env);
  const key = cacheKey(options, verdict);
  const cache = cacheOf();

  const existing = cache.get(key);
  if (existing) {
    // Serverless instances are frozen between requests; automations must be
    // driven by a cron instead of a ticker that never fires.
    return { built: existing.built, kernel: existing.built.kernel, storage: existing.verdict, reused: true, perInstance: serverless };
  }

  const built = await buildServer({ ...options, runtime: serverless ? 'serverless' : 'server' });

  /**
   * Verify the storage we asked for is the storage we got.
   *
   * createStorage() falls back to local files (with a note) when Firestore is
   * misconfigured. On a box that is a reasonable convenience; on an ephemeral
   * platform it would mean booting "successfully", claiming durability and
   * quietly losing every write. So we check the *actual* driver and refuse.
   */
  const actual = built.kernel.services.storage.id;
  const notes = built.kernel.services.storageNotes;
  if (actual !== verdict.storage) {
    const detail = notes.length ? notes.join(' ') : `Requested ${verdict.storage}, got ${actual}.`;
    if (serverless && actual === 'json' && !toleratesEphemeral(env)) {
      throw new Error(
        `XACHEUS_STORAGE=${verdict.storage} is not usable here, and this platform's filesystem is temporary. ${detail} ` +
          `Fix the Firestore credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS), or set XACHEUS_ALLOW_EPHEMERAL_STORAGE=true to start anyway and accept that nothing is saved.`,
      );
    }
    // Tolerated: carry the truth forward so the banner and /api/runtime report it.
    verdict.warning ??= detail;
    verdict.durable = actual === 'firestore';
    verdict.detail = `${verdict.detail} ${detail}`;
  }

  cache.set(key, { built, verdict, buildId: Date.now() });

  return { built, kernel: built.kernel, storage: verdict, reused: false, perInstance: serverless };
}

/** Diagnostics the /api/runtime route reports, so the console can be honest. */
export async function runtimeReport(handle: ServerHandle): Promise<Record<string, unknown>> {
  const { services } = handle.kernel;
  const storageHealth = await services.storage.healthy();
  return {
    runtime: handle.perInstance ? 'serverless' : 'server',
    instanceReused: handle.reused,
    storage: {
      driver: services.storage.id,
      durable: handle.storage.durable,
      health: storageHealth,
      note: handle.storage.detail,
      notes: services.storageNotes,
    },
    websockets: {
      supported: !handle.perInstance,
      detail: handle.perInstance
        ? 'This platform terminates WebSockets, so the console uses HTTP polling and the Android app uses its polling transport. Every action still goes through the same permission checks and gets the same audit entry.'
        : 'WebSockets are available: the console streams run progress and phones hold a live bridge socket.',
    },
    automations: {
      scheduledHere: !handle.perInstance,
      detail: handle.perInstance
        ? 'Interval and schedule triggers are not evaluated in a function that sleeps between requests. Point a Vercel Cron at POST /api/tasks/tick (or run the server on a box) to drive them.'
        : 'The scheduler is running in-process and evaluating interval and schedule triggers every minute.',
    },
    deviceModel: {
      connected: services.devices.sessions(),
      note: 'A device socket lives inside one instance. On serverless, pair the phone with a device token and it can collect commands over HTTP instead.',
    },
    auth: describeAuth({
      ownerPasscode: services.config.value('XACHEUS_OWNER_PASSCODE'),
      deviceToken: services.config.value('XACHEUS_DEVICE_BRIDGE_TOKEN'),
      exposed: services.config.value('HOST', '0.0.0.0') !== '127.0.0.1',
      firebaseProjectId: services.config.value('FIREBASE_PROJECT_ID'),
      ownerEmail: services.config.value('XACHEUS_OWNER_EMAIL'),
    }),
    owner: DEFAULT_OWNER.id,
  };
}
