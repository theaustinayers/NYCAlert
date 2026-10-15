import type { IncidentIdentity } from '../services/incident-correlation.js';

/** Synthetic regression cases inspired by Series 4 patterns; they are not verified incident labels. */
export interface CorrelationRegressionCase {
  id: string;
  source: 'series-4-audit-pattern';
  labelStatus: 'synthetic-unverified';
  rationale: string;
  expectedSameIncident: boolean;
  existing: IncidentIdentity;
  incoming: IncidentIdentity;
}

const time = Date.parse('2026-10-15T02:00:00.000Z');

export const series4CorrelationCases: CorrelationRegressionCase[] = [
  {
    id: 'series4-cross-feed-same-bronx-address',
    source: 'series-4-audit-pattern',
    labelStatus: 'synthetic-unverified',
    rationale: 'A same-address fire report arrives under a different borough feed label; the feed label alone must not split the incident.',
    expectedSameIncident: true,
    existing: {
      agency: 'FDNY', borough: 'Bronx', incidentType: 'fire', location: '999 Example Road',
      eventDescription: 'Heavy fire reported at commercial building; second alarm', boxNumbers: ['BOX 2001'],
      unitIds: [], occurredAt: time
    },
    incoming: {
      agency: 'FDNY', borough: 'Queens', incidentType: 'fire', location: '999 Example Rd',
      eventDescription: 'Second alarm transmitted, defensive operation', boxNumbers: ['BOX 2002'],
      unitIds: [], occurredAt: time + 13 * 60_000
    }
  },
  {
    id: 'series4-fire-under-control-same-address',
    source: 'series-4-audit-pattern',
    labelStatus: 'synthetic-unverified',
    rationale: 'A status-only under-control transmission at the established exact address should update the active incident, not create a second incident.',
    expectedSameIncident: true,
    existing: {
      agency: 'FDNY', borough: 'Bronx', incidentType: 'fire', location: '999 Example Road',
      eventDescription: 'Heavy fire reported at commercial building; second alarm', boxNumbers: ['BOX 2001'],
      unitIds: [], occurredAt: time
    },
    incoming: {
      agency: 'FDNY', borough: 'Manhattan', incidentType: 'other', location: '999 Example Road, Bronx',
      eventDescription: 'Fire under control', boxNumbers: [], unitIds: [], occurredAt: time + 16 * 60_000
    }
  },
  {
    id: 'series4-different-house-number-not-same-fire',
    source: 'series-4-audit-pattern',
    labelStatus: 'synthetic-unverified',
    rationale: 'Same street and event category are insufficient when the explicit house number differs.',
    expectedSameIncident: false,
    existing: {
      agency: 'FDNY', borough: 'Bronx', incidentType: 'fire', location: '999 Example Road',
      eventDescription: 'Commercial building fire', boxNumbers: ['BOX 2001'], unitIds: [], occurredAt: time
    },
    incoming: {
      agency: 'FDNY', borough: 'Queens', incidentType: 'fire', location: '1001 Example Road',
      eventDescription: 'Commercial building fire', boxNumbers: ['BOX 2001'], unitIds: [], occurredAt: time + 60_000
    }
  },
  {
    id: 'series4-conflicting-concrete-types-not-same-incident',
    source: 'series-4-audit-pattern',
    labelStatus: 'synthetic-unverified',
    rationale: 'An exact address must not override contradictory concrete incident types.',
    expectedSameIncident: false,
    existing: {
      agency: 'FDNY', borough: 'Bronx', incidentType: 'fire', location: '999 Example Road',
      eventDescription: 'Building fire', boxNumbers: [], unitIds: [], occurredAt: time
    },
    incoming: {
      agency: 'FDNY', borough: 'Queens', incidentType: 'vehicle', location: '999 Example Road',
      eventDescription: 'Vehicle collision', boxNumbers: [], unitIds: [], occurredAt: time + 60_000
    }
  }
];
