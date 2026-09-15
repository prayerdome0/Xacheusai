/**
 * Firebase connector — authentication/Firestore status plus Cloud Messaging.
 *
 * The public web config (apiKey, authDomain, projectId…) is safe to hold in the
 * client; server-side access needs a service account. Xacheus reports exactly
 * which half is present instead of implying a connection it does not have.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, evaluateStatus, failure, httpJson, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';
import { googleAccessToken, parseServiceAccount } from '../storage/driver.js';

function serviceAccount(config: ConfigStore) {
  return parseServiceAccount(config.value('FIREBASE_SERVICE_ACCOUNT_JSON'), config.value('GOOGLE_APPLICATION_CREDENTIALS'));
}

const firebaseOperations: ConnectorOperation[] = [
  {
    id: 'status',
    title: 'Firebase connection status',
    description: 'Reports which Firebase pieces are configured: web config, service account and storage driver.',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [],
    async run(_input, ctx) {
      const webKeys = ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_APP_ID'];
      const web = ctx.config.presence(webKeys);
      const account = serviceAccount(ctx.config);
      const storage = ctx.config.value('XACHEUS_STORAGE', 'json');
      const webReady = webKeys.every((key) => web[key]?.set);
      return {
        ok: true,
        mode: account ? 'live' : 'sandbox',
        summary: account
          ? `Firebase project ${account.project_id} reachable with a service account; storage driver: ${storage}.`
          : webReady
            ? 'Firebase web config is present (sign-in from the browser works) but no service account is set, so the server keeps its data locally.'
            : 'Firebase is not configured. Xacheus is running on local JSON storage and local auth.',
        data: {
          webConfig: web,
          serviceAccount: account ? { projectId: account.project_id, clientEmail: account.client_email } : null,
          storageDriver: storage,
        },
      };
    },
  },
  {
    id: 'sendPush',
    title: 'Send a push notification (FCM)',
    description: 'Sends a push to an Android device token or a topic via Firebase Cloud Messaging HTTP v1.',
    scopes: ['device:control'],
    risk: 'medium',
    parameters: [
      { name: 'token', type: 'string', description: 'Device registration token (or omit and use topic).', required: false },
      { name: 'topic', type: 'string', description: 'FCM topic name.', required: false },
      { name: 'title', type: 'string', description: 'Notification title.', required: true },
      { name: 'body', type: 'string', description: 'Notification body.', required: true },
      { name: 'data', type: 'object', description: 'Optional data payload.', required: false },
    ],
    async run(input, ctx) {
      const account = serviceAccount(ctx.config);
      const token = input.token ? String(input.token) : '';
      const topic = input.topic ? String(input.topic) : '';
      if (!account) {
        return sandbox('FCM push', 'no service account is configured (needed for HTTP v1 sends).', {
          title: input.title,
          body: input.body,
        });
      }
      if (!token && !topic) {
        return { ok: false, mode: 'live', summary: 'Provide a device token or a topic.', error: 'missing target' };
      }
      try {
        const accessToken = await googleAccessToken(account, 'https://www.googleapis.com/auth/firebase.messaging');
        const payload: Record<string, unknown> = {
          message: {
            notification: { title: String(input.title ?? ''), body: String(input.body ?? '') },
            ...(token ? { token } : { topic }),
            ...(input.data ? { data: stringifyData(input.data) } : {}),
          },
        };
        const result = await httpJson(
          `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!result.ok) return failure('FCM push', describeHttpError(result));
        return {
          ok: true,
          mode: 'live',
          summary: `Push notification delivered to ${token ? `device ${token.slice(0, 12)}…` : `topic ${topic}`}.`,
          data: result.payload,
        };
      } catch (error) {
        return failure('FCM push', error);
      }
    },
  },
  {
    id: 'verifyAccount',
    title: 'Verify the Firebase service account',
    description: 'Performs a real OAuth exchange to prove the service account key is valid and usable.',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [],
    async run(_input, ctx) {
      const account = serviceAccount(ctx.config);
      if (!account) return sandbox('Firebase service account check', 'no service account configured.');
      try {
        await googleAccessToken(account, 'https://www.googleapis.com/auth/datastore');
        return {
          ok: true,
          mode: 'live',
          summary: `Service account ${account.client_email} authenticated successfully for project ${account.project_id}.`,
        };
      } catch (error) {
        return failure('Firebase service account check', error);
      }
    },
  },
];

function stringifyData(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return out;
}

export const firebaseConnector: Connector = {
  manifest: {
    id: 'firebase',
    name: 'Firebase',
    category: 'database',
    description:
      'Authentication, Firestore and Cloud Messaging. The web config is public by design; server-side data access additionally needs a service account.',
    fields: [
      { key: 'FIREBASE_PROJECT_ID', label: 'Project ID', secret: false, required: true },
      { key: 'FIREBASE_API_KEY', label: 'Web API key (public)', secret: false, required: true },
      { key: 'FIREBASE_AUTH_DOMAIN', label: 'Auth domain', secret: false, required: true },
      { key: 'FIREBASE_APP_ID', label: 'App ID', secret: false, required: true },
      { key: 'FIREBASE_MESSAGING_SENDER_ID', label: 'Messaging sender ID', secret: false, required: false },
      { key: 'FIREBASE_STORAGE_BUCKET', label: 'Storage bucket', secret: false, required: false },
      { key: 'FIREBASE_SERVICE_ACCOUNT_JSON', label: 'Service account JSON', secret: true, required: false, hint: 'Paste the JSON, or set GOOGLE_APPLICATION_CREDENTIALS to a file path' },
      { key: 'XACHEUS_STORAGE', label: 'Storage driver', secret: false, required: false, hint: 'json | firestore' },
    ],
    scopes: ['admin:control', 'device:control'],
    capabilities: ['Firestore storage driver', 'FCM push', 'Auth status'],
    docsUrl: 'https://firebase.google.com/docs/firestore/security/get-started',
  },
  operations: firebaseOperations,
  status: (config) => evaluateStatus(firebaseConnector, config),
  async verify(config) {
    const account = serviceAccount(config);
    if (!account) {
      return {
        ok: Boolean(config.value('FIREBASE_PROJECT_ID')),
        detail: account
          ? ''
          : 'No service account: Firebase works for browser sign-in only (if the web config is set). Data stays on local storage.',
      };
    }
    try {
      await googleAccessToken(account, 'https://www.googleapis.com/auth/datastore');
      return { ok: true, detail: `Service account valid for project ${account.project_id}.` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
};
