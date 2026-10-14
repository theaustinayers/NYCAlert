import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeLearningLog } from './learning-log-audit.js';

describe('analyzeLearningLog', () => {
  it('reports aggregate workflow and triage counts without returning transcript or identifiers', async () => {
    const rows = [
      { eventId: 'event-secret-1', callId: 'call-secret-1', stage: 'received' },
      {
        eventId: 'event-secret-1', callId: 'call-secret-1', stage: 'transcription',
        transcript: 'PRIVATE TRANSCRIPT MUST NEVER APPEAR IN AUDIT OUTPUT'
      },
      {
        eventId: 'event-secret-1', callId: 'call-secret-1', stage: 'triage',
        location: '123 Private Street', category: 'newsworthy', incidentType: 'fire', confidenceKind: 'triage-evidence-fit',
        thresholds: { confidence: 0.78, public: 4, buff: 4, newsMedia: 4 }
      },
      { eventId: 'event-secret-2', callId: 'call-secret-2', stage: 'received' },
      '{not-json'
    ].map((row) => typeof row === 'string' ? row : JSON.stringify(row));

    const report = await analyzeLearningLog(rows);
    const serialized = JSON.stringify(report);

    assert.equal(report.records.totalLines, 5);
    assert.equal(report.records.validRecords, 4);
    assert.equal(report.records.invalidJsonLines, 1);
    assert.equal(report.events.distinctEventIds, 2);
    assert.equal(report.events.withReceived, 2);
    assert.equal(report.events.missingTriageAfterReceived, 1);
    assert.equal(report.events.missingTranscriptionAfterReceived, 1);
    assert.equal(report.triage.recordsWithLocation, 1);
    assert.equal(report.triage.recordsWithoutLocation, 0);
    assert.deepEqual(report.triage.confidenceKinds, { 'triage-evidence-fit': 1 });
    assert.equal(report.triage.thresholdConfigurations['triageConfidence=0.78,public=4,buff=4,newsMedia=4'], 1);
    assert.equal(serialized.includes('PRIVATE TRANSCRIPT'), false);
    assert.equal(serialized.includes('123 Private Street'), false);
    assert.equal(serialized.includes('event-secret-1'), false);
    assert.equal(serialized.includes('call-secret-1'), false);
  });

  it('handles an empty stream and malformed JSON without exposing raw input', async () => {
    const sensitiveLabel = 'UNTRUSTED ADDRESS SHOULD NOT BECOME AN OUTPUT KEY';
    const report = await analyzeLearningLog([
      '',
      'not-json',
      JSON.stringify({ eventId: 'private-event', stage: 'triage', category: sensitiveLabel, incidentType: sensitiveLabel }),
      JSON.stringify({ eventId: 'private-event', stage: 'discord-routing', disposition: sensitiveLabel })
    ]);

    assert.equal(report.records.totalLines, 4);
    assert.equal(report.records.validRecords, 2);
    assert.equal(report.records.invalidJsonLines, 1);
    assert.equal(report.events.distinctEventIds, 1);
    assert.equal(report.triage.categories.other, 1);
    assert.equal(report.triage.confidenceKinds['legacy-unlabeled'], 1);
    assert.equal(report.discord.outcomes.other, 1);
    assert.equal(JSON.stringify(report).includes('not-json'), false);
    assert.equal(JSON.stringify(report).includes(sensitiveLabel), false);
  });
});
