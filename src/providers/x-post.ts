import { createHmac, randomBytes } from 'node:crypto';
import type { Agency, Borough } from '../domain/subscriptions.js';

export interface XIncidentPost {
  id: string;
  headline: string;
  incidentType?: string;
  agency: Agency;
  borough: Borough | 'Citywide';
  location?: string;
  unitIds: string[];
  boxNumbers: string[];
  newsworthinessScore: number;
  incidentUrl: string;
}

export interface XPostResult {
  postId: string;
  text: string;
  url: string;
}

export interface IncidentPostPublisher {
  publishIncident(incident: XIncidentPost): Promise<XPostResult>;
}

export type XPublisherCredentials =
  | { kind: 'oauth2-user'; userAccessToken: string }
  | { kind: 'oauth1-user'; consumerKey: string; consumerSecret: string; accessToken: string; accessTokenSecret: string };

export function formatXIncidentPost(incident: XIncidentPost): string | undefined {
  const place = incident.borough === 'Citywide' ? 'Citywide' : incident.borough;
  const type = incident.incidentType?.trim().toUpperCase();
  const hashtags = [
    `#${incident.agency}`,
    `#${incident.borough === 'Staten Island' ? 'StatenIsland' : incident.borough === 'Citywide' ? 'NYCCitywide' : incident.borough}`,
    '#NYC',
    ...(incident.newsworthinessScore >= 5 ? ['#Breaking'] : []),
    '#NYCAlert'
  ];
  const fields = [
    `${type ? `${type} · ` : ''}${incident.headline} · ${incident.agency}`,
    `Address: ${incident.location || `Not confirmed · ${place}`}`,
    place,
    ...(incident.unitIds.length ? [incident.unitIds.join(', ')] : []),
    ...(incident.boxNumbers.length ? [incident.boxNumbers.join(', ')] : []),
    hashtags.join(' '),
    incident.incidentUrl
  ];
  const text = fields.join('\n');
  return xWeightedLength(text) <= 280 ? text : undefined;
}

function xWeightedLength(text: string): number {
  const urlPattern = /https?:\/\/[^\s]+/g;
  let total = 0;
  let offset = 0;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    total += weightedCharacters(text.slice(offset, index));
    total += 23;
    offset = index + match[0].length;
  }
  return total + weightedCharacters(text.slice(offset));
}

function weightedCharacters(value: string): number {
  let total = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    total += codePoint <= 0x10ff ? 1 : 2;
  }
  return total;
}

export class XApiIncidentPublisher implements IncidentPostPublisher {
  constructor(
    private readonly credentials: XPublisherCredentials,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async publishIncident(incident: XIncidentPost): Promise<XPostResult> {
    const text = formatXIncidentPost(incident);
    if (!text) throw new Error('Formatted incident post exceeds the X 280-character limit.');

    const endpoint = 'https://api.x.com/2/tweets';
    const authorization = this.credentials.kind === 'oauth2-user'
      ? `Bearer ${this.credentials.userAccessToken}`
      : createOAuth1AuthorizationHeader('POST', endpoint, this.credentials);
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { title?: unknown; detail?: unknown };
      const reason = typeof detail.detail === 'string' ? detail.detail
        : typeof detail.title === 'string' ? detail.title
          : `HTTP ${response.status}`;
      throw new Error(`X create-post request failed: ${reason.slice(0, 240)}`);
    }
    const body = await response.json() as { data?: { id?: unknown } };
    if (typeof body.data?.id !== 'string' || !/^\d{1,19}$/.test(body.data.id)) {
      throw new Error('X create-post response did not include a valid post ID.');
    }
    return { postId: body.data.id, text, url: `https://x.com/i/web/status/${body.data.id}` };
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function createOAuth1AuthorizationHeader(
  method: string,
  endpoint: string,
  credentials: Extract<XPublisherCredentials, { kind: 'oauth1-user' }>,
  nonce = randomBytes(18).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000).toString()
): string {
  const oauthParameters: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: '1.0'
  };
  const normalizedParameters = Object.entries(oauthParameters)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signatureBase = [method.toUpperCase(), percentEncode(endpoint), percentEncode(normalizedParameters)].join('&');
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessTokenSecret)}`;
  oauthParameters.oauth_signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');
  return `OAuth ${Object.entries(oauthParameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ')}`;
}
