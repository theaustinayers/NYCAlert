import type { Agency, Borough } from './subscriptions.js';

export const alertCategories = ['breaking', 'newsworthy', 'funny', 'weird_unique'] as const;
export type AlertCategory = (typeof alertCategories)[number];
export type IncidentType = 'medical' | 'vehicle' | 'fire' | 'police' | 'other';
export type IncidentVerification = 'unconfirmed' | 'reported' | 'responder-observed' | 'corroborated' | 'officially-confirmed';
export type IncidentReportSource = 'caller' | 'dispatch' | 'responding-unit' | 'multiple-sources' | 'official' | 'unknown';

export interface RadioUnitAssignment {
  unitId: string;
  /** Explicit temporary radio role, e.g. Engine 7 acting as Engine 39. */
  actingAsUnitId?: string;
}

export interface CallTriage {
  shouldAlert: boolean;
  category: AlertCategory | 'routine';
  /** AI-generated concise incident label; factual summary stays separate. */
  headline?: string;
  summary: string;
  /** Exact address or cross streets explicitly heard in the transcript, never inferred. */
  location?: string;
  incidentType?: IncidentType;
  /** Confidence that the transcript supports this triage and its extracted facts; not ASR quality or incident verification. */
  confidence: number;
  /** Public/editorial value; this remains the score used for Discord routing. */
  newsworthinessScore: number;
  /** Independent appeal to FDNY/NYPD buffs and incident photographers. */
  buffInterestScore?: number;
  /** Independent usefulness to a newsroom deciding whether to assign coverage. */
  assignmentDeskScore?: number;
  /** Verification of the incident fact, separate from transcript clarity. */
  verificationStatus?: IncidentVerification;
  reportSource?: IncidentReportSource;
}

