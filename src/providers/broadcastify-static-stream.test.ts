import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { DashboardStore } from '../services/dashboard-store.js';
import { BroadcastifyStaticStreamMonitor, buildPcmSegmentArgs, createStreamDataTap, removeOrphanedNypdSegments } from './broadcastify-static-stream.js';

describe('buildPcmSegmentArgs', () => {
  it('writes self-contained 16 kHz mono PCM WAV segments for reliable Whisper input', () => {
    const args = buildPcmSegmentArgs('/var/lib/nyc-alert-bot/nypd-live-segments', 'nypd-123-0', 90);

    assert.ok(args.includes('pcm_s16le'));
    assert.ok(args.includes('16000'));
    assert.ok(args.includes('1'));
    assert.ok(args.includes('-segment_format'));
    assert.ok(args.includes('wav'));
    assert.ok(args.includes('90'));
    assert.match(args.at(-1) ?? '', /nypd-123-0-%06d\.wav$/);
    assert.equal(args.includes('copy'), false);
  });
});

describe('createStreamDataTap', () => {
  it('reports incoming chunks while passing the original audio bytes through', async () => {
    let chunksObserved = 0;
    const received: Buffer[] = [];
    const tap = createStreamDataTap(() => { chunksObserved += 1; });

    await new Promise<void>((resolve, reject) => {
      Readable.from([Buffer.from('audio-1'), Buffer.from('audio-2')])
        .pipe(tap)
        .on('data', (chunk: Buffer) => received.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(chunksObserved, 2);
    assert.equal(Buffer.concat(received).toString(), 'audio-1audio-2');
  });
});

describe('removeOrphanedNypdSegments', () => {
  it('removes prior-process WAV segments without touching unrelated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nyc-nypd-orphans-'));
    try {
      const orphan = 'nypd-1792035505965-0-000005.wav';
      await writeFile(join(directory, orphan), Buffer.from('incomplete wav'));
      await writeFile(join(directory, 'keep-this.txt'), Buffer.from('unrelated'));

      assert.equal(await removeOrphanedNypdSegments(directory), 1);
      assert.deepEqual(await readdir(directory), ['keep-this.txt']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('BroadcastifyStaticStreamMonitor segment processing', () => {
  it('keeps a fresh completed WAV segment for a later processing pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nyc-nypd-segments-'));
    const segmentDirectory = join(directory, 'nypd-live-segments');
    await mkdir(segmentDirectory, { recursive: true });
    const freshSegment = 'nypd-1792027856352-0-000000.wav';
    const newestSegment = 'nypd-1792027856352-0-000001.wav';
    const monitor = new BroadcastifyStaticStreamMonitor({
      feedId: '47753', username: 'test-user', password: 'test-password', dataDirectory: directory,
      ffmpegPath: 'ffmpeg', segmentSeconds: 90,
      processor: { async process() { throw new Error('Fresh segment must not be processed yet'); } } as never,
      dashboard: new DashboardStore(false)
    });

    try {
      await writeFile(join(segmentDirectory, freshSegment), Buffer.from('wav'));
      await writeFile(join(segmentDirectory, newestSegment), Buffer.from('active wav'));
      const processSegments = (monitor as unknown as { processSegments(): Promise<void> }).processSegments.bind(monitor);

      await processSegments();

      const remaining = await readdir(segmentDirectory);
      assert.ok(remaining.includes(freshSegment));
      assert.ok(remaining.includes(newestSegment));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
