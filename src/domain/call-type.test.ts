import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveCallType, isCallType } from './call-type.js';

describe('deriveCallType', () => {
  it('maps detailed medical, fire, and police classifications to the broad call types', () => {
    assert.equal(deriveCallType('FDNY', 'fire'), 'fire');
    assert.equal(deriveCallType('FDNY', 'medical'), 'ems');
    assert.equal(deriveCallType('NYPD', 'police'), 'pd');
  });

  it('uses source agency to group vehicle incidents and leaves other calls unclassified', () => {
    assert.equal(deriveCallType('FDNY', 'vehicle'), 'fire');
    assert.equal(deriveCallType('NYPD', 'vehicle'), 'pd');
    assert.equal(deriveCallType('FDNY', 'other'), undefined);
    assert.equal(deriveCallType('NYPD', undefined), undefined);
  });

  it('validates only Fire, EMS, and PD', () => {
    assert.equal(isCallType('fire'), true);
    assert.equal(isCallType('ems'), true);
    assert.equal(isCallType('pd'), true);
    assert.equal(isCallType('medical'), false);
    assert.equal(isCallType(undefined), false);
  });
});
