import type { Borough } from '../domain/subscriptions.js';
import type { DashboardIncident } from '../services/dashboard-store.js';

export type WebhookPlatform = 'discord' | 'slack';
export type WebhookAudience = 'buff' | 'news';

export interface WebhookTarget {
  id: string;
  accountId: string;
  accountType: WebhookAudience;
  platform: WebhookPlatform;
  url: string;
}

export interface WebhookTargetStore {
  listWebhookTargets(borough: Borough | 'Citywide', audience: WebhookAudience): WebhookTarget[];
}

export interface WebhookDeliveryRequest {
  incident: DashboardIncident;
  event: 'incident.created' | 'incident.updated';
  audiences: WebhookAudience[];
}

export interface IncidentWebhookDelivery {
  deliver(request: WebhookDeliveryRequest): Promise<WebhookDeliveryResult[]>;
}

export interface WebhookDeliveryResult {
  webhookId: string;
  accountId: string;
  outcome: 'sent' | 'failed' | 'invalid-endpoint';
  statusCode?: number;
}

export function inferWebhookPlatform(value: string): WebhookPlatform | undefined {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'discord.com') return 'discord';
    if (host === 'hooks.slack.com') return 'slack';
  } catch { /* Invalid or legacy custom endpoints are never dispatched. */ }
  return undefined;
}

export function validateWebhookEndpoint(value: string, platform: WebhookPlatform): string | undefined {
  if (value.length > 2_000) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (platform === 'discord') {
      if (host !== 'discord.com' || !/^\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]{20,}$/.test(url.pathname)) return undefined;
    } else if (host !== 'hooks.slack.com' || !/^\/services\/[A-Z0-9]{8,}\/[A-Z0-9]{8,}\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export class WebhookDeliveryProvider implements IncidentWebhookDelivery {
  constructor(
    private readonly targets: WebhookTargetStore,
    private readonly publicUrl: string,
    private readonly send: typeof fetch = fetch
  ) {}

  async deliver(request: WebhookDeliveryRequest): Promise<WebhookDeliveryResult[]> {
    const seen = new Set<string>();
    const jobs: Array<{ target: WebhookTarget; endpoint: string }> = [];
    const invalid: WebhookDeliveryResult[] = [];
    for (const audience of new Set(request.audiences)) {
      for (const target of this.targets.listWebhookTargets(request.incident.borough, audience)) {
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        const endpoint = validateWebhookEndpoint(target.url, target.platform);
        if (!endpoint) {
          invalid.push({ webhookId: target.id, accountId: target.accountId, outcome: 'invalid-endpoint' });
          continue;
        }
        jobs.push({ target, endpoint });
      }
    }
    const results: WebhookDeliveryResult[] = [];
    let nextJob = 0;
    const worker = async () => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob++];
        if (!job) return;
        const { target, endpoint } = job;
        try {
          const response = await this.send(endpoint, {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(8_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload(target.platform, request, this.publicUrl))
          });
          void response.body?.cancel().catch(() => undefined);
          results.push({
            webhookId: target.id,
            accountId: target.accountId,
            outcome: response.ok ? 'sent' : 'failed',
            statusCode: response.status
          });
        } catch {
          results.push({ webhookId: target.id, accountId: target.accountId, outcome: 'failed' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    return [...results, ...invalid];
  }
}

function buildPayload(platform: WebhookPlatform, request: WebhookDeliveryRequest, publicUrl: string): Record<string, unknown> {
  const { incident, event } = request;
  const title = truncate(`${event === 'incident.created' ? 'New incident' : 'Incident update'}: ${incident.title}`, 250);
  const details = [
    incident.summary,
    incident.location ? `Location: ${incident.location}` : undefined,
    `Agency: ${incident.agency} · ${incident.borough}`,
    incident.incidentType ? `Type: ${incident.incidentType}` : undefined,
    new URL(`/incident/${encodeURIComponent(incident.id)}`, publicUrl).toString()
  ].filter(Boolean).join('\n');
  if (platform === 'discord') {
    return {
      embeds: [{ title, description: truncate(details, 4_000), color: 0x32b891, timestamp: incident.updatedAt }],
      allowed_mentions: { parse: [] }
    };
  }
  const text = truncate(`${title}\n${details}`, 2_900);
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: true } }]
  };
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
