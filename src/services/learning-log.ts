import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Agency, Borough } from '../domain/subscriptions.js';

export type LearningWorkflowStage =
  | 'received'
  | 'transcription'
  | 'transcription-error'
  | 'transcription-ignored'
  | 'repeat-suppressed'
  | 'triage'
  | 'triage-error'
  | 'geocoding'
  | 'correlation'
  | 'pending-queue'
  | 'incident-published'
  | 'incident-updated'
  | 'incident-suppressed'
  | 'incident-withheld'
  | 'discord-routing'
  | 'pending-expired'
  | 'pending-attached'
  | 'pending-discarded'
  | 'pending-approved'
  | 'retry'
  | 'error';

export interface LearningEvent {
  eventId: string;
  callId: string;
  sourceGroup?: string;
  occurredAt: string;
  loggedAt: string;
  stage: LearningWorkflowStage;
  workflowPath: string[];
  agency: Agency;
  feedBorough: Borough | 'Citywide';
  transcript?: string;
  transcriptSource?: 'broadcastify' | 'local-whisper';
  transcriptCharacters?: number;
  headline?: string;
  summary?: string;
  category?: string;
  trafficType?: 'routine' | 'incident' | 'unclassified';
  incidentType?: string;
  confidence?: number;
  scores?: { public: number; buff: number; newsMedia: number };
  thresholds?: { confidence: number; public: number; buff: number; newsMedia: number };
  qualifications?: { public: boolean; buff: boolean; newsMedia: boolean };
  routing?: {
    eligibleSubscriptions: number;
    public: number;
    buff: number;
    newsMedia: number;
    destinationCount: number;
    successfulDestinations: number;
    channelFetchFailures: number;
    unsupportedDestinations: number;
    sendFailures: number;
    discordMessagesSent: number;
    destinations: Array<{ result: 'sent' | 'channel-fetch-failed' | 'unsupported-channel' | 'send-failed'; errorCategory?: string }>;
  };
  location?: string;
  geocode?: { attempted: boolean; borough?: string; matched: boolean; latitude?: number; longitude?: number; error?: string };
  units?: string[];
  boxNumbers?: string[];
  correlation?: { candidateCount: number; incidentId?: string; pendingMatchCount?: number };
  disposition?: string;
  incidentId?: string;
  error?: { name: string; message: string };
}

const maxTranscriptCharacters = 20_000;
const maxStoredEventsAbsolute = 100_000;
const maxLogBytes = 100 * 1024 * 1024;

export class LearningLog {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private recordCount = 0;
  private initialized = false;
  private retentionTimer?: NodeJS.Timeout;

  constructor(
    dataDirectory: string,
    private readonly enabled: boolean,
    private readonly retentionDays = 30,
    private readonly maxEvents = 20_000
  ) {
    this.filePath = join(dataDirectory, 'learning-debug.jsonl');
  }

  get isEnabled(): boolean { return this.enabled; }

  getStatus(): { enabled: boolean; fileName: string; retentionDays: number; maxEvents: number; currentEvents: number } {
    return {
      enabled: this.enabled,
      fileName: 'learning-debug.jsonl',
      retentionDays: this.retentionDays,
      maxEvents: this.maxEvents,
      currentEvents: this.recordCount
    };
  }

  async readRecent(limit = 100): Promise<LearningEvent[]> {
    if (!this.enabled) return [];
    await this.flush();
    const contents = await readFile(this.filePath, 'utf8').catch(() => '');
    return contents.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(200, limit))).flatMap((line) => {
      try { return [JSON.parse(line) as LearningEvent]; }
      catch { return []; }
    }).reverse();
  }

  async init(): Promise<void> {
    if (!this.enabled || this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    try {
      const contents = await readFile(this.filePath, 'utf8');
      await chmod(this.filePath, 0o600);
      this.recordCount = contents.split('\n').filter(Boolean).length;
      if (this.recordCount > this.maxEvents || Buffer.byteLength(contents) > maxLogBytes) await this.trimFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
    await this.pruneExpired();
    this.retentionTimer ??= setInterval(() => {
      const next = this.writeQueue.catch(() => undefined).then(() => this.pruneExpired());
      this.writeQueue = next.catch(() => undefined);
    }, 60 * 60 * 1000).unref();
  }

  record(event: LearningEvent): void {
    if (!this.enabled) return;
    const safeEvent: LearningEvent = {
      ...event,
      ...(event.transcript !== undefined ? { transcript: event.transcript.slice(0, maxTranscriptCharacters) } : {}),
      ...(event.summary !== undefined ? { summary: event.summary.slice(0, 2_000) } : {}),
      ...(event.error ? { error: { name: event.error.name.slice(0, 120), message: redactDiagnostic(event.error.message).slice(0, 500) } } : {})
    };
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await this.init();
      await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.recordCount += 1;
      if (this.recordCount > this.maxEvents) await this.trimFile();
      if (this.recordCount % 100 === 0) await this.pruneExpired();
    });
    this.writeQueue = task.catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  async clear(): Promise<void> {
    if (!this.enabled) return;
    const next = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, '', { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.recordCount = 0;
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  async exportJsonl(): Promise<string> {
    if (!this.enabled) return '';
    await this.flush();
    const info = await stat(this.filePath).catch(() => undefined);
    if (!info) return '';
    if (info.size > 100 * 1024 * 1024) throw new Error('Learning log exceeds the 100 MB export safety limit.');
    return readFile(this.filePath, 'utf8');
  }

  private async trimFile(): Promise<void> {
    const keep = Math.max(1, Math.min(this.maxEvents, maxStoredEventsAbsolute));
    const contents = await readFile(this.filePath, 'utf8').catch(() => '');
    const candidates = contents.split('\n').filter(Boolean).slice(-keep);
    const lines: string[] = [];
    let bytes = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const line = candidates[index]!;
      const lineBytes = Buffer.byteLength(line) + 1;
      if (bytes + lineBytes > maxLogBytes) break;
      lines.unshift(line);
      bytes += lineBytes;
    }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    this.recordCount = lines.length;
  }

  private async pruneExpired(): Promise<void> {
    const info = await stat(this.filePath).catch(() => undefined);
    if (!info || info.size > maxLogBytes) {
      if (info) await this.trimFile();
      return;
    }
    const contents = await readFile(this.filePath, 'utf8').catch(() => '');
    const cutoff = Date.now() - Math.max(1, this.retentionDays) * 24 * 60 * 60 * 1000;
    const lines = contents.split('\n').filter(Boolean).filter((line) => {
      try {
        const record = JSON.parse(line) as { loggedAt?: string };
        return !record.loggedAt || Date.parse(record.loggedAt) >= cutoff;
      } catch { return false; }
    });
    const kept = lines.slice(-Math.max(1, Math.min(this.maxEvents, maxStoredEventsAbsolute)));
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, kept.length ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    this.recordCount = kept.length;
    await rm(`${this.filePath}.1`, { force: true });
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"<>|]+[\\/])+[^\s:'"<>|]*/g, '[PATH]');
}
