import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { buildPcmSegmentArgs, createStreamDataTap } from './broadcastify-static-stream.js';

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