export function normalizeIncidentHeadline(headline: string | undefined, category: CallTriage['category']): string {
  const fallback: Record<CallTriage['category'], string> = {
    breaking: 'Breaking Incident',
    newsworthy: 'Newsworthy Incident',
    funny: 'Unusual Radio Call',
    weird_unique: 'Unusual Incident',
    routine: 'Routine Update'
  };
  const cleaned = (headline ?? '').replace(/[\r\n|]+/g, ' ').replace(/^['"“”]+|['"“”]+$/g, '').trim();
  return cleaned ? cleaned.split(/\s+/).slice(0, 8).join(' ') : fallback[category];
}

/** Prefer precise, transcript-supported phrasing when a Box, EDP, and train-car fire are all explicit. */
export function curateIncidentHeadline(
  headline: string | undefined,
  transcript: string,
  agency?: Agency
): string | undefined {
  if (agency !== 'FDNY') return headline;
  const hasBox = /\b(?:box\s*(?:number|#)?\s*\d{3,5}|box\s+alarm|alarm\s+box)\b/i.test(transcript);
  const hasEdp = /\b(?:edp|emotionally\s+disturbed\s+person)\b/i.test(transcript);
  const hasTrain = /\b(?:train|subway)\s+car\b/i.test(transcript) || /\bcar\s+(?:on|in)\s+(?:the\s+)?(?:train|subway)\b/i.test(transcript);
  const hasFire = /\b(?:fire|fires|burning|setting\s+(?:a\s+)?fire)\b/i.test(transcript);
  if (hasBox && hasEdp && hasTrain && hasFire) return 'Box Alarm For EDP Train Car Fire';
  return headline;
}

export function isGenericIncidentHeadline(headline: string | undefined): boolean {
  const normalized = headline?.trim().toLowerCase().replace(/\s+/g, ' ');
  return !normalized || new Set([
    'routine', 'routine update', 'routine status update', 'routine unit status update', 'unit status update', 'status update', 'radio status update', 'routine incident',
    'newsworthy incident', 'breaking incident', 'unusual incident', 'unusual radio call',
    'radio transmission', 'dispatch update'
  ]).has(normalized);
}

/** Replace a generic routine headline only when the transcript literally supports a known status change. */
export function curateRoutineUpdateHeadline(
  headline: string | undefined,
  transcript: string,
  category: CallTriage['category']
): string | undefined {
  if (category !== 'routine' || !isGenericIncidentHeadline(headline)) return headline;
  const rules: Array<[RegExp, string]> = [
    [/\b(?:return(?:ing|ed)?\s+to\s+service|back\s+in\s+service)\b/i, 'Units Returning to Service'],
    [/\bunder control\b/i, 'Conditions Under Control'],
    [/\bno\s+(?:visible\s+)?fire\s+(?:found|condition)\b/i, 'No Fire Found'],
    [/\bno\s+(?:visible\s+)?smoke\s+(?:found|condition)\b/i, 'No Smoke Found'],
    [/\b(?:on scene|arrived on scene)\b/i, 'Unit On Scene'],
    [/\bpatient\s+transported\b/i, 'Patient Transported'],
    [/\b(?:assignment|all units?)\s+(?:is\s+)?cancel(?:led|ed)\b|\bdisregard (?:the|that) assignment\b/i, 'Assignment Cancelled']
  ];
  return rules.find(([pattern]) => pattern.test(transcript))?.[1] ?? 'Specific Update Unclear';
}

/** Replace only known generic model summaries with literal, cautious descriptions of explicit radio status. */
export function curateRoutineUpdateSummary(
  summary: string | undefined,
  transcript: string,
  category: CallTriage['category']
): string | undefined {
  if (category !== 'routine') return summary;
  const normalized = summary?.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  const genericSummaries = new Set([
    'routine', 'routine update', 'routine unit status', 'routine unit status update', 'unit status update',
    'status update', 'routine radio traffic', 'no reliable summary available'
  ]);
  if (!normalized || !genericSummaries.has(normalized)) return summary;
  const rules: Array<[RegExp, string]> = [
    [/\b(?:return(?:ing|ed)?\s+to\s+service|back\s+in\s+service)\b/i, 'Radio traffic reports a unit returning to service.'],
    [/\bunder control\b/i, 'Radio traffic reports conditions under control.'],
    [/\bno\s+(?:visible\s+)?fire\s+(?:found|condition)\b/i, 'Radio traffic reports no fire found.'],
    [/\bno\s+(?:visible\s+)?smoke\s+(?:found|condition)\b/i, 'Radio traffic reports no smoke found.'],
    [/\b(?:on scene|arrived on scene)\b/i, 'A unit reported arriving on scene.'],
    [/\bpatient\s+transported\b/i, 'Radio traffic reports a patient transported.'],
    [/\b(?:assignment|all units?)\s+(?:is\s+)?cancel(?:led|ed)\b|\bdisregard (?:the|that) assignment\b/i, 'Radio traffic reports the assignment cancelled or disregarded.']
  ];
  return rules.find(([pattern]) => pattern.test(transcript))?.[1]
    ?? 'Radio update received; the specific change is unclear.';
}

/** The adopted FDNY editorial rubric assigns third alarm or greater Public 5/5. */
export function explicitFdnyThirdAlarmOrHigher(transcript: string, agency?: Agency): boolean {
  if (agency !== 'FDNY') return false;
  const ordinals: Record<string, number> = {
    third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6,
    seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10
  };
  for (const match of transcript.toLowerCase().matchAll(/\b(third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th)\s+alarm\b/g)) {
    if ((ordinals[match[1]!] ?? 0) >= 3) return true;
  }
  return [...transcript.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+alarm\b/gi)]
    .some((match) => Number(match[1]) >= 3);
}

/** Airport context raises an explicit FDNY alarm above generic routine traffic, but does not imply danger. */
export function explicitFdnyAirportAlarm(transcript: string, agency?: Agency): boolean {
  if (agency !== 'FDNY') return false;
  const airportMentioned = /\b(?:airport|airfield|jfk|kennedy airport|laguardia|lga|newark airport|ewr)\b/i.test(transcript);
  const alarmMentioned = /\b(?:alarm|valve alarm|automatic alarm|fire alarm)\b/i.test(transcript);
  return airportMentioned && alarmMentioned;
}

export interface RadioCall {
  id: string;
  borough: Borough | 'Citywide';
  agency: Agency;
  occurredAt: Date;
  /** Broadcastify Calls API transcription when supplied by the approved response. */
  transcript?: string;
  groupName?: string;
  audioUrl?: string;
  audioPath?: string;
  audioContentType?: string;
  sourcePosition?: number;
}

export function shouldNotify(result: CallTriage, minTriageConfidence = 0.78, minNewsworthiness = 4): boolean {
  return result.shouldAlert
    && result.category !== 'routine'
    && result.confidence >= minTriageConfidence
    && result.newsworthinessScore >= minNewsworthiness;
}
