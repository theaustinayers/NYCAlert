import type { Agency } from './subscriptions.js';

export const fdnyRadioGrammarVersion = 'fdny-literal-signals-v1';

export interface RadioEvidenceSpan {
  start: number;
  end: number;
}

export interface FdnyTransmissionSignal {
  name: 'box-reference' | '10-75' | '10-12' | '10-84' | '10-7' | 'under-control' | 'return-all-units';
  evidence: RadioEvidenceSpan;
}

export interface QueensAddressCandidate {
  normalized: string;
  sourceField: 'triage.location';
  verification: 'candidate-only';
  rule: 'space-separated-queens-house-number';
}

export interface FdnyBuildingMention {
  kind: 'floor' | 'building-height' | 'occupancy';
  value: string;
  evidence: RadioEvidenceSpan;
}

export interface FdnyTransmissionAnalysis {
  grammarVersion: typeof fdnyRadioGrammarVersion;
  signals: FdnyTransmissionSignal[];
  buildingMentions: FdnyBuildingMention[];
  queensAddressCandidates: QueensAddressCandidate[];
}

const signalRules: Array<{ name: FdnyTransmissionSignal['name']; pattern: RegExp }> = [
  { name: 'box-reference', pattern: /\bbox\s*(?:number|#)?\s*\d{3,5}\b/gi },
  { name: '10-75', pattern: /\b10\s*[- ]\s*75\b/gi },
  { name: '10-12', pattern: /\b10\s*[- ]\s*12\b/gi },
  { name: '10-84', pattern: /\b10\s*[- ]\s*84\b/gi },
  { name: '10-7', pattern: /\b10\s*[- ]\s*7\b/gi },
  { name: 'under-control', pattern: /\bunder\s+control\b/gi },
  { name: 'return-all-units', pattern: /\breturn\s+all\s+units\b/gi }
];

const buildingMentionRules: Array<{ kind: FdnyBuildingMention['kind']; pattern: RegExp }> = [
  {
    kind: 'floor',
    pattern: /\b(?:basement|cellar|roof|top\s+floor|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th)?)\s+floor)\b/gi
  },
  {
    kind: 'building-height',
    pattern: /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})[- ]?(?:story|stories|storey|storeys)\b/gi
  },
  {
    kind: 'occupancy',
    pattern: /\b(?:private\s+dwelling|multiple\s+dwelling|mixed[- ]occupancy|commercial\s+building|office\s+building|school|hospital|hotel|warehouse)\b/gi
  }
];

/**
 * Finds literal radio cues only. Results preserve offsets into the source transcript and
 * intentionally do not infer incident status, severity, verification, or alarm progression.
 */
export function analyzeFdnyTransmission(
  transcript: string,
  agency: Agency,
  boroughHint: string,
  triageLocation?: string
): FdnyTransmissionAnalysis {
  if (agency !== 'FDNY') {
    return { grammarVersion: fdnyRadioGrammarVersion, signals: [], buildingMentions: [], queensAddressCandidates: [] };
  }
  const signals: FdnyTransmissionSignal[] = [];
  for (const rule of signalRules) {
    for (const match of transcript.matchAll(rule.pattern)) {
      if (match.index === undefined) continue;
      signals.push({
        name: rule.name,
        evidence: { start: match.index, end: match.index + match[0].length }
      });
    }
  }
  signals.sort((left, right) => left.evidence.start - right.evidence.start);

  const buildingMentions: FdnyBuildingMention[] = [];
  for (const rule of buildingMentionRules) {
    for (const match of transcript.matchAll(rule.pattern)) {
      if (match.index === undefined) continue;
      buildingMentions.push({
        kind: rule.kind,
        value: match[0],
        evidence: { start: match.index, end: match.index + match[0].length }
      });
    }
  }
  buildingMentions.sort((left, right) => left.evidence.start - right.evidence.start);

  return {
    grammarVersion: fdnyRadioGrammarVersion,
    signals,
    buildingMentions,
    queensAddressCandidates: createQueensAddressCandidate(triageLocation, boroughHint)
  };
}

/**
 * Generate a review-only candidate for an explicit Queens address spoken as two leading
 * number groups. This does not validate, select, geocode, or replace the supplied location.
 */
export function createQueensAddressCandidate(
  location: string | undefined,
  boroughHint: string
): QueensAddressCandidate[] {
  if (!location || boroughHint !== 'Queens') return [];

  const mentionedBoroughs = [...location.matchAll(/\b(Manhattan|Bronx|Queens|Brooklyn|Staten\s+Island)\b/gi)]
    .map((match) => match[1]!.replace(/\s+/g, ' ').toLowerCase());
  if (mentionedBoroughs.some((borough) => borough !== 'queens')) return [];

  const match = /^\s*(\d{1,3})\s+(\d{2,3})\s+(.+?)\s*$/i.exec(location);
  if (!match) return [];
  const [, firstPart, secondPart, streetAndSuffix] = match;
  if (!/\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|place|pl|drive|dr|lane|ln|court|ct|way)\b/i.test(streetAndSuffix!)) return [];

  return [{
    normalized: `${firstPart}-${secondPart} ${streetAndSuffix!.trim()}`,
    sourceField: 'triage.location',
    verification: 'candidate-only',
    rule: 'space-separated-queens-house-number'
  }];
}
