import type { IncidentIdentity } from '../services/incident-correlation.js';
import type { CorrelationEvaluationCase } from '../services/correlation-evaluator.js';

/** Synthetic behavioral expectations derived from Series 5; not verified labels for actual radio incidents. */
const initial: IncidentIdentity = {
  agency: 'FDNY', borough: 'Queens', incidentType: 'fire', location: '123-45 Example Avenue',
  boxNumbers: ['BOX 4001'], unitIds: [], occurredAt: 1_000_000
};

export const series5CorrelationCases: CorrelationEvaluationCase[] = [
  {
    id: 'series5-late-addressless-box-operational-report', labelStatus: 'synthetic-unverified', expectedSameIncident: true,
    existing: initial,
    incoming: { ...initial, location: undefined, isOperationalUpdate: true, occurredAt: initial.occurredAt + 12 * 60_000 }
  },
  {
    id: 'series5-explicit-address-correction', labelStatus: 'synthetic-unverified', expectedSameIncident: true,
    existing: { ...initial, location: '121-11 Example Street' },
    incoming: { ...initial, isExplicitLocationCorrection: true, occurredAt: initial.occurredAt + 6 * 60_000 }
  },
  {
    id: 'series5-box-reuse-in-different-borough', labelStatus: 'synthetic-unverified', expectedSameIncident: false,
    existing: initial,
    incoming: { ...initial, borough: 'Bronx', location: undefined, isOperationalUpdate: true, occurredAt: initial.occurredAt + 60_000 }
  },
  {
    id: 'series5-conflicting-address-without-correction', labelStatus: 'synthetic-unverified', expectedSameIncident: false,
    existing: initial,
    incoming: { ...initial, location: '124-11 Example Avenue', isOperationalUpdate: true, occurredAt: initial.occurredAt + 60_000 }
  }
];
