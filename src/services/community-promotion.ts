import type { DashboardLiveCall } from './dashboard-store.js';

export const communityPromotionThreshold = { upvotes: 10, netVotes: 8, confidence: 0.78, publicScore: 3 } as const;

/** Popularity may surface a candidate, but cannot override routine classification or weak triage evidence. */
export function qualifiesForCommunityPromotion(
  call: DashboardLiveCall,
  votes: { up: number; down: number }
): boolean {
  return call.category !== 'routine'
    && call.confidence >= communityPromotionThreshold.confidence
    && call.newsworthinessScore >= communityPromotionThreshold.publicScore
    && votes.up >= communityPromotionThreshold.upvotes
    && votes.up - votes.down >= communityPromotionThreshold.netVotes;
}