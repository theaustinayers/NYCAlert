import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeFdnyTransmission, createQueensAddressCandidate } from './fdny-radio.js';

describe('analyzeFdnyTransmission', () => {
  it('records literal code and phrase cues with offsets without interpreting the incident', () => {
    const transcript = 'Queens Box 981. Transmitting 10-75, fire on the fifth floor of a six-story, non-fireproof multiple dwelling. 10-12 preliminary report. 10-84, under control; return all units. Verify address with a 10-7.';
    const analysis = analyzeFdnyTransmission(transcript, 'FDNY', 'Queens');

    assert.equal(analysis.grammarVersion, 'fdny-literal-signals-v1');
    assert.deepEqual(analysis.signals.map(({ name, evidence }) => ({ name, text: transcript.slice(evidence.start, evidence.end) })), [
      { name: 'box-reference', text: 'Box 981' },
      { name: '10-75', text: '10-75' },
      { name: '10-12', text: '10-12' },
      { name: '10-84', text: '10-84' },
      { name: 'under-control', text: 'under control' },
      { name: 'return-all-units', text: 'return all units' },
      { name: '10-7', text: '10-7' }
    ]);
    assert.deepEqual(analysis.buildingMentions.map(({ kind, evidence }) => ({ kind, text: transcript.slice(evidence.start, evidence.end) })), [
      { kind: 'floor', text: 'fifth floor' },
      { kind: 'building-height', text: 'six-story' },
      { kind: 'occupancy', text: 'multiple dwelling' }
    ]);
    assert.deepEqual(analysis.queensAddressCandidates, []);
  });

  it('does not parse FDNY radio cues from an NYPD transcript', () => {
    const analysis = analyzeFdnyTransmission('10-75, under control.', 'NYPD', 'Queens');
    assert.equal(analysis.signals.length, 0);
    assert.equal(analysis.buildingMentions.length, 0);
  });
});

describe('createQueensAddressCandidate', () => {
  it('generates review-only hyphenated candidates for spoken Queens house numbers', () => {
    assert.deepEqual(createQueensAddressCandidate('158 24 81st Street', 'Queens'), [{
      normalized: '158-24 81st Street',
      sourceField: 'triage.location',
      verification: 'candidate-only',
      rule: 'space-separated-queens-house-number'
    }]);
    assert.equal(createQueensAddressCandidate('66 03 Booth Street', 'Queens')[0]?.normalized, '66-03 Booth Street');
    assert.equal(createQueensAddressCandidate('13 103 41st Avenue', 'Queens')[0]?.normalized, '13-103 41st Avenue');
  });

  it('leaves ranges, conventional addresses, explicit non-Queens locations, and unhyphenated input unchanged', () => {
    assert.deepEqual(createQueensAddressCandidate('22 to 28 Reade Street', 'Queens'), []);
    assert.deepEqual(createQueensAddressCandidate('170 North 5th Street', 'Queens'), []);
    assert.deepEqual(createQueensAddressCandidate('158-24 81st Street', 'Queens'), []);
    assert.deepEqual(createQueensAddressCandidate('158 24 81st Street, Brooklyn', 'Queens'), []);
    assert.deepEqual(createQueensAddressCandidate('158 24 81st Street', 'Brooklyn'), []);
  });
});
