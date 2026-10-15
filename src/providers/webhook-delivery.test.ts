import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateWebhookEndpoint, WebhookDeliveryProvider, type WebhookTarget } from './webhook-delivery.js';
import type { DashboardIncident } from '../services/dashboard-store.js';

const discordUrl = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx';
const slackUrl = 'https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnopqrstuvwxyz';
const incident: DashboardIncident = {
  id: 'incident-123', title: 'Working fire', summary: 'Units operating at the scene.', occurredAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:01:00.000Z',
  agency: 'FDNY', agencies: ['FDNY'], borough: 'Brooklyn', category: 'newsworthy', incidentType: 'fire', location: 'Example cross street',
  locationPrecision: 'street_address', unitIds: [], unitAssignments: [], boxNumbers: [], updateCount: 0, updates: [], confidence: 0.9,
  newsworthinessScore: 4, buffInterestScore: 5, assignmentDeskScore: 4, hasAudio: false
};

describe('webhook delivery', () => {
  it('accepts only the supported HTTPS Discord and Slack incoming-webhook URL formats', () => {
    assert.equal(validateWebhookEndpoint(discordUrl, 'discord'), discordUrl);
    assert.equal(validateWebhookEndpoint(slackUrl, 'slack'), slackUrl);
    assert.equal(validateWebhookEndpoint('https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', 'discord'), undefined);
    assert.equal(validateWebhookEndpoint('https://hooks.slack.com.evil.example/services/T12345678/B12345678/abcdefghijklmnopqrstuvwxyz', 'slack'), undefined);
    assert.equal(validateWebhookEndpoint('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', 'discord'), undefined);
    assert.equal(validateWebhookEndpoint(`${discordUrl}?wait=true`, 'discord'), undefined);
    assert.equal(validateWebhookEndpoint('https://user:pass@discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', 'discord'), undefined);
    assert.equal(validateWebhookEndpoint(slackUrl, 'discord'), undefined);
  });

  it('sends audience-scoped safe incident payloads to Discord and Slack without following redirects', async () => {
    const targets: WebhookTarget[] = [
      { id: 'd'.repeat(32), accountId: 'a'.repeat(32), accountType: 'buff', platform: 'discord', url: discordUrl },
      { id: 's'.repeat(32), accountId: 'b'.repeat(32), accountType: 'news', platform: 'slack', url: slackUrl }
    ];
    const requested: Array<{ url: string; init: RequestInit }> = [];
    const provider = new WebhookDeliveryProvider({ listWebhookTargets: (_borough, audience) => targets.filter((target) => target.accountType === audience) }, 'https://nycalert.example', async (input, init) => {
      requested.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 204 });
    });
    const results = await provider.deliver({ incident, event: 'incident.created', audiences: ['buff', 'news'] });
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.outcome === 'sent'));
    assert.deepEqual(requested.map((request) => new URL(request.url).hostname).sort(), ['discord.com', 'hooks.slack.com']);
    assert.ok(requested.every((request) => request.init.redirect === 'manual'));
    const discordPayload = JSON.parse(String(requested.find((request) => request.url === discordUrl)?.init.body)) as Record<string, unknown>;
    assert.deepEqual(discordPayload.allowed_mentions, { parse: [] });
    assert.equal('transcript' in discordPayload, false);
    const slackPayload = JSON.parse(String(requested.find((request) => request.url === slackUrl)?.init.body)) as { blocks: Array<{ text: { type: string; text: string } }> };
    assert.equal(slackPayload.blocks[0]?.text.type, 'plain_text');
    assert.match(slackPayload.blocks[0]?.text.text ?? '', /incident\/incident-123/);
  });

  it('reports delivery failures without exposing endpoint credentials', async () => {
    const target: WebhookTarget = { id: 'f'.repeat(32), accountId: 'c'.repeat(32), accountType: 'buff', platform: 'discord', url: discordUrl };
    const provider = new WebhookDeliveryProvider({ listWebhookTargets: () => [target] }, 'https://nycalert.example', async () => new Response(null, { status: 429 }));
    const results = await provider.deliver({ incident, event: 'incident.updated', audiences: ['buff'] });
    assert.deepEqual(results, [{ webhookId: target.id, accountId: target.accountId, outcome: 'failed', statusCode: 429 }]);
    assert.equal(JSON.stringify(results).includes('abcdefghijklmnopqrstuvwx'), false);
  });
});
