import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { curateIncidentHeadline, explicitFdnyAirportAlarm, explicitFdnyThirdAlarmOrHigher, normalizeIncidentHeadline, shouldNotify, type CallTriage } from './triage.js';

const result: CallTriage = { shouldAlert: true, category: 'breaking', summary: 'Dispatch reports a major incident.', confidence: 0.9, newsworthinessScore: 5 };

describe('shouldNotify', () => {
  it('alerts only at or above the confidence threshold for non-routine calls', () => {
    assert.equal(shouldNotify(result), true);
    assert.equal(shouldNotify({ ...result, confidence: 0.5 }), false);
    assert.equal(shouldNotify({ ...result, category: 'routine' }), false);
  });

  it('applies the configurable 1–5 newsworthiness threshold', () => {
    assert.equal(shouldNotify({ ...result, newsworthinessScore: 3 }, 0.78, 4), false);
    assert.equal(shouldNotify({ ...result, newsworthinessScore: 3 }, 0.78, 3), true);
    assert.equal(shouldNotify({ ...result, newsworthinessScore: 4 }, 0.78, 5), false);
  });
});

describe('explicitFdnyThirdAlarmOrHigher', () => {
  it('recognizes spoken and numeric third-or-higher alarm assignments for FDNY', () => {
    assert.equal(explicitFdnyThirdAlarmOrHigher('Transmitting third alarm.', 'FDNY'), true);
    assert.equal(explicitFdnyThirdAlarmOrHigher('Transmit 3rd alarm.', 'FDNY'), true);
    assert.equal(explicitFdnyThirdAlarmOrHigher('Fourth alarm transmitted.', 'FDNY'), true);
    assert.equal(explicitFdnyThirdAlarmOrHigher('10th alarm.', 'FDNY'), true);
  });

  it('does not elevate second alarms, NYPD traffic, or incidental numbers', () => {
    assert.equal(explicitFdnyThirdAlarmOrHigher('Second alarm transmitted.', 'FDNY'), false);
    assert.equal(explicitFdnyThirdAlarmOrHigher('Third alarm reported.', 'NYPD'), false);
    assert.equal(explicitFdnyThirdAlarmOrHigher('Engine 3 responding to alarm.', 'FDNY'), false);
  });
});

describe('explicitFdnyAirportAlarm', () => {
  it('recognizes an FDNY alarm explicitly located at an airport without implying an emergency', () => {
    assert.equal(explicitFdnyAirportAlarm('Automatic valve alarm at JFK Airport.', 'FDNY'), true);
    assert.equal(explicitFdnyAirportAlarm('Routine unit status at JFK Airport.', 'FDNY'), false);
    assert.equal(explicitFdnyAirportAlarm('Fire alarm at JFK Airport.', 'NYPD'), false);
  });
});

describe('curateIncidentHeadline', () => {
  it('uses Box Alarm for EDP Train Car Fire when all facts are explicitly present', () => {
    assert.equal(
      curateIncidentHeadline('Phone Alarm Box', 'Box alarm activation: EDP setting fires in a train car.', 'FDNY'),
      'Box Alarm For EDP Train Car Fire'
    );
  });

  it('does not infer the curated Box/EDP/train headline when evidence is missing or from NYPD', () => {
    assert.equal(curateIncidentHeadline('Phone Alarm Box', 'EDP setting fires in a train car.', 'FDNY'), 'Phone Alarm Box');
    assert.equal(curateIncidentHeadline('Reported Train Fire', 'Box 1733 train car fire.', 'FDNY'), 'Reported Train Fire');
    assert.equal(normalizeIncidentHeadline('Box Alarm For EDP Train Car Fire', 'newsworthy'), 'Box Alarm For EDP Train Car Fire');
  });
});
