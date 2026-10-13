import type { Agency, Borough } from '../domain/subscriptions.js';
import type { RadioCall } from '../domain/triage.js';
import { createHmac } from 'node:crypto';

export interface BroadcastifyProvider {
  listCalls(since: Date): Promise<RadioCall[]>;
  acknowledge?(call: RadioCall): void;
}

export interface BroadcastifyFeedMapping {
  playlistUuid: string;
  borough: Borough | 'Citywide';
  agency: Agency;
}

export interface BroadcastifyFeedStatus {
  id: string;
  name: string;
  agency: Agency;
  borough: Borough | 'Citywide';
  state: 'online' | 'offline' | 'unknown';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastActivityAt?: string;
  lastStreamDataAt?: string;
  callsSeen: number;
  lastError?: string;
}

interface FeedRuntimeStatus {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastActivityAt?: number;
  callsSeen: number;
  lastError?: string;
}

export interface BroadcastifyCallPayload {
  groupId?: string | number;
  ts?: number | string;
  lastPos?: number | string;
  feedId?: string | number;
  feed_id?: string | number;
  id?: string | number;
  call?: string;
  descr?: string;
  sdescr?: string;
  text?: string;
  transcription?: string;
  display?: string;
  audioUrl?: string;
  last?: number | string;
  time?: number | string;
  created?: number | string;
  groups?: string | string[];
  group?: string | number;
  audio_url?: string;
  source?: string;
  nodeId?: string | number;
  [key: string]: unknown;
}

