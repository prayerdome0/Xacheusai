/**
 * Meta connectors: Facebook Page, Instagram Business, WhatsApp Cloud API.
 *
 * All three talk to the Graph API with tokens the owner creates in the Meta
 * developer console. Xacheus follows Meta's rules exactly — it only ever posts
 * or messages through official, permissioned endpoints, and every publish/send
 * is confirmation-gated by default.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, evaluateStatus, failure, httpJson, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';

function graphBase(config: ConfigStore, path: string): string {
  const version = config.value('META_GRAPH_VERSION', 'v21.0');
  return `https://graph.facebook.com/${version}/${path.replace(/^\//, '')}`;
}

function text(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** ---------------------------------------------------------------- Facebook */

const facebookOperations: ConnectorOperation[] = [
  {
    id: 'createPost',
    title: 'Publish a Facebook Page post',
    description: 'Publishes text and an optional link to the connected Facebook Page.',
    scopes: ['social:publish'],
    risk: 'high',
    requiresConfirmation: true,
    parameters: [
      { name: 'message', type: 'string', description: 'The post body.', required: true },
      { name: 'link', type: 'string', description: 'Optional link to attach.', required: false },
      { name: 'scheduledFor', type: 'string', description: 'Optional ISO time to publish later.', required: false },
    ],
    async run(input, ctx) {
      const pageId = ctx.config.value('FACEBOOK_PAGE_ID');
      const token = ctx.config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
      const message = text(input, 'message');
      const link = text(input, 'link');
      if (!pageId || !token) {
        return sandbox('Facebook post', 'FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN are not configured.', {
          message,
          link,
        });
      }
      if (!message && !link) {
        return { ok: false, mode: 'live', summary: 'Refusing to publish an empty Facebook post.', error: 'empty post' };
      }
      const body = new URLSearchParams({ message, access_token: token });
      if (link) body.set('link', link);
      const scheduledFor = text(input, 'scheduledFor');
      if (scheduledFor) {
        body.set('published', 'false');
        body.set('scheduled_publish_time', String(Math.floor(Date.parse(scheduledFor) / 1000)));
      }
      const result = await httpJson(graphBase(ctx.config, `${pageId}/feed`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!result.ok) return failure('Facebook post', describeHttpError(result));
      return {
        ok: true,
        mode: 'live',
        summary: scheduledFor
          ? `Facebook post scheduled for ${scheduledFor}.`
          : `Published to the Facebook Page (post id ${result.payload?.id ?? 'unknown'}).`,
        data: result.payload,
        ui: result.payload?.id
          ? [{ type: 'open-url', target: `https://facebook.com/${result.payload.id}`, label: 'Open post' }]
          : undefined,
      };
    },
  },
  {
    id: 'pageActivity',
    title: 'Read recent Page activity',
    description: 'Reads recent posts plus their latest comments — the source for inquiry detection.',
    scopes: ['social:read'],
    risk: 'low',
    parameters: [
      { name: 'limit', type: 'number', description: 'How many posts to fetch (max 50).', required: false },
    ],
    async run(input, ctx) {
      const pageId = ctx.config.value('FACEBOOK_PAGE_ID');
      const token = ctx.config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
      if (!pageId || !token) return sandbox('Facebook page activity read');
      const limit = Math.min(Number(input.limit ?? 10) || 10, 50);
      const fields = `id,message,created_time,permalink_url,comments.limit(10){id,from,message,created_time}`;
      const result = await httpJson(
        graphBase(ctx.config, `${pageId}/posts?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${encodeURIComponent(token)}`),
      );
      if (!result.ok) return failure('Facebook page activity', describeHttpError(result));
      const posts = (result.payload?.data ?? []) as any[];
      const comments = posts.flatMap((post) => post.comments?.data ?? []);
      return {
        ok: true,
        mode: 'live',
        summary: `Read ${posts.length} post(s) and ${comments.length} recent comment(s) from the Page.`,
        data: { posts, comments },
      };
    },
  },
  {
    id: 'insights',
    title: 'Read Page insights',
    description: 'Reads a Page insights metric (impressions, engagement, followers…).',
    scopes: ['social:read'],
    risk: 'low',
    parameters: [
      { name: 'metric', type: 'string', description: 'Metric name, e.g. page_impressions.', required: true },
      { name: 'period', type: 'string', description: 'day | week | days_28', required: false },
    ],
    async run(input, ctx) {
      const pageId = ctx.config.value('FACEBOOK_PAGE_ID');
      const token = ctx.config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
      if (!pageId || !token) return sandbox('Facebook insights read');
      const metric = text(input, 'metric', 'page_impressions');
      const period = text(input, 'period', 'day');
      const result = await httpJson(
        graphBase(ctx.config, `${pageId}/insights?metric=${encodeURIComponent(metric)}&period=${period}&access_token=${encodeURIComponent(token)}`),
      );
      if (!result.ok) return failure('Facebook insights', describeHttpError(result));
      return { ok: true, mode: 'live', summary: `Fetched ${metric} from Page insights.`, data: result.payload };
    },
  },
];

export const facebookConnector: Connector = {
  manifest: {
    id: 'facebook',
    name: 'Facebook Page',
    category: 'social',
    description:
      'Publishes to and reads from a Facebook Page via the official Graph API. Pages and tokens are created in the Meta developer console; Xacheus never bypasses Meta permissions.',
    fields: [
      { key: 'FACEBOOK_PAGE_ID', label: 'Page ID', secret: false, required: true, hint: 'Page → About → Page ID' },
      { key: 'FACEBOOK_PAGE_ACCESS_TOKEN', label: 'Page access token', secret: true, required: true, hint: 'Needs pages_manage_posts + pages_read_engagement' },
    ],
    scopes: ['social:read', 'social:publish'],
    capabilities: ['Publish posts', 'Read posts & comments', 'Read Page insights'],
    docsUrl: 'https://developers.facebook.com/docs/pages-api',
  },
  operations: facebookOperations,
  status: (config) => evaluateStatus(facebookConnector, config),
  async verify(config) {
    const pageId = config.value('FACEBOOK_PAGE_ID');
    const token = config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
    if (!pageId || !token) return { ok: false, detail: 'Page ID and access token are required.' };
    const result = await httpJson(graphBase(config, `${pageId}?fields=id,name&access_token=${encodeURIComponent(token)}`));
    if (!result.ok) return { ok: false, detail: describeHttpError(result) };
    return { ok: true, detail: `Connected to Page "${result.payload?.name ?? pageId}".` };
  },
};

/** --------------------------------------------------------------- Instagram */

const instagramOperations: ConnectorOperation[] = [
  {
    id: 'publishPhoto',
    title: 'Publish an Instagram photo',
    description:
      'Creates a media container from a public image URL and publishes it. Instagram requires a publicly reachable image, so uploads are stored in Cloudinary first.',
    scopes: ['social:publish'],
    risk: 'high',
    requiresConfirmation: true,
    parameters: [
      { name: 'imageUrl', type: 'string', description: 'Public HTTPS image URL.', required: true },
      { name: 'caption', type: 'string', description: 'Post caption including hashtags.', required: true },
    ],
    async run(input, ctx) {
      const accountId = ctx.config.value('INSTAGRAM_BUSINESS_ACCOUNT_ID');
      const token = ctx.config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
      const imageUrl = text(input, 'imageUrl');
      const caption = text(input, 'caption');
      if (!accountId || !token) {
        return sandbox('Instagram photo publish', 'INSTAGRAM_BUSINESS_ACCOUNT_ID / page token are not configured.', {
          imageUrl,
          caption,
        });
      }
      const container = await httpJson(graphBase(ctx.config, `${accountId}/media`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token }),
      });
      if (!container.ok) return failure('Instagram media container', describeHttpError(container));
      const creationId = container.payload?.id;
      const published = await httpJson(graphBase(ctx.config, `${accountId}/media_publish`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: String(creationId), access_token: token }),
      });
      if (!published.ok) return failure('Instagram publish', describeHttpError(published));
      return {
        ok: true,
        mode: 'live',
        summary: `Published to Instagram (media id ${published.payload?.id ?? 'unknown'}).`,
        data: published.payload,
      };
    },
  },
  {
    id: 'recentMedia',
    title: 'Read recent Instagram media',
    description: 'Lists recent media with like and comment counts.',
    scopes: ['social:read'],
    risk: 'low',
    parameters: [{ name: 'limit', type: 'number', description: 'How many items (max 50).', required: false }],
    async run(input, ctx) {
      const accountId = ctx.config.value('INSTAGRAM_BUSINESS_ACCOUNT_ID');
      const token = ctx.config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
      if (!accountId || !token) return sandbox('Instagram media read');
      const limit = Math.min(Number(input.limit ?? 10) || 10, 50);
      const fields = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';
      const result = await httpJson(
        graphBase(ctx.config, `${accountId}/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`),
      );
      if (!result.ok) return failure('Instagram media read', describeHttpError(result));
      return {
        ok: true,
        mode: 'live',
        summary: `Read ${(result.payload?.data ?? []).length} recent Instagram item(s).`,
        data: result.payload,
      };
    },
  },
];

