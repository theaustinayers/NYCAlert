import type { Agency, Borough } from '../domain/subscriptions.js';
import type { IncidentType } from '../domain/triage.js';
import type { RadioUnitAssignment } from '../domain/triage.js';
import type { MapCoordinates } from '../providers/map-geocoder.js';
import { normalizeMapLocation } from '../providers/map-geocoder.js';

export interface IncidentIdentity {
  agency: Agency;
  borough: Borough | 'Citywide';
  incidentType?: IncidentType;
  /** AI-curated headline/summary used only as corroborating similarity evidence. */
  eventDescription?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  unitIds: string[];
  boxNumbers?: string[];
  occurredAt: number;
}

const unitClasses: Record<string, string> = {
  engine: 'ENGINE', eng: 'ENGINE', e: 'ENGINE',
  ladder: 'LADDER', truck: 'TRUCK', t: 'TRUCK',
  rescue: 'RESCUE', r: 'RESCUE', squad: 'SQUAD', sq: 'SQUAD',
  battalion: 'BATTALION', bc: 'BATTALION', chief: 'CHIEF',
  marine: 'MARINE', hazmat: 'HAZMAT', tower: 'TOWER',
  car: 'NYPD CAR', rmp: 'NYPD RMP'
};

const nypdRadioAlphabets = new Set(['adam', 'charlie', 'david', 'edward', 'frank', 'george', 'henry', 'king', 'lincoln', 'mary', 'paul', 'robert', 'sam', 'thomas', 'victor', 'william', 'zebra']);

