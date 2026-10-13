import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BroadcastifyAudioRetriever } from './broadcastify-audio.js';

const tempDirectory = await mkdtemp(join(tmpdir(), 'broadcastify-audio-'));
after(async () => rm(tempDirectory, { recursive: true, force: true }));

describe('BroadcastifyAudioRetriever', () => {
  it('downloads explicit HTTPS audio URLs to a private temporary file', async () => {
    const retriever = new BroadcastifyAudioRetriever({
      dataDirectory: tempDirectory,
      apiBaseUrl: 'https://api.bcfy.io',
      allowedHosts: ['media.bcfy.io'],
      fetcher: async () => new Response(Buffer.from('fake-mp3'), { headers: { 'content-type': 'audio/mpeg', 'content-length': '8' } })
    });
    const result = await retriever.retrieve('https://media.bcfy.io/calls/recording.mp3', 'test-call');
    assert.equal(result.contentType, 'audio/mpeg');
    assert.equal((await readFile(result.path)).toString(), 'fake-mp3');
    assert.match(result.path, /calls/);
  });

  it('rejects an unallowlisted media host before making a request', async () => {
    let requests = 0;
    const retriever = new BroadcastifyAudioRetriever({
      dataDirectory: tempDirectory,
      apiBaseUrl: 'https://api.bcfy.io',
      fetcher: async () => {
        requests += 1;
        return new Response('should not be fetched');
      }
    });
    await assert.rejects(retriever.retrieve('https://attacker.invalid/audio.mp3', 'call'), /not allowlisted/);
    assert.equal(requests, 0);
  });

  it('enforces the size limit even when Content-Length is missing', async () => {
    const sizeLimitDirectory = join(tempDirectory, 'size-limit');
    const retriever = new BroadcastifyAudioRetriever({
      dataDirectory: sizeLimitDirectory,
      apiBaseUrl: 'https://api.bcfy.io',
      maxBytes: 1024,
      fetcher: async () => new Response(Buffer.alloc(2048), { headers: { 'content-type': 'audio/mpeg' } })
    });
    await assert.rejects(retriever.retrieve('https://api.bcfy.io/audio', 'large-call'), /exceeded the configured/);
    const files = await readdir(join(sizeLimitDirectory, 'calls')).catch(() => []);
    assert.equal(files.length, 0);
  });
});
