import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecentRepeatDetector } from './repeat-detection.js';

describe('RecentRepeatDetector', () => {
  it('suppresses a highly overlapping transcript in the same borough for ten minutes', () => {
    const detector = new RecentRepeatDetector();
    const call = { agency: 'FDNY' as const, borough: 'Bronx' as const };
    const first = 'Alarm activation at 123 Main Street, caller reports smoke in the lobby, engine responding and ladder responding';
    const repeat = 'Caller reports smoke in the lobby at 123 Main Street, alarm activation; engine and ladder responding';

    assert.equal(detector.isRepeatedTranscript(call, first, 1_000), false);
    assert.equal(detector.isRepeatedTranscript(call, repeat, 20_000), true);
  });

  it('does not suppress different calls, another agency or calls after the window', () => {
    const detector = new RecentRepeatDetector();
    const call = { agency: 'FDNY' as const, borough: 'Brooklyn' as const };
    const transcript = 'Caller reports smoke in the lobby at 123 Main Street, alarm activation, engine responding';
    assert.equal(detector.isRepeatedTranscript(call, transcript, 1_000), false);
    assert.equal(detector.isRepeatedTranscript({ ...call, agency: 'NYPD' }, transcript, 2_000), false);
    assert.equal(detector.isRepeatedTranscript({ ...call, borough: 'Bronx' }, transcript, 3_000), false);
    assert.equal(detector.isRepeatedTranscript(call, 'Pedestrian struck at a different location, requesting EMS and traffic control', 4_000), false);
    assert.equal(detector.isRepeatedTranscript(call, transcript, 601_001), false);
  });

  it('detects a repeated alert summary inside the window', () => {
    const detector = new RecentRepeatDetector();
    const call = { agency: 'FDNY' as const, borough: 'Queens' as const };
    const summary = 'Working fire reported at 123 Main Street with smoke in the lobby';

    assert.equal(detector.isRepeatedIncident(call, summary, 1_000), false);
    assert.equal(detector.isRepeatedIncident(call, summary, 60_000), true);
  });

  it('recognizes the same incident when wording and street-number suffix differ', () => {
    const detector = new RecentRepeatDetector();
    const call = { agency: 'FDNY' as const, borough: 'Queens' as const };

    assert.equal(detector.isRepeatedIncident(call, 'Newsworthy incident FDNY Queens Auto accident reported on expressway near 108 Street', 1_000), false);
    assert.equal(detector.isRepeatedIncident(call, 'Breaking incident FDNY Queens Auto accident on Long Island Expressway at 108th Street', 60_000), true);
  });
});
