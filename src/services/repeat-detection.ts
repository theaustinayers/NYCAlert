import type { Agency, Borough } from '../domain/subscriptions.js';

interface RecentText {
  agency: Agency;
  borough: Borough | 'Citywide';
  tokens: Set<string>;
  seenAt: number;
}

export interface RepeatDetectionCall {
  agency: Agency;
  borough: Borough | 'Citywide';
}

const ignoredTokens = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'been', 'being', 'by', 'for', 'from', 'has', 'have', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'there', 'this', 'to', 'was', 'were', 'with',
  'dispatch', 'dispatcher', 'responding', 'response', 'enroute', 'en', 'route', 'received', 'copy',
  'engine', 'ladder', 'truck', 'squad', 'unit', 'units', 'caller', 'calling', 'reports', 'reporting',
  'reported', 'near', 'long', 'island', 'incident', 'breaking', 'newsworthy', 'routine',
  'fdny', 'nypd', 'manhattan', 'bronx', 'queens', 'brooklyn', 'staten', 'citywide'
]);

function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1');
  return new Set(normalized.match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !ignoredTokens.has(token)) ?? []);
}

function substantiallyOverlaps(left: Set<string>, right: Set<string>): boolean {
  if (!left.size || !right.size) return false;
  const smallerSize = Math.min(left.size, right.size);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared >= 5 && shared / smallerSize >= 0.8;
}

/** Conservative in-memory suppression for near-identical radio transcripts and repeated alerts. */
export class RecentRepeatDetector {
  private readonly transcripts: RecentText[] = [];
  private readonly incidents: RecentText[] = [];

  constructor(private readonly windowMs = 10 * 60 * 1000, private readonly maxEntries = 500) {}

  isRepeatedTranscript(call: RepeatDetectionCall, transcript: string, now = Date.now()): boolean {
    return this.checkAndRemember(this.transcripts, call, transcript, now);
  }

  isRepeatedIncident(call: RepeatDetectionCall, description: string, now = Date.now()): boolean {
    return this.checkAndRemember(this.incidents, call, description, now);
  }

  rememberIncident(call: RepeatDetectionCall, description: string, now = Date.now()): void {
    this.prune(this.incidents, now);
    this.incidents.unshift({ ...call, tokens: tokenize(description), seenAt: now });
    this.incidents.length = Math.min(this.incidents.length, this.maxEntries);
  }

  private checkAndRemember(records: RecentText[], call: RepeatDetectionCall, text: string, now: number): boolean {
    this.prune(records, now);
    const tokens = tokenize(text);
    if (records.some((record) => record.agency === call.agency
      && record.borough === call.borough
      && substantiallyOverlaps(record.tokens, tokens))) return true;
    records.unshift({ ...call, tokens, seenAt: now });
    records.length = Math.min(records.length, this.maxEntries);
    return false;
  }

  private prune(records: RecentText[], now: number): void {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (now - records[index]!.seenAt > this.windowMs) records.splice(index, 1);
    }
  }
}