export function parseFeedMap(value?: string): BroadcastifyFeedMapping[] {
  if (!value || !value.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('BROADCASTIFY_FEED_MAP must decode to a JSON array of { playlistUuid, borough, agency } objects.');

  return parsed.map((item) => {
    const record = item as Record<string, unknown>;
    const playlistUuid = String(record.playlistUuid ?? record.playlist_uuid ?? '').trim();
    const borough = String(record.borough ?? '').trim() as Borough;
    const agency = String(record.agency ?? '').trim() as Agency;

    if (!playlistUuid) throw new Error('Each feed mapping must include a playlistUuid.');
    if (!['Manhattan', 'Bronx', 'Queens', 'Brooklyn', 'Staten Island', 'Citywide'].includes(borough)) {
      throw new Error(`Unsupported borough in feed mapping: ${borough}`);
    }
    if (!['FDNY', 'NYPD'].includes(agency)) {
      throw new Error(`Unsupported agency in feed mapping: ${agency}`);
    }

    return { playlistUuid, borough, agency };
  });
}

export function normalizeLiveCall(raw: BroadcastifyCallPayload): { callId: string; position?: number; callText: string; occurredAt: Date; audioUrl?: string; transcription?: string; groupName?: string } {
  const groupId = String(raw.groupId ?? raw.group ?? raw.groups ?? 'call').trim();
  const timestamp = Number(raw.ts ?? raw.last ?? raw.time ?? raw.created ?? 0);
  const callText = String(raw.call ?? raw.descr ?? raw.sdescr ?? raw.text ?? '').trim() || 'Broadcastify call';
  const occurredAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
  const audioUrl = typeof raw.audioUrl === 'string'
    ? raw.audioUrl
    : typeof raw.audio_url === 'string'
      ? raw.audio_url
      : typeof raw.url === 'string'
        ? raw.url
        : undefined;
  const position = Number(raw.ts ?? raw.lastPos);

  return {
    callId: `${groupId}:${Number.isFinite(timestamp) ? timestamp : occurredAt.getTime()}`,
    position: Number.isFinite(position) && position > 0 ? position : undefined,
    callText,
    occurredAt,
    audioUrl,
    ...(typeof raw.transcription === 'string' && raw.transcription.trim() ? { transcription: raw.transcription.trim() } : {}),
    ...(typeof raw.display === 'string' && raw.display.trim() ? { groupName: raw.display.trim() } : {})
  };
}

export function createBroadcastifyJwt(
  keyId: string,
  issuer: string,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1000)
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT', kid: keyId });
  const payload = encode({ iss: issuer, iat: issuedAt, exp: issuedAt + 3600 });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export class BroadcastifyApiProvider implements BroadcastifyProvider {
  private readonly positions = new Map<string, number>();
  private readonly runtimeStatus = new Map<string, FeedRuntimeStatus>();
  private mappingIndex = 0;
  private lastRequestAt = 0;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly baseUrl?: string,
    private readonly keyId?: string,
    private readonly issuer?: string,
    private readonly secret?: string,
    private readonly feedMappings: BroadcastifyFeedMapping[] = [],
    fetcher: typeof fetch = fetch
  ) {
    this.fetcher = fetcher;
  }

  async listCalls(_since: Date): Promise<RadioCall[]> {
    if (!this.baseUrl) {
      throw new Error('Broadcastify integration needs the approved API base URL.');
    }
    if (!this.keyId || !this.issuer || !this.secret) {
      throw new Error('Broadcastify integration needs the JWT key ID, issuer, and signing secret.');
    }
    if (this.feedMappings.length === 0) return [];

    await this.waitForPollInterval();
    const mapping = this.feedMappings[this.mappingIndex] as BroadcastifyFeedMapping;
    this.mappingIndex = (this.mappingIndex + 1) % this.feedMappings.length;
    const runtime = this.runtimeStatus.get(mapping.playlistUuid) ?? { callsSeen: 0 };
    runtime.lastAttemptAt = Date.now();
    runtime.lastError = undefined;
    this.runtimeStatus.set(mapping.playlistUuid, runtime);

    const requestUrl = new URL(this.baseUrl.endsWith('/') ? `${this.baseUrl}calls/v1/live/` : `${this.baseUrl}/calls/v1/live/`);
    requestUrl.searchParams.set('playlist_uuid', mapping.playlistUuid);
    const position = this.positions.get(mapping.playlistUuid);
    if (position !== undefined) requestUrl.searchParams.set('pos', String(position));

    let payload: unknown;
    try {
      const response = await this.fetcher(requestUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${createBroadcastifyJwt(this.keyId, this.issuer, this.secret)}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Broadcastify live calls request failed: ${response.status} ${response.statusText}`);
      payload = await response.json() as unknown;
    } catch (error) {
      runtime.lastError = errorSummary(error);
      throw error;
    }
    const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as { calls?: unknown[]; data?: unknown[]; lastPos?: number | string }
      : undefined;
    const entries = Array.isArray(payload)
      ? payload
      : Array.isArray(envelope?.calls)
        ? envelope.calls
        : Array.isArray(envelope?.data)
          ? envelope.data
          : [];

    const calls = entries.map((entry) => {
      const normalized = normalizeLiveCall(entry as BroadcastifyCallPayload);
      return {
        id: `${mapping.playlistUuid}-${normalized.callId}`,
        borough: mapping.borough,
        agency: mapping.agency,
        occurredAt: normalized.occurredAt,
        transcript: normalized.transcription,
        groupName: normalized.groupName,
        audioUrl: normalized.audioUrl,
        sourcePosition: normalized.position
      } satisfies RadioCall;
    }).sort((left, right) => (left.sourcePosition ?? 0) - (right.sourcePosition ?? 0));

    runtime.lastSuccessAt = Date.now();
    runtime.callsSeen += calls.length;
    if (calls.length) runtime.lastActivityAt = Date.now();
    runtime.lastError = undefined;

    const lastPosition = Number(envelope?.lastPos);
    const lastCall = calls.at(-1);
    if (lastCall && Number.isFinite(lastPosition) && lastPosition > 0) lastCall.sourcePosition = lastPosition;
    return calls;
  }

  acknowledge(call: RadioCall): void {
    if (!call.sourcePosition || !Number.isFinite(call.sourcePosition)) return;
    const playlistUuid = this.feedMappings.find((mapping) => call.id.startsWith(`${mapping.playlistUuid}-`))?.playlistUuid;
    if (!playlistUuid) return;
    this.positions.set(playlistUuid, Math.max(this.positions.get(playlistUuid) ?? 0, call.sourcePosition));
  }

  getFeedStatuses(now = Date.now()): BroadcastifyFeedStatus[] {
    const staleAfterMs = Math.max(30_000, this.feedMappings.length * 15_000);
    return this.feedMappings.map((mapping) => {
      const runtime = this.runtimeStatus.get(mapping.playlistUuid);
      const state: BroadcastifyFeedStatus['state'] = !runtime?.lastAttemptAt
        ? 'unknown'
        : runtime.lastError && runtime.lastAttemptAt > (runtime.lastSuccessAt ?? 0)
          ? 'offline'
          : runtime.lastSuccessAt && now - runtime.lastSuccessAt <= staleAfterMs
            ? 'online'
            : 'offline';
      return {
        id: mapping.playlistUuid,
        name: `${mapping.agency} ${mapping.borough} Dispatch`,
        agency: mapping.agency,
        borough: mapping.borough,
        state,
        ...(runtime?.lastAttemptAt ? { lastAttemptAt: new Date(runtime.lastAttemptAt).toISOString() } : {}),
        ...(runtime?.lastSuccessAt ? { lastSuccessAt: new Date(runtime.lastSuccessAt).toISOString() } : {}),
        ...(runtime?.lastActivityAt ? { lastActivityAt: new Date(runtime.lastActivityAt).toISOString() } : {}),
        callsSeen: runtime?.callsSeen ?? 0,
        ...(runtime?.lastError ? { lastError: runtime.lastError } : {})
      };
    });
  }

  private async waitForPollInterval(): Promise<void> {
    const waitMs = Math.max(0, 5_000 - (Date.now() - this.lastRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastRequestAt = Date.now();
  }
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(token|secret|key)=\S+/gi, '$1=[redacted]').slice(0, 240);
}
