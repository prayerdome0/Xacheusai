/**
 * Cloudinary connector — media and document storage for the whole platform.
 *
 * Uploads are signed server-side with the API secret, so the secret never
 * reaches a browser or the Android app. When credentials are absent, Xacheus
 * stores files locally instead and says so, rather than silently dropping them.
 */
import type { Attachment } from '../types.js';
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, evaluateStatus, failure, httpJson, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';
import { sha1, newId, nowIso } from '../util.js';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

export function cloudinaryFrom(config: ConfigStore): CloudinaryConfig {
  return {
    cloudName: config.value('CLOUDINARY_CLOUD_NAME'),
    apiKey: config.value('CLOUDINARY_API_KEY'),
    apiSecret: config.value('CLOUDINARY_API_SECRET'),
    folder: config.value('CLOUDINARY_FOLDER', 'xacheus'),
  };
}

export function isCloudinaryReady(config: ConfigStore): boolean {
  const cloud = cloudinaryFrom(config);
  return Boolean(cloud.cloudName && cloud.apiKey && cloud.apiSecret);
}

/**
 * Upload a buffer/URL to Cloudinary with a signed request.
 * Returns an Attachment (or null when Cloudinary isn't configured).
 */
export async function uploadToCloudinary(
  config: ConfigStore,
  input: { data?: Buffer; sourceUrl?: string; name: string; resourceType?: 'image' | 'video' | 'raw' | 'auto'; publicId?: string },
): Promise<Attachment | null> {
  const cloud = cloudinaryFrom(config);
  if (!cloud.cloudName || !cloud.apiKey || !cloud.apiSecret) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = input.publicId ?? `${cloud.folder}/${slug(input.name)}-${Date.now().toString(36)}`;
  const signatureBase = `public_id=${publicId}&timestamp=${timestamp}${cloud.apiSecret}`;
  const signature = sha1(signatureBase);

  const form = new FormData();
  form.set('api_key', cloud.apiKey);
  form.set('timestamp', String(timestamp));
  form.set('public_id', publicId);
  form.set('signature', signature);
  if (input.data) {
    form.set('file', new Blob([new Uint8Array(input.data)]), input.name);
  } else if (input.sourceUrl) {
    form.set('file', input.sourceUrl);
  } else {
    throw new Error('uploadToCloudinary needs either data or sourceUrl');
  }

  const resourceType = input.resourceType ?? 'auto';
  const result = await httpJson(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
    timeoutMs: 60_000,
  });
  if (!result.ok) throw new Error(describeHttpError(result));

  return {
    id: newId('ast'),
    name: input.name,
    mimeType: result.payload?.resource_type === 'raw' ? 'application/octet-stream' : `${result.payload?.resource_type ?? 'application'}/${result.payload?.format ?? 'bin'}`,
    bytes: Number(result.payload?.bytes ?? input.data?.length ?? 0),
    url: String(result.payload?.secure_url ?? result.payload?.url ?? ''),
    provider: 'cloudinary',
    createdAt: nowIso(),
  };
}

/** Admin API listing (needs the same key/secret). */
async function adminList(config: ConfigStore, prefix: string, limit: number): Promise<any[]> {
  const cloud = cloudinaryFrom(config);
  const auth = Buffer.from(`${cloud.apiKey}:${cloud.apiSecret}`).toString('base64');
  const result = await httpJson(
    `https://api.cloudinary.com/v1_1/${cloud.cloudName}/resources/image?prefix=${encodeURIComponent(prefix)}&max_results=${limit}`,
    { headers: { authorization: `Basic ${auth}` } },
  );
  if (!result.ok) throw new Error(describeHttpError(result));
  return (result.payload?.resources ?? []) as any[];
}

