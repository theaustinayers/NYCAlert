import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { series4CorrelationCases } from '../evaluation/series-4-correlation-cases.js';
import { series5CorrelationCases } from '../evaluation/series-5-correlation-cases.js';
import { evaluateCorrelationCases } from './correlation-evaluator.js';

describe('offline correlation evaluation pipeline', () => {
  it('covers Series 5 late Box updates and correction safeguards without claiming verified incident labels', () => {
    const result = evaluateCorrelationCases(series5CorrelationCases);
    assert.equal(result.total, 4);
    assert.equal(result.passed, 4);
    assert.equal(result.falseMerges, 0);
    assert.equal(result.missedMatches, 0);
    assert.equal(result.unverifiedLabels, 4);
  });
  it('runs the versioned Series 4-inspired regression cases and reports false merges separately from missed matches', () => {
    const result = evaluateCorrelationCases(series4CorrelationCases);
    assert.equal(result.total, 4);
    assert.equal(result.passed, 4);
    assert.equal(result.failed, 0);
    assert.equal(result.falseMerges, 0);
    assert.equal(result.missedMatches, 0);
    assert.equal(result.unverifiedLabels, 4);
    assert.deepEqual(result.failures, []);
  });
});