export function extractUnitIds(transcript: string): string[] {
  const units = new Set<string>();
  const patterns = [
    /\b(engine|eng|ladder|truck|rescue|squad|battalion|chief|marine|hazmat|tower)\s*[-#]?\s*(\d{1,3}[a-z]?)\b/gi,
    /\b(e|r|t|sq|bc)\s*[-#]?\s*(\d{1,3}[a-z]?)\b/gi,
    /\b(car|rmp)\s*[-#]?\s*(\d{1,5})\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of transcript.matchAll(pattern)) {
      const unitClass = unitClasses[match[1]!.toLowerCase()];
      if (unitClass) units.add(`${unitClass} ${match[2]!.toUpperCase()}`);
    }
  }
  for (const match of transcript.matchAll(/\b(\d{1,2})\s*-\s*([a-z]+)\s*-\s*(\d{1,3})\b/gi)) {
    const alphabet = match[2]!.toLowerCase();
    if (nypdRadioAlphabets.has(alphabet)) units.add(`NYPD ${match[1]}-${alphabet.toUpperCase()}-${match[3]}`);
  }
  for (const match of transcript.matchAll(/\b(adam|charlie|david|edward|frank|george|henry|king|lincoln|mary|paul|robert|sam|thomas|victor|william|zebra)\s+(\d{1,3})\b/gi)) {
    units.add(`NYPD ${match[1]!.toUpperCase()} ${match[2]}`);
  }
  return [...units].slice(0, 12);
}

/** Extract only explicitly spoken dispatch box numbers; never infer them from an address. */
export function extractBoxNumbers(transcript: string): string[] {
  return [...new Set([...transcript.matchAll(/\bbox\s*(?:number|#)?\s*(\d{3,5})\b/gi)].map((match) => `BOX ${match[1]}`))].slice(0, 4);
}

/** Extract explicit FDNY-style acting-as assignments; never infer a home company from a rig roster. */
export function extractActingAsAssignments(transcript: string): RadioUnitAssignment[] {
  const unitWord = '(engine|eng|ladder|truck|rescue|squad|battalion|chief|marine|hazmat|tower|e|r|t|sq|bc)';
  const pattern = new RegExp(`\\b${unitWord}\\s*[-#]?\\s*(\\d{1,3}[a-z]?)\\s+(?:is\\s+)?acting\\s+as\\s+${unitWord}\\s*[-#]?\\s*(\\d{1,3}[a-z]?)\\b`, 'gi');
  const classNames: Record<string, string> = {
    engine: 'ENGINE', eng: 'ENGINE', e: 'ENGINE', ladder: 'LADDER', truck: 'TRUCK', t: 'TRUCK',
    rescue: 'RESCUE', r: 'RESCUE', squad: 'SQUAD', sq: 'SQUAD', battalion: 'BATTALION', bc: 'BATTALION',
    chief: 'CHIEF', marine: 'MARINE', hazmat: 'HAZMAT', tower: 'TOWER'
  };
  const assignments: RadioUnitAssignment[] = [];
  for (const match of transcript.matchAll(pattern)) {
    const unitId = `${classNames[match[1]!.toLowerCase()]} ${match[2]!.toUpperCase()}`;
    const actingAsUnitId = `${classNames[match[3]!.toLowerCase()]} ${match[4]!.toUpperCase()}`;
    assignments.push({ unitId, actingAsUnitId });
  }
  return assignments;
}

function normalizedLocation(location: string): string[] {
  return normalizeMapLocation(location)
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(expressway|expy)\b/g, 'expy')
    .replace(/\b(near|at|the|intersection|of)\b/g, ' ')
    .match(/[a-z0-9]+/g) ?? [];
}

function sameLocation(left: IncidentIdentity, right: IncidentIdentity): boolean {
  if (coordinatesConflict(left, right, 500)) return false;
  if (left.location && right.location) {
    const leftTokens = new Set(normalizedLocation(left.location));
    const rightTokens = new Set(normalizedLocation(right.location));
    const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const denominator = Math.max(leftTokens.size, rightTokens.size);
    if (leftTokens.size > 0 && denominator > 0 && shared / denominator >= 0.8) return true;
  }
  return sameCoordinates(left, right);
}

function coordinatesConflict(left: IncidentIdentity, right: IncidentIdentity, minDistanceMeters: number): boolean {
  return typeof left.latitude === 'number' && typeof left.longitude === 'number'
    && typeof right.latitude === 'number' && typeof right.longitude === 'number'
    && distanceMeters(left.latitude, left.longitude, right.latitude, right.longitude) > minDistanceMeters;
}

function sameCoordinates(left: IncidentIdentity, right: IncidentIdentity): boolean {
  if (typeof left.latitude !== 'number' || typeof left.longitude !== 'number'
    || typeof right.latitude !== 'number' || typeof right.longitude !== 'number') return false;
  return distanceMeters(left.latitude, left.longitude, right.latitude, right.longitude) <= 150;
}

function sameExplicitAddress(left: IncidentIdentity, right: IncidentIdentity): boolean {
  if (!left.location || !right.location) return false;
  const leftTokens = new Set(normalizedLocation(left.location));
  const rightTokens = new Set(normalizedLocation(right.location));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  const sharedNumbers = shared.filter((token) => /^\d+$/.test(token));
  const sharedStreetTokens = shared.filter((token) => !/^\d+$/.test(token));
  const leftNumbers = [...leftTokens].filter((token) => /^\d+$/.test(token));
  const rightNumbers = [...rightTokens].filter((token) => /^\d+$/.test(token));

  // Across borough labels, only merge locations with a matching house number and street number.
  // This allows a later transcript to add cross streets without merging generic street-only calls.
  return leftNumbers.length >= 2 && rightNumbers.length >= 2
    && sharedNumbers.length >= 2 && sharedStreetTokens.length >= 2;
}

function explicitStreetAddress(location?: string): { houseNumber: string; street: string } | undefined {
  if (!location) return undefined;
  const normalized = location
    .replace(/\bbetween\b[\s\S]*$/i, '')
    .replace(/,?\s*(?:Manhattan|Bronx|Queens|Brooklyn|Staten\s+Island)\s*$/i, '')
    .trim();
  const match = /^(\d+(?:-\d+)?)\s+(.+)$/i.exec(normalized);
  if (!match) return undefined;
  const street = (match[2] ?? '').toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(place|pl)\b/g, 'pl')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const streetTokens = street.split(/\s+/).filter(Boolean);
  if (streetTokens.length < 2 || !streetTokens.some((token) => /^(st|ave|blvd|rd|ln|pl|dr|ct|way)$/.test(token))) return undefined;
  return { houseNumber: (match[1] ?? '').toLowerCase(), street };
}

function explicitAddressesConflict(left?: string, right?: string): boolean {
  const first = explicitStreetAddress(left);
  const second = explicitStreetAddress(right);
  if (!first || !second) return false;
  return first.houseNumber !== second.houseNumber || first.street !== second.street;
}

function sameExplicitStreetAddress(left?: string, right?: string): boolean {
  const first = explicitStreetAddress(left);
  const second = explicitStreetAddress(right);
  return Boolean(first && second && first.houseNumber === second.houseNumber && first.street === second.street);
}

const crossAgencyEventTerms = new Set([
  'fire', 'shooting', 'shots', 'robbery', 'assault', 'crash', 'collision', 'vehicle',
  'rescue', 'explosion', 'gas', 'collapse', 'stabbing', 'pedestrian', 'hazmat'
]);

function sharesSpecificCrossAgencyEvent(left?: string, right?: string): boolean {
  const terms = (value?: string) => new Set((value?.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((term) => crossAgencyEventTerms.has(term) || (term.length > 2 && !ignoredIncidentWords.has(term))));
  const leftTerms = terms(left);
  const rightTerms = terms(right);
  return [...leftTerms].some((term) => crossAgencyEventTerms.has(term) && rightTerms.has(term));
}

function sameCrossAgencyIncident(existing: IncidentIdentity, incoming: IncidentIdentity, age: number): boolean {
  if (existing.borough !== incoming.borough || age > 5 * 60 * 1000
    || !compatibleType(existing.incidentType, incoming.incidentType)
    || explicitAddressesConflict(existing.location, incoming.location)) return false;
  if (coordinatesConflict(existing, incoming, 150)) return false;
  const exactAddress = sameExplicitStreetAddress(existing.location, incoming.location);
  const exactCoordinates = sameCoordinates(existing, incoming);
  return (exactAddress || exactCoordinates)
    && sharesSpecificCrossAgencyEvent(existing.eventDescription, incoming.eventDescription);
}

function normalizedCrossStreet(value: string): string {
  return normalizeMapLocation(value)
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + Number(i < left.length || j < right.length) <= 1;
}

function sameCrossStreetBlock(left: IncidentIdentity, right: IncidentIdentity): boolean {
  if (!left.location || !right.location) return false;
  const leftBlock = parseBetweenBlock(left.location);
  const rightBlock = parseBetweenBlock(right.location);
  if (!leftBlock || !rightBlock) return false;
  if (coordinatesConflict(left, right, 350)) return false;
  const leftCrosses = [leftBlock.firstCrossStreet, leftBlock.secondCrossStreet].map(normalizedCrossStreet);
  const rightCrosses = [rightBlock.firstCrossStreet, rightBlock.secondCrossStreet].map(normalizedCrossStreet);
  const direct = editDistanceAtMostOne(leftCrosses[0]!, rightCrosses[0]!) && editDistanceAtMostOne(leftCrosses[1]!, rightCrosses[1]!);
  const reversed = editDistanceAtMostOne(leftCrosses[0]!, rightCrosses[1]!) && editDistanceAtMostOne(leftCrosses[1]!, rightCrosses[0]!);
  if (!direct && !reversed) return false;
  const exactMatches = leftCrosses.filter((cross) => rightCrosses.includes(cross)).length;
  return exactMatches >= 1;
}

function parseBetweenBlock(location: string): { firstCrossStreet: string; secondCrossStreet: string } | undefined {
  const match = location.match(/\bbetween\s+(.+?)\s+and\s+(.+?)\s*$/i);
  if (!match) return undefined;
  const firstCrossStreet = match[1]!.replace(/[.,;]+$/g, '').trim();
  const secondCrossStreet = match[2]!.replace(/[.,;]+$/g, '').trim();
  if (!firstCrossStreet || !secondCrossStreet) return undefined;
  return { firstCrossStreet, secondCrossStreet };
}

const ignoredIncidentWords = new Set([
  'reported', 'report', 'incident', 'fire', 'alarm', 'fdny', 'nypd', 'responding', 'response',
  'street', 'avenue', 'road', 'boulevard', 'west', 'east', 'north', 'south', 'between', 'apartment',
  'building', 'units', 'unit', 'location', 'unknown', 'possible', 'working', 'condition', 'conditions'
]);
const distinctiveEventWords = new Set([
  'edp', 'train', 'subway', 'arson', 'explosion', 'explosive', 'shooting', 'shot', 'stabbing',
  'entrapment', 'trapped', 'collapse', 'derailment', 'hostage', 'barricade', 'pursuit', 'mayday'
]);

function eventTokens(value?: string): Set<string> {
  return new Set((value?.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2 && !ignoredIncidentWords.has(token)));
}

function similarEventDetails(left?: string, right?: string): boolean {
  const leftTokens = eventTokens(left);
  const rightTokens = eventTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token));
  const shared = sharedTokens.length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return shared >= 3 && shared / smaller >= 0.4
    && sharedTokens.some((token) => distinctiveEventWords.has(token));
}

function hasSharedUnit(left: string[], right: string[]): boolean {
  return left.some((unit) => right.includes(unit));
}

function compatibleType(left?: IncidentType, right?: IncidentType): boolean {
  return Boolean(left && right && left !== 'other' && right !== 'other' && left === right);
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLon = (lon2 - lon1) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Require same responder/area, incident class and a corroborating location or unit signal. */
export function isSameIncident(existing: IncidentIdentity, incoming: IncidentIdentity, maxAgeMs = 30 * 60 * 1000): boolean {
  const age = incoming.occurredAt - existing.occurredAt;
  if (age < 0 || age > maxAgeMs) return false;
  if (existing.agency !== incoming.agency) return sameCrossAgencyIncident(existing, incoming, age);
  if (explicitAddressesConflict(existing.location, incoming.location)) return false;
  const sameBorough = existing.borough === incoming.borough;
  const unitMatch = hasSharedUnit(existing.unitIds, incoming.unitIds);
  const sharedBox = Boolean(existing.boxNumbers?.some((box) => incoming.boxNumbers?.includes(box)));
  const locationMatch = sameLocation(existing, incoming);
  const coordsConflict = coordinatesConflict(existing, incoming, 500);
  const crossBoroughLocationMatch = !coordsConflict && (sameCoordinates(existing, incoming) || sameExplicitAddress(existing, incoming));
  if (!coordsConflict && sharedBox && age <= 10 * 60 * 1000 && compatibleType(existing.incidentType, incoming.incidentType)) return true;
  if ((sameBorough ? locationMatch : crossBoroughLocationMatch)
    && compatibleType(existing.incidentType, incoming.incidentType)) return true;
  const spatiallyNearby = sameCoordinatesWithin(existing, incoming, 350);
  const closeIncidentUpdate = age <= 12 * 60 * 1000
    && spatiallyNearby
    && compatibleType(existing.incidentType, incoming.incidentType)
    && (unitMatch || sharedBox || similarEventDetails(existing.eventDescription, incoming.eventDescription));
  if (closeIncidentUpdate) return true;
  // Transcript wording can be the only usable location clue when one side says only a borough
  // (e.g. "Brooklyn") and another names a station. Require a very distinctive shared event phrase,
  // same borough/agency/type and a narrow time window; precise, conflicting coordinates veto it.
  const distinctiveEventMatch = sameBorough && age <= 3 * 60 * 1000 && !coordsConflict
    && compatibleType(existing.incidentType, incoming.incidentType)
    && similarEventDetails(existing.eventDescription, incoming.eventDescription);
  if (distinctiveEventMatch) return true;
  if (sameBorough && age <= 15 * 60 * 1000 && compatibleType(existing.incidentType, incoming.incidentType)
    && !coordsConflict && sameCrossStreetBlock(existing, incoming)) return true;
  if (!sameBorough) return false;
  // A unit-only continuation is deliberately restricted to five minutes; unknown follow-up type is allowed.
  return unitMatch && age <= 5 * 60 * 1000
    && (compatibleType(existing.incidentType, incoming.incidentType) || incoming.incidentType === 'other');
}

function sameCoordinatesWithin(left: IncidentIdentity, right: IncidentIdentity, maxDistanceMeters: number): boolean {
  if (typeof left.latitude !== 'number' || typeof left.longitude !== 'number'
    || typeof right.latitude !== 'number' || typeof right.longitude !== 'number') return false;
  return distanceMeters(left.latitude, left.longitude, right.latitude, right.longitude) <= maxDistanceMeters;
}
