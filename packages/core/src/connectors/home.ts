/**
 * Smart-home connector.
 *
 * Home Assistant is the default bridge because it already speaks to thousands of
 * devices (lights, switches, plugs, fans, thermostats, cameras, sensors, TVs,
 * speakers, locks). Xacheus therefore never needs per-vendor integrations — it
 * needs one authorized local API. Anything without such an interface simply
 * can't be controlled, and Xacheus says so instead of pretending.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, evaluateStatus, failure, httpJson, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';

interface HaEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

const CONTROLLABLE_DOMAINS = ['light', 'switch', 'fan', 'media_player', 'climate', 'cover', 'lock', 'scene', 'script', 'input_boolean'];

function haBase(config: ConfigStore, path: string): string {
  const base = config.value('HOME_ASSISTANT_URL').replace(/\/$/, '');
  return `${base}/api/${path.replace(/^\//, '')}`;
}

function authHeaders(config: ConfigStore): Record<string, string> {
  return { authorization: `Bearer ${config.value('HOME_ASSISTANT_TOKEN')}`, 'content-type': 'application/json' };
}

async function fetchStates(config: ConfigStore): Promise<HaEntity[]> {
  const result = await httpJson(haBase(config, 'states'), { headers: authHeaders(config) });
  if (!result.ok) throw new Error(describeHttpError(result));
  return (result.payload ?? []) as HaEntity[];
}

/** Resolve an area name ("downstairs") to entities, using HOME_AREAS and names. */
function entitiesInArea(entities: HaEntity[], area: string, config: ConfigStore): HaEntity[] {
  const areaMap = config.json<Record<string, string[]>>('HOME_AREAS', {});
  const needles = (areaMap[area.toLowerCase()] ?? [area])
    .map((entry) => entry.toLowerCase().replace(/[\s_-]+/g, ''))
    .filter(Boolean);

  return entities.filter((entity) => {
    if (!CONTROLLABLE_DOMAINS.includes(entity.entity_id.split('.')[0] ?? '')) return false;
    const friendly = String(entity.attributes?.friendly_name ?? '').toLowerCase().replace(/[\s_-]+/g, '');
    const id = entity.entity_id.toLowerCase().replace(/[\s_-]+/g, '');
    return needles.some((needle) => id.includes(needle) || friendly.includes(needle));
  });
}

function summariseEntity(entity: HaEntity): { id: string; name: string; state: string; domain: string } {
  return {
    id: entity.entity_id,
    name: String(entity.attributes?.friendly_name ?? entity.entity_id),
    state: entity.state,
    domain: entity.entity_id.split('.')[0] ?? 'unknown',
  };
}

