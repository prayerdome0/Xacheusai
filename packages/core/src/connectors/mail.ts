/**
 * Mail connector — the Xacheus Mail Agent's transport.
 *
 * IMAP/SMTP clients are loaded lazily: Xacheus starts fine without them, and if
 * they are missing it says exactly what to install instead of failing silently.
 * Reading works over IMAP; sending is confirmation-gated (critical risk) because
 * email leaves your organisation and cannot be unsent.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { evaluateStatus, failure, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';

interface MailConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  password: string;
  from: string;
}

function mailConfig(config: ConfigStore): MailConfig {
  return {
    imapHost: config.value('MAIL_IMAP_HOST'),
    imapPort: config.number('MAIL_IMAP_PORT', 993),
    smtpHost: config.value('MAIL_SMTP_HOST'),
    smtpPort: config.number('MAIL_SMTP_PORT', 587),
    user: config.value('MAIL_USER'),
    password: config.value('MAIL_PASSWORD'),
    from: config.value('MAIL_FROM', config.value('MAIL_USER')),
  };
}

function ready(config: ConfigStore): boolean {
  const mail = mailConfig(config);
  return Boolean(mail.imapHost && mail.user && mail.password);
}

async function loadImap(): Promise<any | null> {
  try {
    const module: any = await import('imapflow' as string);
    return module.default ?? module;
  } catch {
    return null;
  }
}

async function loadNodemailer(): Promise<any | null> {
  try {
    const module: any = await import('nodemailer' as string);
    return module.default ?? module;
  } catch {
    return null;
  }
}

async function withImap<T>(config: ConfigStore, fn: (client: any) => Promise<T>): Promise<T> {
  const ImapFlow = await loadImap();
  if (!ImapFlow) {
    throw new Error(
      'The IMAP client is not installed. Run: npm install imapflow nodemailer -w @xacheus/core — then restart the backend.',
    );
  }
  const mail = mailConfig(config);
  const client = new ImapFlow({
    host: mail.imapHost,
    port: mail.imapPort,
    secure: mail.imapPort === 993,
    auth: { user: mail.user, pass: mail.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

const mailOperations: ConnectorOperation[] = [
  {
    id: 'summarize',
    title: 'Summarise recent email',
    description: 'Reads the newest messages in the inbox and returns sender, subject, date and a preview of each.',
    scopes: ['mail:read'],
    risk: 'low',
    parameters: [
      { name: 'limit', type: 'number', description: 'How many messages to read (default 10).', required: false },
      { name: 'unreadOnly', type: 'boolean', description: 'Only unread messages.', required: false },
      { name: 'mailbox', type: 'string', description: 'Mailbox name, default INBOX.', required: false },
    ],
    async run(input, ctx) {
      if (!ready(ctx.config)) {
        return sandbox('Email summary', 'MAIL_IMAP_HOST / MAIL_USER / MAIL_PASSWORD are not configured.');
      }
      const limit = Math.min(Math.max(Number(input.limit ?? 10) || 10, 1), 50);
      try {
        const messages = await withImap(ctx.config, async (client) => {
          const mailbox = String(input.mailbox ?? 'INBOX');
          const lock = await client.getMailboxLock(mailbox);
          try {
            const since = new Date(Date.now() - 14 * 86_400_000);
            const query = input.unreadOnly ? { seen: false, since } : { since };
            const found: any[] = [];
            const uids: number[] = await client.search(query, { uid: true });
            const slice = uids.slice(-limit);
            if (!slice.length) return found;
            for await (const message of client.fetch(slice.join(','), { envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
              const text = await extractPreview(client, message);
              found.push({
                uid: message.uid,
                subject: message.envelope?.subject ?? '(no subject)',
                from: message.envelope?.from?.[0]?.address ?? 'unknown',
                fromName: message.envelope?.from?.[0]?.name ?? '',
                date: message.envelope?.date?.toISOString?.() ?? String(message.envelope?.date ?? ''),
                unread: !(message.flags?.has('\\Seen')),
                preview: text,
              });
            }
            return found.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
          } finally {
            lock.release();
          }
        });

        if (!messages.length) {
          return { ok: true, mode: 'live', summary: 'No messages matched in the last 14 days.', data: { messages: [] } };
        }
        const unread = messages.filter((message: any) => message.unread).length;
        return {
          ok: true,
          mode: 'live',
          summary: `Read ${messages.length} message(s) from the inbox (${unread} unread).`,
          data: { messages },
        };
      } catch (error) {
        return failure('Email summary', error);
      }
    },
  },
  {
    id: 'classify',
    title: 'Classify an email as an inquiry',
    description:
      'Rule-based triage of an email body: inquiry, order, complaint, supplier or internal — the signal the automation engine uses to route follow-ups.',
    scopes: ['mail:read'],
    risk: 'low',
    parameters: [{ name: 'text', type: 'string', description: 'Email body text.', required: true }],
    async run(input) {
      const text = String(input.text ?? '').toLowerCase();
      const rules: { label: string; patterns: RegExp[] }[] = [
        { label: 'complaint', patterns: [/refund/, /complain/, /damaged/, /broken/, /not happy/, /disappointed/, /wrong item/] },
        { label: 'order', patterns: [/order/, /invoice/, /payment/, /receipt/, /purchase/, /checkout/] },
        { label: 'inquiry', patterns: [/price/, /how much/, /available/, /do you (have|sell)/, /quote/, /enquir/, /inquir/, /catalog/, /delivery/] },
        { label: 'supplier', patterns: [/supplier/, /wholesale/, /bulk/, /distributor/, /stock/] },
        { label: 'internal', patterns: [/meeting/, /report/, /team/, /standup/, /schedule/] },
      ];
      for (const rule of rules) {
        const hit = rule.patterns.find((pattern) => pattern.test(text));
        if (hit) {
          return {
            ok: true,
            mode: 'live',
            summary: `Classified as "${rule.label}" (matched ${hit.source}).`,
            data: { label: rule.label, matched: hit.source },
          };
        }
      }
      return { ok: true, mode: 'live', summary: 'No strong signal — treated as general correspondence.', data: { label: 'general' } };
    },
  },
  {
    id: 'send',
    title: 'Send an email',
    description: 'Sends email through SMTP. Always requires your explicit approval before it leaves.',
    scopes: ['mail:send'],
    risk: 'critical',
    requiresConfirmation: true,
    parameters: [
      { name: 'to', type: 'string', description: 'Recipient address.', required: true },
      { name: 'subject', type: 'string', description: 'Subject line.', required: true },
      { name: 'body', type: 'string', description: 'Plain-text body.', required: true },
      { name: 'cc', type: 'string', description: 'Optional CC address.', required: false },
    ],
    async run(input, ctx) {
      const mail = mailConfig(ctx.config);
      const to = String(input.to ?? '').trim();
      const subject = String(input.subject ?? '').trim();
      const body = String(input.body ?? '').trim();
      if (!mail.smtpHost || !mail.user || !mail.password) {
        return sandbox('Email send', 'SMTP is not configured (MAIL_SMTP_HOST / MAIL_USER / MAIL_PASSWORD).', { to, subject, body });
      }
      if (!to || !subject || !body) {
        return { ok: false, mode: 'live', summary: 'An email needs a recipient, subject and body.', error: 'incomplete email' };
      }
      try {
        const nodemailer = await loadNodemailer();
        if (!nodemailer) {
          return failure('Email send', 'nodemailer is not installed. Run: npm install imapflow nodemailer -w @xacheus/core');
        }
        const transport = nodemailer.createTransport({
          host: mail.smtpHost,
          port: mail.smtpPort,
          secure: mail.smtpPort === 465,
          auth: { user: mail.user, pass: mail.password },
        });
        const info = await transport.sendMail({
          from: mail.from || mail.user,
          to,
          cc: input.cc ? String(input.cc) : undefined,
          subject,
          text: body,
        });
        return {
          ok: true,
          mode: 'live',
          summary: `Email sent to ${to} (message id ${info.messageId ?? 'unknown'}).`,
          data: { messageId: info.messageId, accepted: info.accepted },
        };
      } catch (error) {
        return failure('Email send', error);
      }
    },
  },
];

async function extractPreview(client: any, message: any): Promise<string> {
  try {
    const parts = message.bodyStructure?.childNodes ?? [];
    const textPart = parts.find((part: any) => part.type === 'text/plain') ?? parts.find((part: any) => part.type === 'text/html');
    if (!textPart) return '';
    const key = textPart.part ?? textPart.partSpecifier ?? '1';
    const download = await client.download(String(message.uid), key, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
  } catch {
    return '';
  }
}

export const mailConnector: Connector = {
  manifest: {
    id: 'mail',
    name: 'Email (IMAP/SMTP)',
    category: 'mail',
    description:
      'Reads and sends email through your own mailbox. Categories, summaries and drafts are produced locally; sending always needs your approval first.',
    fields: [
      { key: 'MAIL_IMAP_HOST', label: 'IMAP host', secret: false, required: true, hint: 'e.g. imap.gmail.com' },
      { key: 'MAIL_IMAP_PORT', label: 'IMAP port', secret: false, required: false },
      { key: 'MAIL_SMTP_HOST', label: 'SMTP host', secret: false, required: false, hint: 'Needed to send mail' },
      { key: 'MAIL_SMTP_PORT', label: 'SMTP port', secret: false, required: false },
      { key: 'MAIL_USER', label: 'Mailbox username', secret: false, required: true },
      { key: 'MAIL_PASSWORD', label: 'Password / app password', secret: true, required: true },
      { key: 'MAIL_FROM', label: 'From address', secret: false, required: false },
    ],
    scopes: ['mail:read', 'mail:draft', 'mail:send'],
    capabilities: ['Summarise inbox', 'Classify inquiries', 'Draft replies', 'Send with approval'],
  },
  operations: mailOperations,
  status: (config) => evaluateStatus(mailConnector, config),
  async verify(config) {
    if (!ready(config)) return { ok: false, detail: 'IMAP host, username and password are required.' };
    try {
      const ok = await withImap(config, async (client) => Boolean(client.authenticated ?? true));
      return { ok: Boolean(ok), detail: ok ? 'IMAP login succeeded.' : 'IMAP login failed.' };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
};
