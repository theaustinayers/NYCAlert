import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LearningLog } from './learning-log.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-learning-log-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

const makeEvent = (callId: string, transcript: string) => ({
  eventId: `event-${callId}`, callId, occurredAt: new Date().toISOString(), loggedAt: new Date().toISOString(),
  stage: 'transcription' as const, workflowPath: ['received', 'transcription'], agency: 'FDNY' as const,
  feedBorough: 'Manhattan' as const, transcript, transcriptCharacters: transcript.length,
  transcriptSource: 'local-whisper' as const, disposition: 'transcript-captured'
});

describe('LearningLog', () => {
  it('stores transcript workflow events as JSONL without any audio references', async () => {
    const directory = join(testDirectory, 'transcript-only');
    const log = new LearningLog(directory, true, 30, 100);
    await log.init();
    log.record(makeEvent('call-1', 'Engine 4 responding to a reported fire.'));
    await log.flush();

    const filePath = join(directory, 'learning-debug.jsonl');
    const line = (await readFile(filePath, 'utf8')).trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.transcriptSource, 'local-whisper');
    assert.equal(parsed.transcript, 'Engine 4 responding to a reported fire.');
    assert.equal(parsed.audioPath, undefined);
    assert.equal(parsed.audioBytes, undefined);
    assert.equal(log.getStatus().currentEvents, 1);
    assert.equal((await log.readRecent(10)).length, 1);
    assert.equal((await stat(filePath)).isFile(), true);
  });

  it('exports the complete retained log and clears it atomically', async () => {
    const directory = join(testDirectory, 'clearable');
    const log = new LearningLog(directory, true, 30, 100);
    log.record(makeEvent('call-2', 'Transcript one.'));
    log.record(makeEvent('call-3', 'Transcript two.'));
    await log.flush();

    const exported = await log.exportJsonl();
    assert.equal(exported.trim().split('\n').length, 2);
    await log.clear();
    assert.equal(log.getStatus().currentEvents, 0);
    assert.equal(await log.exportJsonl(), '');
    assert.equal((await readFile(join(directory, 'learning-debug.jsonl'), 'utf8')), '');
  });

  it('clears pending writes too, so an in-flight transcript is not left behind', async () => {
    const directory = join(testDirectory, 'queued-clear');
    const log = new LearningLog(directory, true, 30, 100);
    log.record(makeEvent('call-before-clear', 'Sensitive transcript should be deleted.'));
    await log.clear();
    assert.equal(log.getStatus().currentEvents, 0);
    assert.equal(await log.exportJsonl(), '');
  });

  it('does not create or export records while disabled', async () => {
    const directory = join(testDirectory, 'disabled');
    const log = new LearningLog(directory, false);
    log.record(makeEvent('call-4', 'Should not be written.'));
    await log.flush();
    assert.equal(log.getStatus().enabled, false);
    assert.equal(await log.exportJsonl(), '');
  });
});