const homeOperations: ConnectorOperation[] = [
  {
    id: 'listEntities',
    title: 'List smart-home devices',
    description: 'Lists controllable devices and their current state, optionally filtered by area or domain.',
    scopes: ['home:read'],
    risk: 'low',
    parameters: [
      { name: 'area', type: 'string', description: 'Filter by area/room, e.g. "downstairs".', required: false },
      { name: 'domain', type: 'string', description: 'Filter by domain, e.g. light.', required: false },
    ],
    async run(input, ctx) {
      if (!ctx.config.value('HOME_ASSISTANT_URL') || !ctx.config.value('HOME_ASSISTANT_TOKEN')) {
        return sandbox('Smart-home listing', 'HOME_ASSISTANT_URL / HOME_ASSISTANT_TOKEN are not configured.', {
          hint: 'Point Xacheus at your Home Assistant instance to control real devices.',
        });
      }
      try {
        const states = await fetchStates(ctx.config);
        let entities = states.filter((entity) => CONTROLLABLE_DOMAINS.includes(entity.entity_id.split('.')[0] ?? ''));
        const area = String(input.area ?? '').trim();
        if (area) entities = entitiesInArea(entities, area, ctx.config);
        const domain = String(input.domain ?? '').trim();
        if (domain) entities = entities.filter((entity) => entity.entity_id.startsWith(`${domain}.`));
        const summary = entities.map(summariseEntity);
        const on = summary.filter((entity) => entity.state === 'on').length;
        return {
          ok: true,
          mode: 'live',
          summary: `Found ${summary.length} controllable device(s)${area ? ` in ${area}` : ''}; ${on} currently on.`,
          data: { entities: summary },
        };
      } catch (error) {
        return failure('Smart-home listing', error);
      }
    },
  },
  {
    id: 'setState',
    title: 'Control a smart-home device',
    description: 'Turns a device on/off, toggles it, or opens/closes covers and locks via Home Assistant services.',
    scopes: ['home:control'],
    risk: 'medium',
    parameters: [
      { name: 'entityId', type: 'string', description: 'Entity id, e.g. light.living_room.', required: true },
      { name: 'action', type: 'string', description: 'on | off | toggle | open | close | lock | unlock', required: true, enum: ['on', 'off', 'toggle', 'open', 'close', 'lock', 'unlock'] },
      { name: 'brightness', type: 'number', description: 'Brightness 0-255 for lights.', required: false },
      { name: 'temperature', type: 'number', description: 'Target temperature for climate devices.', required: false },
    ],
    async run(input, ctx) {
      const entityId = String(input.entityId ?? '').trim();
      const action = String(input.action ?? 'toggle').trim().toLowerCase();
      if (!entityId) return { ok: false, mode: 'live', summary: 'An entity id is required.', error: 'missing entityId' };
      if (!ctx.config.value('HOME_ASSISTANT_URL') || !ctx.config.value('HOME_ASSISTANT_TOKEN')) {
        return sandbox('Smart-home control', 'Home Assistant is not configured.', { entityId, action });
      }
      const domain = entityId.split('.')[0] ?? '';
      const serviceMap: Record<string, string> = {
        on: 'turn_on',
        off: 'turn_off',
        toggle: 'toggle',
        open: 'open_cover',
        close: 'close_cover',
        lock: 'lock',
        unlock: 'unlock',
      };
      const service = serviceMap[action];
      if (!service) {
        return { ok: false, mode: 'live', summary: `Action "${action}" is not supported.`, error: 'unsupported action' };
      }
      const body: Record<string, unknown> = { entity_id: entityId };
      if (input.brightness !== undefined) body.brightness_pct = Math.round((Number(input.brightness) / 255) * 100);
      if (input.temperature !== undefined) body.temperature = Number(input.temperature);
      try {
        const result = await httpJson(haBase(ctx.config, `services/${domain}/${service}`), {
          method: 'POST',
          headers: authHeaders(ctx.config),
          body: JSON.stringify(body),
        });
        if (!result.ok) return failure('Smart-home control', describeHttpError(result));
        return {
          ok: true,
          mode: 'live',
          summary: `Set ${entityId} → ${action}${input.brightness !== undefined ? ` (brightness ${input.brightness})` : ''}.`,
          data: { entityId, action, response: result.payload },
        };
      } catch (error) {
        return failure('Smart-home control', error);
      }
    },
  },
  {
    id: 'setByDescription',
    title: 'Control a device described in words',
    description:
      'Resolves a plain-English target ("the living-room light", "downstairs", "the fan in the office") to real devices and switches them. This is what voice commands use. If nothing or too much matches, it says so instead of guessing.',
    scopes: ['home:control'],
    risk: 'medium',
    parameters: [
      { name: 'target', type: 'string', description: 'What to control, in your own words.', required: true, example: 'the living-room light' },
      { name: 'action', type: 'string', description: 'on | off | toggle', required: true, enum: ['on', 'off', 'toggle'] },
      { name: 'brightnessPct', type: 'number', description: 'Optional brightness 0-100.', required: false },
    ],
    async run(input, ctx) {
      const target = String(input.target ?? '').trim();
      const action = String(input.action ?? 'toggle').toLowerCase();
      if (!target) return { ok: false, mode: 'live', summary: 'Which device should I control?', error: 'missing target' };
      if (!ctx.config.value('HOME_ASSISTANT_URL') || !ctx.config.value('HOME_ASSISTANT_TOKEN')) {
        return sandbox(`Turn ${action} ${target}`, 'Home Assistant is not configured, so no device was touched.', { target, action });
      }

      try {
        const states = await fetchStates(ctx.config);
        const controllable = states.filter((entity) => CONTROLLABLE_DOMAINS.includes(entity.entity_id.split('.')[0] ?? ''));
        const words = target
          .toLowerCase()
          .replace(/\b(the|a|an|my|in|of|turn|switch|everything|all|devices?|lights?)\b/g, ' ')
          .split(/\s+/)
          .map((word) => word.replace(/[^a-z0-9]/g, ''))
          .filter((word) => word.length > 2);

        const scored = controllable
          .map((entity) => {
            const friendly = String(entity.attributes?.friendly_name ?? '').toLowerCase();
            const id = entity.entity_id.toLowerCase();
            const haystack = `${friendly} ${id}`.replace(/[\s_.-]+/g, '');
            let score = 0;
            for (const word of words) {
              if (haystack.includes(word)) score += 1;
              if (friendly.split(/\s+/).includes(word)) score += 0.5;
            }
            // A domain word in the request ("light", "fan") is a strong signal.
            if (words.some((word) => id.startsWith(`${word}.`))) score += 1.5;
            return { entity, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);

        const areaMatch = entitiesInArea(controllable, target, ctx.config);

        // An area-style request ("downstairs", "everything upstairs") targets many devices.
        const areaish = /^(downstairs|upstairs|everywhere|everything|whole house|all)$/i.test(target) || areaMatch.length > 1;
        const chosen = areaish && areaMatch.length ? areaMatch : scored.slice(0, 1).map((entry) => entry.entity);

        if (!chosen.length) {
          const names = controllable.slice(0, 12).map((entity) => String(entity.attributes?.friendly_name ?? entity.entity_id));
          return {
            ok: false,
            mode: 'live',
            summary: `I could not match "${target}" to a device. Known devices include: ${names.join(', ') || 'none'}.`,
            error: 'no matching device',
          };
        }

        const details: { entityId: string; ok: boolean; detail: string }[] = [];
        for (const entity of chosen) {
          const domain = entity.entity_id.split('.')[0] ?? '';
          const service = action === 'on' ? 'turn_on' : action === 'off' ? 'turn_off' : 'toggle';
          const body: Record<string, unknown> = { entity_id: entity.entity_id };
          if (action === 'on' && input.brightnessPct !== undefined && domain === 'light') {
            body.brightness_pct = Number(input.brightnessPct);
          }
          const result = await httpJson(haBase(ctx.config, `services/${domain}/${service}`), {
            method: 'POST',
            headers: authHeaders(ctx.config),
            body: JSON.stringify(body),
          });
          details.push({
            entityId: entity.entity_id,
            ok: result.ok,
            detail: result.ok ? `${action} sent` : describeHttpError(result),
          });
        }

        const failures = details.filter((detail) => !detail.ok);
        const names = chosen.map((entity) => String(entity.attributes?.friendly_name ?? entity.entity_id));
        return {
          ok: failures.length === 0,
          mode: 'live',
          summary: failures.length
            ? `Tried to turn ${action} ${names.join(', ')} — ${failures.length} failed.`
            : `Turned ${action} ${names.length > 1 ? `${names.length} devices` : names[0]}${input.brightnessPct !== undefined ? ` at ${input.brightnessPct}%` : ''}.`,
          data: { target, action, matched: names, details },
          error: failures.length ? failures.map((detail) => `${detail.entityId}: ${detail.detail}`).join('; ') : undefined,
        };
      } catch (error) {
        return failure('Device control', error);
      }
    },
  },
  {
    id: 'areaOff',
    title: 'Turn off an area',
    description:
      'Resolves an area ("downstairs", "the kitchen") to devices and turns them all off. This is the "turn off everything downstairs" flow.',
    scopes: ['home:control'],
    risk: 'medium',
    parameters: [
      { name: 'area', type: 'string', description: 'Area or room to switch off.', required: true },
      {
        name: 'action',
        type: 'string',
        description: 'on | off (defaults to off).',
        required: false,
        enum: ['on', 'off'],
      },
    ],
    async run(input, ctx) {
      const area = String(input.area ?? '').trim();
      const action = String(input.action ?? 'off').toLowerCase() === 'on' ? 'on' : 'off';
      if (!area) return { ok: false, mode: 'live', summary: 'Which area should I switch?', error: 'missing area' };
      if (!ctx.config.value('HOME_ASSISTANT_URL') || !ctx.config.value('HOME_ASSISTANT_TOKEN')) {
        return sandbox(`Turn ${action} everything in "${area}"`, 'Home Assistant is not configured.', { area, action });
      }
      try {
        const states = await fetchStates(ctx.config);
        const targets = entitiesInArea(states, area, ctx.config);
        if (!targets.length) {
          return {
            ok: false,
            mode: 'live',
            summary: `No controllable devices matched "${area}".`,
            error: 'no matching entities — check HOME_AREAS or the device names',
          };
        }
        const details: { entityId: string; ok: boolean; detail: string }[] = [];
        for (const entity of targets) {
          const domain = entity.entity_id.split('.')[0] ?? '';
          const service = action === 'on' ? 'turn_on' : 'turn_off';
          const result = await httpJson(haBase(ctx.config, `services/${domain}/${service}`), {
            method: 'POST',
            headers: authHeaders(ctx.config),
            body: JSON.stringify({ entity_id: entity.entity_id }),
          });
          details.push({
            entityId: entity.entity_id,
            ok: result.ok,
            detail: result.ok ? `${action} sent` : describeHttpError(result),
          });
        }
        const failures = details.filter((detail) => !detail.ok);
        return {
          ok: failures.length === 0,
          mode: 'live',
          summary: `Turned ${action} ${details.length - failures.length}/${details.length} device(s) in ${area}.${
            failures.length ? ` ${failures.length} failed.` : ''
          }`,
          data: { area, action, details },
          error: failures.length ? failures.map((detail) => `${detail.entityId}: ${detail.detail}`).join('; ') : undefined,
        };
      } catch (error) {
        return failure('Area control', error);
      }
    },
  },
];

export const homeConnector: Connector = {
  manifest: {
    id: 'home',
    name: 'Xacheus Home Agent bridge (Home Assistant)',
    category: 'home',
    description:
      'Controls lights, switches, plugs, fans, thermostats, covers, locks, TVs and speakers through a Home Assistant instance. Only devices your Home Assistant already controls can be reached — Xacheus has no magic radio.',
    fields: [
      { key: 'HOME_ASSISTANT_URL', label: 'Home Assistant URL', secret: false, required: true, hint: 'e.g. http://homeassistant.local:8123' },
      { key: 'HOME_ASSISTANT_TOKEN', label: 'Long-lived access token', secret: true, required: true },
      { key: 'HOME_AREAS', label: 'Area map (JSON)', secret: false, required: false, hint: '{"downstairs":["living_room","kitchen"]}' },
    ],
    scopes: ['home:read', 'home:control'],
    capabilities: ['List devices', 'On/off/toggle devices', 'Scene control', 'Whole-area commands'],
    docsUrl: 'https://developers.home-assistant.io/docs/api/rest/',
  },
  operations: homeOperations,
  status: (config) => evaluateStatus(homeConnector, config),
  async verify(config) {
    const url = config.value('HOME_ASSISTANT_URL');
    const token = config.value('HOME_ASSISTANT_TOKEN');
    if (!url || !token) return { ok: false, detail: 'Home Assistant URL and token are required.' };
    const result = await httpJson(`${url.replace(/\/$/, '')}/api/`, { headers: { authorization: `Bearer ${token}` } });
    if (!result.ok) return { ok: false, detail: describeHttpError(result) };
    return { ok: true, detail: `Home Assistant reachable at ${url} (${result.payload?.message ?? 'API running'}).` };
  },
};
