import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RadioCall } from '../domain/triage.js';
import type { BroadcastifyProvider } from '../providers/broadcastify.js';
import type { AudioRetriever } from '../providers/broadcastify-audio.js';
import type { CallProcessor } from './call-processor.js';
import { CallFeedPoller } from './call-feed-poller.js';

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
