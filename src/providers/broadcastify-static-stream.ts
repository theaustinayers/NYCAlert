import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RadioCall } from '../domain/triage.js';
import type { Agency } from '../domain/subscriptions.js';
import type { CallProcessor } from '../services/call-processor.js';
import type { DashboardStore, PipelineDiagnostics } from '../services/dashboard-store.js';
import type { BroadcastifyFeedStatus } from './broadcastify.js';

export type StreamFetch = typeof fetch;
export type StreamSpawner = typeof nodeSpawn;

export function buildPcmSegmentArgs(segmentDirectory: string, outputPrefix: string, segmentSeconds: number): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    '-f', 'segment', '-segment_format', 'wav', '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1', join(segmentDirectory, `${outputPrefix}-%06d.wav`)
  ];
}

export function createStreamDataTap(onData: () => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onData();
      callback(null, chunk);
    }
  });
}

export interface BroadcastifyStaticStreamOptions {
  feedId: string;
  username: string;
  password: string;
  dataDirectory: string;
  ffmpegPath: string;
  segmentSeconds: number;
  processor: CallProcessor;
  dashboard: DashboardStore;
  fetcher?: StreamFetch;
  spawner?: StreamSpawner;
  agency?: Agency;
  borough?: RadioCall['borough'];
}

/** Authenticated server-side stream ingestion. Audio segments are always deleted after processing. */
export class BroadcastifyStaticStreamMonitor {
  private readonly fetcher: StreamFetch;
  private readonly spawner: StreamSpawner;
  private readonly segmentDirectory: string;
  private active = false;
  private connected = false;
  private controller?: AbortController;
  private child?: ChildProcess;
  private segmentTimer?: NodeJS.Timeout;
  private loop?: Promise<void>;
  private startedAt?: number;
  private lastSuccessAt?: number;
  private lastActivityAt?: number;
  private lastStreamDataAt?: number;
  private lastAttemptAt?: number;
  private callsSeen = 0;
  private callsProcessed = 0;
  private callsRetried = 0;
  private callsFailed = 0;
  private processingSegments = false;
  private streamSequence = 0;
  private lastError?: string;
  private stage = 'Not started';

