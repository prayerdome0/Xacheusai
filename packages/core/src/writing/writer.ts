/**
 * Content generation.
 *
 * Two engines, one interface:
 *   - the configured language model when there is one
 *   - a deterministic template writer when there isn't
 *
 * The template writer is not a pretend LLM: it assembles real, usable drafts from
 * your product data, brand tone and knowledge-base facts. Anything it produces is
 * labelled `template` in the result, so you always know what wrote what.
 */
import type { BusinessSnapshot } from '../types.js';
import type { ModelRegistry } from '../models/providers.js';
import { completeWithFallback } from '../models/providers.js';

export interface DraftContext {
  tone?: string;
  audience?: string;
  facts?: string[];
  productName?: string;
  price?: number;
  currency?: string;
  businessName?: string;
  callToAction?: string;
}

export interface DraftResult {
  text: string;
  engine: string;
  notes?: string;
}

async function generate(
  models: ModelRegistry,
  system: string,
  prompt: string,
  fallback: () => string,
  purpose: string,
): Promise<DraftResult> {
  if (!models.builtin) {
    const { response, providerId, failures } = await completeWithFallback(models, {
      system,
      prompt,
      temperature: 0.6,
      purpose,
      maxTokens: 900,
    });
    if (response.text.trim() && !response.synthetic) {
      return { text: response.text.trim(), engine: `${providerId}:${response.model}` };
    }
    if (failures.length) {
      return {
        text: fallback(),
        engine: 'xacheus-template-writer',
        notes: `Falling back to the built-in template writer: ${failures.map((failure) => `${failure.provider} (${failure.error})`).join(', ')}`,
      };
    }
  }
  return {
    text: fallback(),
    engine: 'xacheus-template-writer',
    notes: 'Written by the built-in template writer — configure a model (XACHEUS_MODEL) for conversational copy.',
  };
}

/** ------------------------------------------------------------- social posts */

export interface SocialDraftInput {
  platform: 'facebook' | 'instagram' | 'whatsapp' | 'generic';
  topic: string;
  context: DraftContext;
  includeHashtags?: boolean;
}

export async function draftSocialPost(models: ModelRegistry, input: SocialDraftInput): Promise<DraftResult> {
  const { platform, topic, context } = input;
  const tone = context.tone ?? 'friendly and confident';
  const product = context.productName ? `${context.productName}${context.price ? ` at ${context.currency ?? ''} ${context.price}` : ''}` : '';

  const system = [
    'You are the Xacheus Social Agent writing on behalf of a business owner.',
    `Tone: ${tone}.`,
    'Write a ready-to-publish post. No preamble, no explanations, no markdown fences — just the post text.',
    platform === 'instagram' ? 'Keep it under 120 words and end with hashtags.' : 'Keep it under 150 words.',
  ].join(' ');

  const prompt = [
    `Platform: ${platform}.`,
    `Subject: ${topic}.`,
    product ? `Product: ${product}.` : '',
    context.businessName ? `Business: ${context.businessName}.` : '',
    context.audience ? `Audience: ${context.audience}.` : '',
    context.callToAction ? `Call to action: ${context.callToAction}.` : '',
    context.facts?.length ? `Facts you may use (do not invent others): ${context.facts.join(' | ')}` : 'Do not invent facts, prices or claims.',
  ]
    .filter(Boolean)
    .join('\n');

  return generate(models, system, prompt, () => templateSocial(input), 'social-draft');
}

function templateSocial(input: SocialDraftInput): string {
  const { platform, topic, context } = input;
  const productLine = context.productName
    ? `${context.productName}${context.price ? ` — ${context.currency ?? ''} ${context.price}` : ''}`
    : '';

  const hook =
    platform === 'instagram'
      ? `✨ ${topic}`
      : platform === 'whatsapp'
        ? `Hello! ${topic}`
        : topic;

  const lines: string[] = [hook, ''];
  if (productLine) lines.push(productLine);

  if (context.facts?.length) {
    for (const fact of context.facts.slice(0, 3)) lines.push(`• ${fact}`);
  } else {
    lines.push('• Available now');
    lines.push('• Message us for details');
  }

  lines.push('');
  lines.push(context.callToAction ?? 'Message us to order or ask a question — we reply personally.');

  if (platform === 'instagram' && input.includeHashtags !== false) {
    const tags = new Set<string>();
    tags.add('#' + topic.split(/\s+/).filter(Boolean).slice(0, 2).join('').replace(/[^a-zA-Z0-9]/g, ''));
    if (context.productName) tags.add('#' + context.productName.replace(/[^a-zA-Z0-9]/g, ''));
    tags.add('#smallbusiness');
    tags.add('#shoplocal');
    lines.push('', [...tags].filter((tag) => tag.length > 2).join(' '));
  }

  return lines.join('\n').trim();
}

/** --------------------------------------------------------------- replies */

export interface ReplyDraftInput {
  message: string;
  channel: 'whatsapp' | 'facebook' | 'instagram' | 'email' | 'message';
  sender?: string;
  context: DraftContext;
  knowledge?: { title: string; text: string }[];
  business?: BusinessSnapshot;
}

