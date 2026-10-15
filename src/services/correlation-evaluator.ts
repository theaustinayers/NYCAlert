import { isSameIncident, type IncidentIdentity } from './incident-correlation.js';

export interface CorrelationEvaluationCase {
  id: string;
  labelStatus: 'synthetic-unverified' | 'human-reviewed' | 'adjudicated';
  expectedSameIncident: boolean;
  existing: IncidentIdentity;
  incoming: IncidentIdentity;
}

export interface CorrelationEvaluationResult {
  total: number;
  passed: number;
  failed: number;
  falseMerges: number;
  missedMatches: number;
  unverifiedLabels: number;
  failures: Array<{ id: string; expectedSameIncident: boolean; actualSameIncident: boolean; labelStatus: CorrelationEvaluationCase['labelStatus'] }>;
}

/** Offline regression evaluation of correlation code; never invokes an AI provider or reads raw logs. */
export function evaluateCorrelationCases(cases: readonly CorrelationEvaluationCase[]): CorrelationEvaluationResult {
  let passed = 0;
  let falseMerges = 0;
  let missedMatches = 0;
  let unverifiedLabels = 0;
  const failures: CorrelationEvaluationResult['failures'] = [];

  for (const testCase of cases) {
    const actualSameIncident = isSameIncident(testCase.existing, testCase.incoming);
    if (testCase.labelStatus === 'synthetic-unverified') unverifiedLabels += 1;
    if (actualSameIncident === testCase.expectedSameIncident) {
      passed += 1;
      continue;
    }
    if (actualSameIncident) falseMerges += 1;
    else missedMatches += 1;
    failures.push({
      id: testCase.id,
      expectedSameIncident: testCase.expectedSameIncident,
      actualSameIncident,
      labelStatus: testCase.labelStatus
    });
  }

  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    falseMerges,
    missedMatches,
    unverifiedLabels,
    failures
  };
}
