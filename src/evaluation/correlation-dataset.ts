import { readFile } from 'node:fs/promises';
import type { Agency, Borough } from '../domain/subscriptions.js';
import type { IncidentType } from '../domain/triage.js';
import type { IncidentIdentity } from '../services/incident-correlation.js';
import type { CorrelationEvaluationCase } from '../services/correlation-evaluator.js';

const agencies = new Set<Agency>(['FDNY', 'NYPD']);
const boroughs = new Set<Borough | 'Citywide'>(['Manhattan', 'Bronx', 'Queens', 'Brooklyn', 'Staten Island', 'Citywide']);
const incidentTypes = new Set<IncidentType>(['medical', 'vehicle', 'fire', 'police', 'other']);
const allowedCaseKeys = new Set(['id', 'labelStatus', 'expectedSameIncident', 'existing', 'incoming']);
const allowedIdentityKeys = new Set(['agency', 'borough', 'incidentType', 'eventDescription', 'location', 'latitude', 'longitude', 'unitIds', 'boxNumbers', 'occurredAt']);

export async function loadReviewedCorrelationDataset(path: string): Promise<CorrelationEvaluationCase[]> {
  const contents = await readFile(path, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > 5 * 1024 * 1024) throw new Error('Evaluation dataset exceeds the 5 MB limit.');
  const cases: CorrelationEvaluationCase[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on dataset line ${index + 1}.`); }
    cases.push(parseReviewedCase(parsed, index + 1));
  }
  if (!cases.length) throw new Error('Evaluation dataset contains no cases.');
  return cases;
}

function parseReviewedCase(value: unknown, line: number): CorrelationEvaluationCase {
  if (!isRecord(value) || hasUnknownKeys(value, allowedCaseKeys)) throw new Error(`Dataset line ${line} has an unsupported case shape.`);
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) throw new Error(`Dataset line ${line} needs a non-identifying case ID.`);
  if (value.labelStatus !== 'human-reviewed' && value.labelStatus !== 'adjudicated') {
    throw new Error(`Dataset line ${line} must be human-reviewed or adjudicated before evaluation.`);
  }
  if (typeof value.expectedSameIncident !== 'boolean') throw new Error(`Dataset line ${line} needs expectedSameIncident as a boolean.`);
  return {
    id: value.id,
    labelStatus: value.labelStatus,
    expectedSameIncident: value.expectedSameIncident,
    existing: parseIdentity(value.existing, line),
    incoming: parseIdentity(value.incoming, line)
  };
}

function parseIdentity(value: unknown, line: number): IncidentIdentity {
  if (!isRecord(value) || hasUnknownKeys(value, allowedIdentityKeys)) throw new Error(`Dataset line ${line} has an unsupported incident identity shape.`);
  if (!agencies.has(value.agency as Agency) || !boroughs.has(value.borough as Borough | 'Citywide')) throw new Error(`Dataset line ${line} has an invalid source agency or borough.`);
  if (!Array.isArray(value.unitIds) || value.unitIds.length > 12 || value.unitIds.some((item) => typeof item !== 'string' || item.length > 40)) throw new Error(`Dataset line ${line} has invalid unit IDs.`);
  if (value.boxNumbers !== undefined && (!Array.isArray(value.boxNumbers) || value.boxNumbers.length > 8 || value.boxNumbers.some((item) => typeof item !== 'string' || item.length > 24))) throw new Error(`Dataset line ${line} has invalid Box numbers.`);
  if (!Number.isFinite(value.occurredAt)) throw new Error(`Dataset line ${line} has an invalid event time.`);
  if (value.incidentType !== undefined && !incidentTypes.has(value.incidentType as IncidentType)) throw new Error(`Dataset line ${line} has an invalid incident type.`);
  for (const key of ['eventDescription', 'location'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 500)) throw new Error(`Dataset line ${line} has invalid ${key}.`);
  }
  for (const key of ['latitude', 'longitude'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error(`Dataset line ${line} has invalid ${key}.`);
  }
  return {
    agency: value.agency as Agency,
    borough: value.borough as Borough | 'Citywide',
    ...(value.incidentType ? { incidentType: value.incidentType as IncidentType } : {}),
    ...(typeof value.eventDescription === 'string' ? { eventDescription: value.eventDescription } : {}),
    ...(typeof value.location === 'string' ? { location: value.location } : {}),
    ...(typeof value.latitude === 'number' ? { latitude: value.latitude } : {}),
    ...(typeof value.longitude === 'number' ? { longitude: value.longitude } : {}),
    unitIds: value.unitIds as string[],
    ...(Array.isArray(value.boxNumbers) ? { boxNumbers: value.boxNumbers as string[] } : {}),
    occurredAt: value.occurredAt as number
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}