export const instagramConnector: Connector = {
  manifest: {
    id: 'instagram',
    name: 'Instagram Business',
    category: 'social',
    description:
      'Publishes and reads an Instagram Business account through the Graph API. Requires an Instagram Business account linked to the Facebook Page.',
    fields: [
      { key: 'INSTAGRAM_BUSINESS_ACCOUNT_ID', label: 'Instagram Business account ID', secret: false, required: true },
    ],
    scopes: ['social:read', 'social:publish'],
    capabilities: ['Publish photos', 'Read media & engagement'],
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
  },
  operations: instagramOperations,
  status: (config) => evaluateStatus(instagramConnector, config),
  async verify(config) {
    const accountId = config.value('INSTAGRAM_BUSINESS_ACCOUNT_ID');
    const token = config.value('FACEBOOK_PAGE_ACCESS_TOKEN');
    if (!accountId || !token) return { ok: false, detail: 'Instagram account id and page token are required.' };
    const result = await httpJson(graphBase(config, `${accountId}?fields=id,username&access_token=${encodeURIComponent(token)}`));
    if (!result.ok) return { ok: false, detail: describeHttpError(result) };
    return { ok: true, detail: `Connected to @${result.payload?.username ?? accountId}.` };
  },
};

/** ---------------------------------------------------------------- WhatsApp */