export async function draftReply(models: ModelRegistry, input: ReplyDraftInput): Promise<DraftResult> {
  const system = [
    'You are the Xacheus assistant drafting a reply for a business owner to review.',
    `Tone: ${input.context.tone ?? 'warm, professional, concise'}.`,
    'Use ONLY the supplied facts. If something is unknown, say you will confirm with the team instead of inventing it.',
    'Output just the reply text.',
  ].join(' ');

  const prompt = [
    `Channel: ${input.channel}.`,
    input.sender ? `From: ${input.sender}.` : '',
    `Their message: """${input.message}"""`,
    input.context.businessName ? `Our business: ${input.context.businessName}.` : '',
    input.knowledge?.length
      ? `Relevant knowledge:\n${input.knowledge.map((entry, index) => `[${index + 1}] ${entry.title}: ${entry.text.slice(0, 500)}`).join('\n')}`
      : 'No knowledge base match.',
    input.business?.products?.length
      ? `Products: ${input.business.products.slice(0, 8).map((product) => `${product.name} ${input.business!.company.currency} ${product.price}`).join(', ')}`
      : '',
    'Rules: 1) answer their actual question, 2) one clear next step, 3) no invented prices or promises, 4) under 120 words.',
  ]
    .filter(Boolean)
    .join('\n');

  return generate(models, system, prompt, () => templateReply(input), 'reply-draft');
}

function templateReply(input: ReplyDraftInput): string {
  const currency = input.business?.company.currency ?? '';
  const question = input.message.toLowerCase();
  const product = input.business?.products.find((item) => question.includes(item.name.toLowerCase()));

  const parts: string[] = [];
  parts.push(input.sender ? `Hi ${input.sender.split(/[\s@]/)[0]},` : 'Hi there,');
  parts.push('');

  if (product) {
    parts.push(`Thanks for asking about ${product.name} — it is ${currency} ${product.price}. ${product.blurb}`.trim());
  } else if (/price|cost|how much/.test(question)) {
    const catalogue = input.business?.products.slice(0, 4) ?? [];
    parts.push(
      catalogue.length
        ? `Thanks for reaching out. Here is what we currently offer: ${catalogue.map((item) => `${item.name} (${currency} ${item.price})`).join(', ')}. Tell me which one you need and I will confirm availability.`
        : 'Thanks for reaching out. I will confirm the exact price for you and come straight back.',
    );
  } else if (/deliver|shipping|arrive/.test(question)) {
    parts.push('Thanks for the message — I will confirm delivery timing and cost for your location and get right back to you.');
  } else if (/available|stock|in stock/.test(question)) {
    parts.push('Thanks for checking — let me verify current stock and confirm today.');
  } else {
    const knowledge = input.knowledge?.[0];
    parts.push(
      knowledge
        ? `Thanks for your message. ${knowledge.text.split(/\.\s/)[0]}.`
        : 'Thanks for your message — I have your request and will come back to you shortly with the details.',
    );
  }

  parts.push('');
  parts.push('Let me know if you would like me to reserve one or send an invoice.');

  if (input.knowledge?.length) {
    parts.push('');
    parts.push('(Draft written by the built-in template writer from your knowledge base — review before sending.)');
  }
  return parts.join('\n').trim();
}

/** ----------------------------------------------------------------- email */

export interface EmailDraftInput {
  purpose: string;
  to?: string;
  context: DraftContext;
  facts?: string[];
  tone?: string;
}

export async function draftEmail(
  models: ModelRegistry,
  input: EmailDraftInput,
): Promise<{ subject: string; body: string; engine: string; notes?: string }> {
  const system = [
    'You are the Xacheus Mail Agent drafting an email for a business owner to approve.',
    `Tone: ${input.tone ?? input.context.tone ?? 'clear, polite, professional'}.`,
    'Respond as JSON: {"subject": "...", "body": "..."} with plain-text body, no markdown.',
  ].join(' ');

  const prompt = [
    `Purpose: ${input.purpose}`,
    input.to ? `Recipient: ${input.to}` : '',
    input.facts?.length ? `Facts to use (invent nothing else):\n- ${input.facts.join('\n- ')}` : 'Invent no facts.',
    input.context.businessName ? `Sender business: ${input.context.businessName}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await generate(
    models,
    system,
    prompt,
    () => JSON.stringify(templateEmail(input)),
    'email-draft',
  );

  // The model may legitimately return either JSON or an annotated text body.
  try {
    const parsed = JSON.parse(result.text) as { subject?: string; body?: string };
    if (parsed.subject || parsed.body) {
      return {
        subject: parsed.subject ?? `Re: ${input.purpose}`,
        body: parsed.body ?? result.text,
        engine: result.engine,
        notes: result.notes,
      };
    }
  } catch {
    const match = result.text.match(/subject\s*:\s*(.+)/i);
    return {
      subject: match?.[1]?.trim() ?? `Re: ${input.purpose}`,
      body: result.text,
      engine: result.engine,
      notes: result.notes,
    };
  }
  return { subject: `Re: ${input.purpose}`, body: result.text, engine: result.engine, notes: result.notes };
}

function templateEmail(input: EmailDraftInput): { subject: string; body: string } {
  const name = input.to?.split('@')[0]?.replace(/[._]/g, ' ');
  return {
    subject: input.purpose.replace(/^\w/, (char) => char.toUpperCase()),
    body: [
      name ? `Hi ${name},` : 'Hi,',
      '',
      `I am writing regarding: ${input.purpose}.`,
      '',
      ...(input.facts?.length ? input.facts.map((fact) => `- ${fact}`) : ['- Details to be confirmed']),
      '',
      'Please let me know if you would like anything clarified.',
      '',
      'Best regards,',
      input.context.businessName ?? 'Your Company',
    ].join('\n'),
  };
}
