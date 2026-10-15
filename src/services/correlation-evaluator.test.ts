import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { series4CorrelationCases } from '../evaluation/series-4-correlation-cases.js';
import { evaluateCorrelationCases } from './correlation-evaluator.js';

describe('offline correlation evaluation pipeline', () => {
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
