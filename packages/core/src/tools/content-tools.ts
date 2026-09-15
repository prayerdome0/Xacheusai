/**
 * Content tools — drafting for social, messaging and email.
 *
 * Drafting is always safe (it touches nothing outside your machine), which is why
 * the Social/Messaging/Mail agents can prepare everything and only the final
 * publish/send is confirmation-gated.
 */
import type { Tool } from './types.js';
import { draftEmail, draftReply, draftSocialPost } from '../writing/writer.js';

export const contentTools: Tool[] = [
  {
    id: 'content.draftSocial',
    name: 'Draft a social post',
    description:
      'Writes a ready-to-review post for Facebook, Instagram or WhatsApp using your product data, brand tone and knowledge base. Nothing is published by this step.',
    category: 'content',
    scopes: ['social:draft'],
    risk: 'low',
    parameters: [
      { name: 'topic', type: 'string', description: 'What the post is about.', required: true, example: 'New arrivals for the weekend' },
      { name: 'platform', type: 'string', description: 'facebook | instagram | whatsapp | generic', required: false, enum: ['facebook', 'instagram', 'whatsapp', 'generic'] },
      { name: 'productName', type: 'string', description: 'Featured product.', required: false },
      { name: 'tone', type: 'string', description: 'Desired tone.', required: false },
      { name: 'includeHashtags', type: 'boolean', description: 'Add hashtags (Instagram).', required: false },
    ],
    owners: ['social', 'master', 'automation'],
    async run(input, ctx) {
      const topic = String(input.topic ?? '').trim();
      if (!topic) return { ok: false, mode: 'live', summary: 'What should the post be about?', error: 'missing topic' };

      const [snapshot, toneMemory] = await Promise.all([
        ctx.services.business.get(),
        ctx.services.memory.recall('brand tone voice style'),
      ]);
      const knowledge = await ctx.services.knowledge.search(topic, { limit: 3 });
      const product = input.productName
        ? snapshot.products.find((item) => item.name.toLowerCase().includes(String(input.productName).toLowerCase()))
        : snapshot.products[0];

      const result = await draftSocialPost(ctx.services.models, {
        platform: (String(input.platform ?? 'facebook') as any) || 'facebook',
        topic,
        includeHashtags: input.includeHashtags !== false,
        context: {
          tone: input.tone ? String(input.tone) : toneMemory[0]?.value ?? undefined,
          businessName: snapshot.company.name,
          currency: snapshot.company.currency,
          productName: product?.name,
          price: product?.price,
          facts: [
            ...(product?.blurb ? [product.blurb] : []),
            ...knowledge.slice(0, 2).map((hit) => hit.text.split(/\.\s/)[0] ?? ''),
          ].filter(Boolean),
        },
      });

      return {
        ok: true,
        mode: 'live',
        summary: result.text,
        data: { draft: result.text, engine: result.engine, platform: input.platform ?? 'facebook', notes: result.notes },
        suggestions: [
          'Publish this to my Facebook Page',
          'Make it shorter and more urgent',
          'Pair it with a product photo from Cloudinary',
        ],
      };
    },
  },
  {
    id: 'content.draftReply',
    name: 'Draft a reply to a customer',
    description:
      'Writes a reply to an inbound message using your knowledge base and product data, so nothing is invented. Sending stays a separate, approved step.',
    category: 'content',
    scopes: ['messaging:draft'],
    risk: 'low',
    parameters: [
      { name: 'message', type: 'string', description: 'The customer message.', required: true },
      { name: 'channel', type: 'string', description: 'whatsapp | facebook | instagram | email | message', required: false, enum: ['whatsapp', 'facebook', 'instagram', 'email', 'message'] },
      { name: 'sender', type: 'string', description: 'Customer name or number.', required: false },
    ],
    owners: ['messaging', 'social', 'mail', 'master', 'automation', 'business'],
    async run(input, ctx) {
      const message = String(input.message ?? input.text ?? '').trim();
      if (!message) return { ok: false, mode: 'live', summary: 'Which message should I reply to?', error: 'missing message' };

      const [snapshot, knowledge, toneMemory] = await Promise.all([
        ctx.services.business.get(),
        ctx.services.knowledge.search(message, { limit: 4 }),
        ctx.services.memory.recall('tone voice reply style'),
      ]);

      const result = await draftReply(ctx.services.models, {
        message,
        channel: (String(input.channel ?? 'message') as any) || 'message',
        sender: input.sender ? String(input.sender) : undefined,
        context: {
          tone: toneMemory[0]?.value ?? undefined,
          businessName: snapshot.company.name,
          currency: snapshot.company.currency,
        },
        knowledge: knowledge.map((hit) => ({ title: hit.documentTitle, text: hit.text })),
        business: snapshot,
      });

      return {
        ok: true,
        mode: 'live',
        summary: result.text,
        data: {
          draft: result.text,
          engine: result.engine,
          sources: knowledge.map((hit) => ({ document: hit.documentTitle, score: Number(hit.score.toFixed(3)) })),
          notes: result.notes,
        },
        suggestions: ['Send this reply after I approve it', 'Record them as a lead', 'Make it warmer'],
      };
    },
  },
  {
    id: 'content.draftEmail',
    name: 'Draft an email',
    description: 'Writes a subject and body for an email, ready for your approval before anything is sent.',
    category: 'content',
    scopes: ['mail:draft'],
    risk: 'low',
    parameters: [
      { name: 'purpose', type: 'string', description: 'What the email must achieve.', required: true },
      { name: 'to', type: 'string', description: 'Recipient address.', required: false },
      { name: 'tone', type: 'string', description: 'Desired tone.', required: false },
      { name: 'facts', type: 'array', description: 'Facts the email may use.', required: false },
    ],
    owners: ['mail', 'business', 'master', 'automation'],
    async run(input, ctx) {
      const purpose = String(input.purpose ?? '').trim();
      if (!purpose) return { ok: false, mode: 'live', summary: 'What should the email accomplish?', error: 'missing purpose' };
      const [snapshot, knowledge] = await Promise.all([
        ctx.services.business.get(),
        ctx.services.knowledge.search(purpose, { limit: 3 }),
      ]);
      const result = await draftEmail(ctx.services.models, {
        purpose,
        to: input.to ? String(input.to) : undefined,
        tone: input.tone ? String(input.tone) : undefined,
        context: { businessName: snapshot.company.name, currency: snapshot.company.currency },
        facts: [
          ...(Array.isArray(input.facts) ? (input.facts as string[]) : []),
          ...knowledge.map((hit) => `${hit.documentTitle}: ${hit.text.split(/\.\s/)[0] ?? ''}`),
        ],
      });
      return {
        ok: true,
        mode: 'live',
        summary: `Subject: ${result.subject}\n\n${result.body}`,
        data: result,
        suggestions: ['Send it after I approve', 'Attach the latest catalogue PDF'],
      };
    },
  },
  {
    id: 'content.campaignPlan',
    name: 'Plan a content campaign',
    description:
      'Builds a multi-day content plan for a product or promotion: themes, platforms, and the draft copy for each slot.',
    category: 'content',
    scopes: ['social:draft'],
    risk: 'low',
    parameters: [
      { name: 'goal', type: 'string', description: 'Campaign goal, e.g. "clear weekend stock".', required: true },
      { name: 'days', type: 'number', description: 'How many days to plan (default 3).', required: false },
      { name: 'platforms', type: 'array', description: 'Platforms to cover.', required: false },
    ],
    owners: ['social', 'business', 'master'],
    async run(input, ctx) {
      const goal = String(input.goal ?? '').trim();
      if (!goal) return { ok: false, mode: 'live', summary: 'What is the campaign goal?', error: 'missing goal' };
      const days = Math.min(Math.max(Number(input.days ?? 3) || 3, 1), 14);
      const platforms = Array.isArray(input.platforms) && input.platforms.length ? (input.platforms as string[]) : ['facebook', 'instagram'];
      const snapshot = await ctx.services.business.get();

      const angles = [
        'Announcement — what is new and why it matters',
        'Proof — a result, review or customer story',
        'Objection handling — answer the most common question',
        'Urgency — why act now',
        'Behind the scenes — how it is made or supported',
        'Education — a tip that shows expertise',
        'Offer — the clear call to action',
      ];

      const plan: { day: number; date: string; platform: string; angle: string; draft: string }[] = [];
      for (let day = 0; day < days; day += 1) {
        const date = new Date(Date.now() + day * 86_400_000);
        for (const platform of platforms) {
          const angle = angles[(day + platforms.indexOf(platform)) % angles.length]!;
          const draft = await draftSocialPost(ctx.services.models, {
            platform: platform as any,
            topic: `${goal} — ${angle.split('—')[0]!.trim()}`,
            context: {
              businessName: snapshot.company.name,
              currency: snapshot.company.currency,
              facts: [goal],
              callToAction: 'Message us today.',
            },
          });
          plan.push({ day: day + 1, date: date.toDateString(), platform, angle, draft: draft.text });
        }
      }

      return {
        ok: true,
        mode: 'live',
        summary: `Planned ${plan.length} post(s) over ${days} day(s) for ${platforms.join(' and ')}. Nothing is scheduled yet — review, then approve the ones you want published.`,
        data: { plan },
        suggestions: ['Publish day 1 on Facebook', 'Save this plan as a note', 'Change the tone to more urgent'],
      };
    },
  },
  {
    id: 'content.toneGuide',
    name: 'Define your brand tone',
    description: 'Stores your brand voice in memory so every future draft matches it.',
    category: 'content',
    scopes: ['memory:write'],
    risk: 'low',
    parameters: [{ name: 'tone', type: 'string', description: 'The tone, e.g. "warm, direct, no jargon, Nigerian English".', required: true }],
    owners: ['social', 'business', 'master'],
    async run(input, ctx) {
      const tone = String(input.tone ?? '').trim();
      if (!tone) return { ok: false, mode: 'live', summary: 'Describe the tone you want.', error: 'missing tone' };
      await ctx.services.memory.remember({
        kind: 'company',
        key: 'brand_tone',
        value: tone,
        tags: ['brand', 'tone', 'content'],
        pinned: true,
        source: 'owner',
        confidence: 1,
      });
      return { ok: true, mode: 'live', summary: `Brand tone saved: ${tone}. Every future draft will follow it.` };
    },
  },
];