const whatsappOperations: ConnectorOperation[] = [
  {
    id: 'sendMessage',
    title: 'Send a WhatsApp message',
    description:
      'Sends a text message through the WhatsApp Cloud API. Outside a 24-hour customer service window Meta requires an approved template — pass `template` in that case.',
    scopes: ['messaging:send'],
    risk: 'critical',
    requiresConfirmation: true,
    parameters: [
      { name: 'to', type: 'string', description: 'Recipient in E.164 format, e.g. 15551234567.', required: true },
      { name: 'body', type: 'string', description: 'Message text (free-form replies).', required: false },
      { name: 'template', type: 'string', description: 'Approved template name, if messaging outside the 24h window.', required: false },
      { name: 'language', type: 'string', description: 'Template language code, default en_US.', required: false },
    ],
    async run(input, ctx) {
      const phoneId = ctx.config.value('WHATSAPP_PHONE_NUMBER_ID');
      const token = ctx.config.value('WHATSAPP_ACCESS_TOKEN');
      const to = text(input, 'to');
      const body = text(input, 'body');
      const template = text(input, 'template');
      if (!phoneId || !token) {
        return sandbox('WhatsApp send', 'WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are not configured.', {
          to,
          body,
          template,
        });
      }
      if (!to) return { ok: false, mode: 'live', summary: 'A recipient number is required.', error: 'missing recipient' };
      if (!body && !template) {
        return { ok: false, mode: 'live', summary: 'Provide either a message body or an approved template.', error: 'empty message' };
      }

      const payload = template
        ? {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: { name: template, language: { code: text(input, 'language', 'en_US') } },
          }
        : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body } };

      const result = await httpJson(graphBase(ctx.config, `${phoneId}/messages`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!result.ok) return failure('WhatsApp send', describeHttpError(result));
      return {
        ok: true,
        mode: 'live',
        summary: `WhatsApp message sent to ${to} (id ${result.payload?.messages?.[0]?.id ?? 'unknown'}).`,
        data: result.payload,
      };
    },
  },
  {
    id: 'windowStatus',
    title: 'Explain WhatsApp messaging windows',
    description:
      'Reports whether free-form messaging is possible and what the connector still needs. Useful before drafting replies.',
    scopes: ['messaging:read'],
    risk: 'low',
    parameters: [],
    async run(_input, ctx) {
      const configured = Boolean(ctx.config.value('WHATSAPP_PHONE_NUMBER_ID') && ctx.config.value('WHATSAPP_ACCESS_TOKEN'));
      return {
        ok: true,
        mode: configured ? 'live' : 'sandbox',
        summary: configured
          ? 'WhatsApp Cloud API credentials are present. Inside the 24-hour customer window you can reply freely; outside it, Meta requires an approved template.'
          : 'WhatsApp is not configured, so sends are simulated. Add the phone number id and access token to go live.',
        data: {
          configured,
          verifyTokenSet: Boolean(ctx.config.value('WHATSAPP_VERIFY_TOKEN')),
          inboundWebhooksSecured: Boolean(ctx.config.value('WHATSAPP_APP_SECRET')),
          webhookPath: '/api/webhooks/whatsapp',
        },
      };
    },
  },
];

