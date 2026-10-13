import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface RetrievedAudio {
  path: string;
  contentType: string;
}

export interface AudioRetriever {
  retrieve(audioUrl: string, callId: string): Promise<RetrievedAudio>;
}

export interface BroadcastifyAudioRetrieverOptions {
  dataDirectory: string;
  apiBaseUrl: string;
  allowedHosts?: string[];
  maxBytes?: number;
  fetcher?: typeof fetch;
}

const audioTypes = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'video/mp4']);

export class BroadcastifyAudioRetriever implements AudioRetriever {
  private readonly allowedHosts: Set<string>;
  private readonly maxBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: BroadcastifyAudioRetrieverOptions) {
    const apiHost = new URL(options.apiBaseUrl).hostname.toLowerCase();
    this.allowedHosts = new Set((options.allowedHosts?.length ? options.allowedHosts : [apiHost]).map((host) => host.toLowerCase()));
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.fetcher = options.fetcher ?? fetch;
  }

  async retrieve(audioUrl: string, callId: string): Promise<RetrievedAudio> {
    const target = this.validateUrl(audioUrl);
    let response: Response | undefined;

    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await this.fetcher(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) throw new Error('Broadcastify audio redirect was missing or exceeded the redirect limit.');
      target.href = this.validateUrl(new URL(location, target).toString()).href;
    }

    if (!response || !response.ok) {
      throw new Error(`Broadcastify audio download failed: ${response?.status ?? 'no response'} ${response?.statusText ?? ''}`.trim());
    }
    if (!response.body) throw new Error('Broadcastify audio response had no body.');

    const declaredType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase();
    const contentType = declaredType === 'application/octet-stream' ? contentTypeFromPath(target.pathname) : declaredType;
    if (!audioTypes.has(contentType)) throw new Error(`Broadcastify returned unsupported audio content type: ${contentType}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
      throw new Error(`Broadcastify audio is larger than the configured ${this.maxBytes}-byte limit.`);
    }

    const directory = join(this.options.dataDirectory, 'calls');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const safeCallId = callId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || randomUUID();
    const audioPath = join(directory, `${safeCallId}-${randomUUID()}.audio`);
    let bytes = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        callback(bytes > this.maxBytes ? new Error(`Broadcastify audio exceeded the configured ${this.maxBytes}-byte limit.`) : null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        limiter,
        createWriteStream(audioPath, { flags: 'wx', mode: 0o600 })
      );
      if (bytes === 0) throw new Error('Broadcastify returned an empty audio file.');
      return { path: audioPath, contentType };
    } catch (error) {
      await rm(audioPath, { force: true });
      throw error;
    }
  }

  private validateUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Broadcastify audio URLs must use HTTPS.');
    if (url.username || url.password) throw new Error('Broadcastify audio URLs must not include embedded credentials.');
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error(`Broadcastify audio host is not allowlisted: ${url.hostname}`);
    }
    return url;
  }
}

function contentTypeFromPath(pathname: string): string {
  const path = pathname.toLowerCase();
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.mp4') || path.endsWith('.m4a')) return 'audio/mp4';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.aac')) return 'audio/aac';
  return 'application/octet-stream';
}
