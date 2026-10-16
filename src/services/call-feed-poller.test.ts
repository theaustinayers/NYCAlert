import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RadioCall } from '../domain/triage.js';
import type { BroadcastifyProvider } from '../providers/broadcastify.js';
import type { AudioRetriever } from '../providers/broadcastify-audio.js';
import type { CallProcessor } from './call-processor.js';
import { CallFeedPoller } from './call-feed-poller.js';
import { DashboardStore } from './dashboard-store.js';

const call: RadioCall = {
  id: 'fdny-test-call',
  agency: 'FDNY',
  borough: 'Manhattan',
  occurredAt: new Date(),
  transcript: 'Rescue 1 is back in service.',
  audioUrl: 'https://calls-ai-1.broadcastify.com/example.mp3'
};

describe('CallFeedPoller', () => {
  it('does not fetch per-call audio when dashboard playback is disabled', async () => {
    let audioRequests = 0;
    let processedCall: RadioCall | undefined;
    const provider = createProvider();
    const audio: AudioRetriever = {
      async retrieve() {
        audioRequests += 1;
        throw new Error('Audio should not be requested');
      }
    };
    const processor = {
      async process(value: RadioCall) {
        processedCall = value;
        return 'processed' as const;
      }
    } as CallProcessor;
    const poller = new CallFeedPoller(provider, processor, audio, false, 60_000);

    try {
      await pollOnce(poller, provider);
      assert.equal(audioRequests, 0);
      assert.equal(processedCall?.transcript, call.transcript);
      assert.equal(processedCall?.audioPath, undefined);
    } finally {
      poller.stop();
    }
  });

  it('offers a lazy audio loader when incident playback is explicitly enabled without downloading yet', async () => {
    let audioRequests = 0;
    let processedCall: RadioCall | undefined;
    const provider = createProvider();
    const audio: AudioRetriever = {
      async retrieve() {
        audioRequests += 1;
        return { path: 'recording.mp3', contentType: 'audio/mpeg' };
      }
    };
    const processor = {
      async process(value: RadioCall, loadIncidentAudio?: () => Promise<{ path: string; contentType: string }>) {
        processedCall = value;
        assert.ok(loadIncidentAudio);
        return 'processed' as const;
      }
    } as CallProcessor;
    const poller = new CallFeedPoller(provider, processor, audio, true, 60_000);

    try {
      await pollOnce(poller, provider);
      assert.equal(audioRequests, 0);
      assert.equal(processedCall?.transcript, call.transcript);
      assert.equal(processedCall?.audioPath, undefined);
    } finally {
      poller.stop();
    }
  });

  it('retains downloaded FDNY audio when the incident board stores it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nyc-call-audio-retention-'));
    const audioPath = join(directory, 'incident.mp3');
    await writeFile(audioPath, Buffer.from('approved radio audio'));
    const provider = createProvider();
    const dashboard = new DashboardStore(true);
    const audio: AudioRetriever = { async retrieve() { return { path: audioPath, contentType: 'audio/mpeg' }; } };
    const processor = {
      async process(value: RadioCall, loadIncidentAudio?: () => Promise<{ path: string; contentType: string }>) {
        const retrieved = await loadIncidentAudio?.();
        assert.ok(retrieved);
        await dashboard.publish({
          title: 'Reported fire', summary: 'Fire reported.', occurredAt: value.occurredAt,
          agency: value.agency, borough: value.borough, category: 'newsworthy', audioPath: retrieved.path,
          audioContentType: retrieved.contentType, confidence: 0.9, newsworthinessScore: 4
        });
        return 'alert' as const;
      }
    } as CallProcessor;
    const poller = new CallFeedPoller(provider, processor, audio, true, 60_000, dashboard);

    try {
      await pollOnce(poller, provider);
      const incident = dashboard.search()[0];
      assert.equal(incident?.hasAudio, true);
      assert.equal(dashboard.getAudio(incident!.id)?.path, audioPath);
      assert.equal((await stat(audioPath)).isFile(), true);
      await dashboard.deleteIncident(incident!.id);
      await assert.rejects(stat(audioPath));
    } finally {
      poller.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createProvider(): BroadcastifyProvider & { acknowledged: boolean } {
  return {
    acknowledged: false,
    async listCalls() { return [call]; },
    acknowledge() { this.acknowledged = true; }
  };
}

async function pollOnce(poller: CallFeedPoller, provider: ReturnType<typeof createProvider>): Promise<void> {
  poller.start();
  for (let attempt = 0; attempt < 100 && !provider.acknowledged; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(provider.acknowledged, true, 'poller should process and acknowledge the call');
}