export const whatsappConnector: Connector = {
  manifest: {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    category: 'messaging',
    description:
      'WhatsApp Cloud API integration: inbound messages arrive on a webhook, Xacheus drafts replies from business + knowledge context, and sends only with your approval.',
    fields: [
      { key: 'WHATSAPP_PHONE_NUMBER_ID', label: 'Phone number ID', secret: false, required: true },
      { key: 'WHATSAPP_ACCESS_TOKEN', label: 'Access token', secret: true, required: true },
      { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token', secret: false, required: false, hint: 'Any string you also paste into Meta\'s webhook config' },
      {
        key: 'WHATSAPP_APP_SECRET',
        label: 'Meta app secret',
        secret: true,
        required: false,
        hint: 'Used to verify the X-Hub-Signature-256 on inbound webhooks. Until it is set, inbound messages are refused (503) rather than trusted.',
      },
    ],
    scopes: ['messaging:read', 'messaging:draft', 'messaging:send'],
    capabilities: ['Receive inquiry webhooks', 'Draft replies', 'Send approved messages', 'Template messages'],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  operations: whatsappOperations,
  status: (config) => evaluateStatus(whatsappConnector, config),
  async verify(config) {
    const phoneId = config.value('WHATSAPP_PHONE_NUMBER_ID');
    const token = config.value('WHATSAPP_ACCESS_TOKEN');
    if (!phoneId || !token) return { ok: false, detail: 'Phone number ID and access token are required.' };
    const result = await httpJson(graphBase(config, `${phoneId}?fields=display_phone_number,verified_name`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!result.ok) return { ok: false, detail: describeHttpError(result) };
    return {
      ok: true,
      detail: `Connected to ${result.payload?.verified_name ?? 'WhatsApp number'} (${result.payload?.display_phone_number ?? phoneId}).`,
    };
  },
};
