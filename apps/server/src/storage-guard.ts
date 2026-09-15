/**
 * Storage safety on ephemeral filesystems.
 *
 * On a serverless platform the process filesystem is writable but *not*
 * persistent — and worse, each concurrent instance gets its own copy, so two
 * requests can silently disagree about your data. That is a footgun, not a
 * feature, so we refuse to boot in that configuration unless the owner has
 * explicitly opted in (the useful case being "I am only looking at the console").
 *
 * The check is honest about what it detects: it probes for a real write and then
 * reports which backend is in use, so the startup banner can tell the truth.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface StorageVerdict {
  storage: string;
  /** True when data will actually survive a restart. */
  durable: boolean;
  detail: string;
  /** Set when the configuration is unsafe but tolerated. */
  warning?: string;
}

const EPHEMERAL = /^(1|true|yes|on)$/i;

/** Is this process running on a platform that gives us a throwaway disk? */
export function isEphemeralRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY || env.FUNCTIONS_WORKER_RUNTIME);
}

/**
 * Decide whether the storage configuration is safe, and say so plainly.
 * Never throws: the caller decides whether to refuse or warn.
 */
export async function inspectStorage(options: { storage: string; dataDir: string; env?: NodeJS.ProcessEnv }): Promise<StorageVerdict> {
  const env = options.env ?? process.env;
  const ephemeral = isEphemeralRuntime(env);
  const tolerated = EPHEMERAL.test(env.XACHEUS_ALLOW_EPHEMERAL_STORAGE ?? '');

  if (options.storage === 'firestore') {
    return {
      storage: 'firestore',
      durable: true,
      detail: 'Firestore is durable and shared across instances — the right choice on serverless hosting.',
    };
  }

  const writable = await canWrite(options.dataDir);

  if (options.storage === 'memory') {
    return {
      storage: 'memory',
      durable: false,
      detail: 'In-memory storage: nothing is persisted, by explicit configuration.',
    };
  }

  if (ephemeral) {
    return {
      storage: 'json',
      durable: false,
      detail: `Local JSON files in ${resolve(options.dataDir)} — writable here, but this platform wipes the filesystem and runs several instances, so data written by one request will not reliably be visible to the next.`,
      warning: tolerated
        ? `XACHEUS_ALLOW_EPHEMERAL_STORAGE is set, so Xacheus is starting anyway. Treat your memory, business records and audit log as temporary: set XACHEUS_STORAGE=firestore (with a service account) for real persistence.`
        : `Refusing to start with local file storage on an ephemeral platform. Set XACHEUS_STORAGE=firestore plus a Firebase service account (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) — or set XACHEUS_ALLOW_EPHEMERAL_STORAGE=true if you only want to look around and accept that nothing is saved.`,
    };
  }

  return {
    storage: 'json',
    durable: writable.ok,
    detail: writable.ok
      ? `Local JSON files in ${resolve(options.dataDir)} — durable on a machine you control.`
      : `Local JSON files in ${resolve(options.dataDir)}, but the directory is not writable (${writable.detail}).`,
    warning: writable.ok ? undefined : 'Data will not persist and uploads will fail: fix XACHEUS_DATA_DIR permissions or use Firestore.',
  };
}

async function canWrite(dir: string): Promise<{ ok: boolean; detail: string }> {
  const target = resolve(dir);
  const probe = join(target, `.xacheus-probe-${process.pid}`);
  try {
    await mkdir(target, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    await readFile(probe, 'utf8');
    await rm(probe, { force: true });
    return { ok: true, detail: 'writable' };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