  constructor(private readonly options: BroadcastifyStaticStreamOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.spawner = options.spawner ?? nodeSpawn;
    this.segmentDirectory = join(options.dataDirectory, 'nypd-live-segments');
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.stage = 'Connecting to authenticated NYPD stream';
    this.options.dashboard.setPipelineDiagnostics(this.diagnostics('starting'), 'nypd-static');
    this.segmentTimer = setInterval(() => void this.processSegments(), 1_500);
    this.segmentTimer.unref();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.segmentTimer) clearInterval(this.segmentTimer);
    this.segmentTimer = undefined;
    this.controller?.abort();
    this.child?.kill('SIGTERM');
    await this.loop?.catch(() => undefined);
    await this.processSegments();
    this.connected = false;
    this.stage = 'Stopped';
  }

  getFeedStatus(now = Date.now()): BroadcastifyFeedStatus[] {
    return [{
      id: `nypd-static-${this.options.feedId}`,
      name: 'NYPD Citywide Live',
      agency: this.options.agency ?? 'NYPD',
      borough: this.options.borough ?? 'Citywide',
      state: !this.lastAttemptAt ? 'unknown' : this.connected ? 'online' : 'offline',
      ...(this.lastAttemptAt ? { lastAttemptAt: new Date(this.lastAttemptAt).toISOString() } : {}),
      ...(this.lastSuccessAt ? { lastSuccessAt: new Date(this.lastSuccessAt).toISOString() } : {}),
      ...(this.lastActivityAt ? { lastActivityAt: new Date(this.lastActivityAt).toISOString() } : {}),
      ...(this.lastStreamDataAt ? { lastStreamDataAt: new Date(this.lastStreamDataAt).toISOString() } : {}),
      callsSeen: this.callsSeen,
      ...(this.lastError ? { lastError: this.lastError } : {})
    }];
  }

  private async run(): Promise<void> {
    try {
      await mkdir(this.segmentDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.lastError = sanitizeError(error);
      this.stage = 'Cannot create private NYPD audio segment directory';
      this.options.dashboard.setPipelineDiagnostics(this.diagnostics('error'), 'nypd-static');
      return;
    }
    while (this.active) {
      this.lastAttemptAt = Date.now();
      this.stage = 'Connecting to authenticated NYPD stream';
      try {
        await this.connectAndSegment();
        if (this.active) throw new Error('NYPD stream ended; reconnecting');
      } catch (error) {
        if (!this.active) break;
        this.connected = false;
        this.lastError = sanitizeError(error);
        this.stage = 'NYPD stream connection failed';
        this.callsFailed += 1;
        this.options.dashboard.setPipelineDiagnostics(this.diagnostics('error'), 'nypd-static');
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }

  private async connectAndSegment(): Promise<void> {
    this.controller = new AbortController();
    const authorization = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`;
    const response = await this.fetcher(`https://partner.broadcastify.com/${encodeURIComponent(this.options.feedId)}.mp3`, {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'audio/mpeg' },
      redirect: 'error',
      signal: this.controller.signal
    });
    if (!response.ok) throw new Error(`NYPD static stream returned HTTP ${response.status}`);
    if (!response.body) throw new Error('NYPD static stream response has no audio body');
    this.connected = true;
    this.lastSuccessAt = Date.now();
    this.lastError = undefined;
    this.stage = 'Receiving NYPD stream';
    this.options.dashboard.setPipelineDiagnostics(this.diagnostics('polling'), 'nypd-static');

    const child = this.spawner(this.options.ffmpegPath, buildPcmSegmentArgs(
      this.segmentDirectory,
      `nypd-${Date.now()}-${this.streamSequence++}`,
      this.options.segmentSeconds
    ), { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); });
    child.once('error', (error) => { this.lastError = sanitizeError(error); });

    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createStreamDataTap(() => {
          const now = Date.now();
          if (now - (this.lastStreamDataAt ?? 0) >= 30_000) this.lastStreamDataAt = now;
        }),
        child.stdin!
      );
    } finally {
      child.stdin?.end();
      await waitForClose(child);
      this.child = undefined;
      this.controller = undefined;
      this.connected = false;
      if (stderr.trim()) this.lastError = sanitizeError(new Error(stderr.trim()));
    }
  }

  private async processSegments(): Promise<void> {
    if (this.processingSegments) return;
    this.processingSegments = true;
    let names: string[];
    try {
      names = (await readdir(this.segmentDirectory)).filter((name) => /^nypd-\d{13}-\d+-\d{6}\.wav$/.test(name)).sort();
    } catch {
      this.processingSegments = false;
      return;
    }
    try {
      const completedNames = this.active ? names.slice(0, -1) : names;
      for (const name of completedNames) {
        const path = join(this.segmentDirectory, name);
        let file;
        try {
          file = await stat(path);
        } catch {
          continue;
        }
        if (!file.isFile() || Date.now() - file.mtimeMs < 2_500) continue;
        try {
          this.stage = 'Transcribing NYPD audio segment';
          this.options.dashboard.setPipelineDiagnostics(this.diagnostics('processing'), 'nypd-static');
          const call: RadioCall = {
            id: `nypd-${this.options.feedId}-${name.replace(/\.wav$/, '')}`,
            borough: this.options.borough ?? 'Citywide',
            agency: this.options.agency ?? 'NYPD',
            occurredAt: file.mtime,
            audioPath: path,
            audioContentType: 'audio/wav'
          };
          const result = await this.options.processor.process(call);
          if (result !== 'ignored') {
            this.callsSeen += 1;
            this.lastActivityAt = Date.now();
          }
          if (result === 'retry') this.callsRetried += 1;
          else this.callsProcessed += 1;
          this.options.dashboard.setPipelineDiagnostics(this.diagnostics('polling'), 'nypd-static');
        } catch (error) {
          this.callsFailed += 1;
          this.lastError = sanitizeError(error);
          this.options.dashboard.setPipelineDiagnostics(this.diagnostics('error'), 'nypd-static');
        } finally {
          await rm(path, { force: true }).catch(() => undefined);
        }
      }
    } finally {
      this.processingSegments = false;
    }
  }

  private diagnostics(state: PipelineDiagnostics['state']): PipelineDiagnostics {
    return {
      state,
      stage: this.stage,
      ...(this.startedAt ? { startedAt: new Date(this.startedAt).toISOString() } : {}),
      ...(this.lastAttemptAt ? { lastPollAt: new Date(this.lastAttemptAt).toISOString() } : {}),
      ...(this.lastActivityAt ? { lastCallAt: new Date(this.lastActivityAt).toISOString() } : {}),
      callsProcessed: this.callsProcessed,
      callsRetried: this.callsRetried,
      callsFailed: this.callsFailed,
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }
}

function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', () => resolve());
  });
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Basic\s+\S+/gi, 'Basic [redacted]').replace(/(password|secret|token)=\S+/gi, '$1=[redacted]').slice(0, 240);
}
