import { createHash } from 'node:crypto';

export type PresenceAudience = 'buff' | 'news' | undefined;
export interface ActivePresenceCounts { total: number; buff: number; newsMedia: number; }

const presenceTtlMs = 75_000;
const maxPresenceSessions = 50_000;

/** In-memory browser presence only; no account IDs, IP addresses, or raw browser tokens are retained. */
export class ActivePresence {
  private readonly sessions = new Map<string, { lastSeenAt: number; audience: PresenceAudience }>();

  heartbeat(browserToken: string, audience?: PresenceAudience, now = Date.now()): ActivePresenceCounts {
    this.prune(now);
    const key = createHash('sha256').update(browserToken).digest('hex');
    this.sessions.delete(key);
    if (this.sessions.size >= maxPresenceSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(key, { lastSeenAt: now, audience });
    return this.getCounts(now);
  }

  getCounts(now = Date.now()): ActivePresenceCounts {
    this.prune(now);
    let buff = 0;
    let newsMedia = 0;
    for (const session of this.sessions.values()) {
      if (session.audience === 'buff') buff += 1;
      else if (session.audience === 'news') newsMedia += 1;
    }
    return { total: this.sessions.size, buff, newsMedia };
  }

  private prune(now: number): void {
    for (const [key, session] of this.sessions) {
      if (now - session.lastSeenAt > presenceTtlMs) this.sessions.delete(key);
    }
  }
}