const cloudinaryOperations: ConnectorOperation[] = [
  {
    id: 'upload',
    title: 'Upload a file to Cloudinary',
    description: 'Uploads a URL or base64 payload and returns a permanent, CDN-backed URL usable by social connectors.',
    scopes: ['knowledge:write'],
    risk: 'low',
    parameters: [
      { name: 'sourceUrl', type: 'string', description: 'Public URL of the file to import.', required: false },
      { name: 'base64', type: 'string', description: 'Base64 file content (alternative to sourceUrl).', required: false },
      { name: 'name', type: 'string', description: 'Filename to store under.', required: true },
      { name: 'resourceType', type: 'string', description: 'image | video | raw | auto', required: false, enum: ['image', 'video', 'raw', 'auto'] },
    ],
    async run(input, ctx) {
      const name = String(input.name ?? `upload-${Date.now()}`);
      const sourceUrl = input.sourceUrl ? String(input.sourceUrl) : undefined;
      const base64 = input.base64 ? String(input.base64) : undefined;
      if (!isCloudinaryReady(ctx.config)) {
        return sandbox('Cloudinary upload', 'credentials are not configured; files are stored locally instead.', { name, sourceUrl });
      }
      try {
        const attachment = await uploadToCloudinary(ctx.config, {
          name,
          sourceUrl,
          data: base64 ? Buffer.from(base64, 'base64') : undefined,
          resourceType: (input.resourceType as 'image' | 'video' | 'raw' | 'auto') ?? 'auto',
        });
        if (!attachment) return sandbox('Cloudinary upload', 'credentials incomplete', { name });
        return {
          ok: true,
          mode: 'live',
          summary: `Uploaded ${name} to Cloudinary.`,
          data: { attachment },
          ui: [{ type: 'open-url', target: attachment.url, label: 'Open file' }],
        };
      } catch (error) {
        return failure('Cloudinary upload', error);
      }
    },
  },
  {
    id: 'listAssets',
    title: 'List Cloudinary assets',
    description: 'Lists stored images under a prefix so Xacheus can reference your existing library.',
    scopes: ['knowledge:read'],
    risk: 'low',
    parameters: [
      { name: 'prefix', type: 'string', description: 'Folder/prefix to list.', required: false },
      { name: 'limit', type: 'number', description: 'Max results (default 30).', required: false },
    ],
    async run(input, ctx) {
      if (!isCloudinaryReady(ctx.config)) return sandbox('Cloudinary listing', 'credentials are not configured.');
      try {
        const assets = await adminList(ctx.config, String(input.prefix ?? cloudinaryFrom(ctx.config).folder), Number(input.limit ?? 30));
        return {
          ok: true,
          mode: 'live',
          summary: `Found ${assets.length} asset(s) in Cloudinary.`,
          data: {
            assets: assets.map((asset) => ({ publicId: asset.public_id, url: asset.secure_url, bytes: asset.bytes, format: asset.format })),
          },
        };
      } catch (error) {
        return failure('Cloudinary listing', error);
      }
    },
  },
];

export const cloudinaryConnector: Connector = {
  manifest: {
    id: 'cloudinary',
    name: 'Cloudinary',
    category: 'storage',
    description:
      'Media and document store for uploads, generated assets, product images and company files. Used by the knowledge pipeline and social connectors.',
    fields: [
      { key: 'CLOUDINARY_CLOUD_NAME', label: 'Cloud name', secret: false, required: true },
      { key: 'CLOUDINARY_API_KEY', label: 'API key', secret: true, required: true },
      { key: 'CLOUDINARY_API_SECRET', label: 'API secret', secret: true, required: true },
      { key: 'CLOUDINARY_FOLDER', label: 'Root folder', secret: false, required: false },
    ],
    scopes: ['knowledge:read', 'knowledge:write'],
    capabilities: ['Signed uploads', 'Asset listing', 'CDN URLs for social posts'],
    docsUrl: 'https://cloudinary.com/documentation/upload_images',
  },
  operations: cloudinaryOperations,
  status: (config) => evaluateStatus(cloudinaryConnector, config),
  async verify(config) {
    if (!isCloudinaryReady(config)) return { ok: false, detail: 'Cloud name, API key and API secret are all required.' };
    const cloud = cloudinaryFrom(config);
    const auth = Buffer.from(`${cloud.apiKey}:${cloud.apiSecret}`).toString('base64');
    const result = await httpJson(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/resources/image?max_results=1`, {
      headers: { authorization: `Basic ${auth}` },
    });
    if (!result.ok) return { ok: false, detail: describeHttpError(result) };
    return { ok: true, detail: `Cloudinary account "${cloud.cloudName}" reachable.` };
  },
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'file';
}
