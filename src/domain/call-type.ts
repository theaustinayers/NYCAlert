import type { Agency } from './subscriptions.js';
import type { IncidentType } from './triage.js';

export const callTypes = ['fire', 'ems', 'pd'] as const;
export type CallType = (typeof callTypes)[number];

export const callTypeLabels: Record<CallType, string> = {
  fire: 'Fire',
  ems: 'EMS',
  pd: 'PD'
};

/** Map only a classified event type; use source agency to disambiguate vehicle calls. */
export function deriveCallType(agency: Agency, incidentType?: IncidentType): CallType | undefined {
  if (incidentType === 'fire') return 'fire';
  if (incidentType === 'medical') return 'ems';
  if (incidentType === 'police') return 'pd';
  if (incidentType === 'vehicle') return agency === 'FDNY' ? 'fire' : 'pd';
  return undefined;
}

export function isCallType(value: unknown): value is CallType {
  return typeof value === 'string' && callTypes.includes(value as CallType);
}
