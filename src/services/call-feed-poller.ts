import type { CallProcessor } from './call-processor.js';
import type { BroadcastifyProvider } from '../providers/broadcastify.js';
import type { AudioRetriever } from '../providers/broadcastify-audio.js';
import { rm } from 'node:fs/promises';
import { logger } from '../logger.js';
import type { DashboardStore, PipelineDiagnostics } from './dashboard-store.js';

export class CallFeedPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly counters = { callsProcessed: 0, callsRetried: 0, callsFailed: 0 };
  private startedAt?: number;
  private lastPollAt?: number;
  private lastCallAt?: number;
  private lastError?: string;

  constructor(
    private readonly provider: BroadcastifyProvider,
    private readonly processor: CallProcessor,
    private readonly audioRetriever: AudioRetriever,
    private readonly retainProcessedAudio: boolean,
    private readonly pollIntervalMs = 5_000,
    private readonly dashboard?: DashboardStore,
    private readonly downloadIncidentAudio = retainProcessedAudio
  ) {}

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.setDiagnostics('starting', 'Initializing Broadcastify Calls API polling');
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastPollAt = Date.now();
    this.lastError = undefined;
    this.setDiagnostics('polling', 'Fetching the next configured playlist');
    try {
      const calls = await this.provider.listCalls(new Date(Date.now() - this.pollIntervalMs));
      for (const call of calls) {
        this.lastCallAt = Date.now();
        this.setDiagnostics('processing', `Retrieving call audio (${call.agency} ${call.borough})`);
        if (!call.transcript && !call.audioUrl) {
          this.counters.callsFailed += 1;
          this.lastError = `Call ${call.id} has no documented audio URL in its API response`;
          logger.warn({ callId: call.id }, 'Call metadata had no audio URL; cannot transcribe this call');
          this.setDiagnostics('error', 'Call metadata did not include retrievable audio');
          break;
        }

        let audioPath: string | undefined;
        let keepAudio = false;
        let acknowledged = false;
        try {
          let result: 'processed' | 'alert' | 'retry' | 'ignored';
          if (call.transcript) {
            const loadIncidentAudio = this.downloadIncidentAudio && call.agency === 'FDNY' && call.audioUrl
              ? async () => {
                const retrievedAudio = await this.audioRetriever.retrieve(call.audioUrl!, call.id);
                audioPath = retrievedAudio.path;
                return retrievedAudio;
              }
              : undefined;
            result = await this.processor.process(call, loadIncidentAudio);
          } else {
            const retrievedAudio = await this.audioRetriever.retrieve(call.audioUrl!, call.id);
            audioPath = retrievedAudio.path;
            result = await this.processor.process({ ...call, audioPath, audioContentType: retrievedAudio.contentType });
          }
          if (result !== 'retry') {
            this.provider.acknowledge?.(call);
            acknowledged = true;
            keepAudio = this.retainProcessedAudio && result === 'alert' && call.agency === 'FDNY';
            this.counters.callsProcessed += 1;
          } else {
            this.counters.callsRetried += 1;
          }
        } catch (error) {
          this.counters.callsFailed += 1;
          this.lastError = safeError(error);
          logger.error({ error: this.lastError, callId: call.id }, 'Call audio retrieval/transcription/triage failed');
        } finally {
          if (audioPath && !keepAudio) await rm(audioPath, { force: true }).catch((error: unknown) => {
            logger.warn({ error, callId: call.id }, 'Could not remove temporary call audio');
          });
        }
        if (!acknowledged) break;
      }
      if (!this.lastError) this.setDiagnostics('polling', `Playlist checked; ${calls.length} call(s) returned`);
    } catch (error) {
      this.counters.callsFailed += 1;
      this.lastError = safeError(error);
      this.setDiagnostics('error', 'Broadcastify Calls API request failed');
      logger.error({ error }, 'Broadcastify poll failed');
    } finally {
      this.running = false;
    }
  }

  private setDiagnostics(state: PipelineDiagnostics['state'], stage: string): void {
    this.dashboard?.setPipelineDiagnostics({
      state,
      stage,
      ...(this.startedAt ? { startedAt: new Date(this.startedAt).toISOString() } : {}),
      ...(this.lastPollAt ? { lastPollAt: new Date(this.lastPollAt).toISOString() } : {}),
      ...(this.lastCallAt ? { lastCallAt: new Date(this.lastCallAt).toISOString() } : {}),
      ...this.counters,
      ...(this.lastError ? { lastError: this.lastError } : {})
    });
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240);
}