import type { Agency, Borough } from '../domain/subscriptions.js';
import type { BroadcastifyFeedMapping } from './broadcastify.js';

export const fdnyPlaylistMappings: readonly BroadcastifyFeedMapping[] = [
  { playlistUuid: '83064fd5-010e-11f1-bb32-0ef97433b5f9', borough: 'Manhattan', agency: 'FDNY' },
  { playlistUuid: 'acfe9884-010e-11f1-bb32-0ef97433b5f9', borough: 'Bronx', agency: 'FDNY' },
  { playlistUuid: '9344f685-010f-11f1-bb32-0ef97433b5f9', borough: 'Queens', agency: 'FDNY' },
  { playlistUuid: '72a9370f-010f-11f1-bb32-0ef97433b5f9', borough: 'Brooklyn', agency: 'FDNY' },
  { playlistUuid: 'b4b71363-010f-11f1-bb32-0ef97433b5f9', borough: 'Staten Island', agency: 'FDNY' }
] as const;

export const fdnyCitywideCallPageReferences = [
  { label: 'FDNY Citywide 1', fid: '223673', url: 'https://www.broadcastify.com/calls/fid/223673' },
  { label: 'FDNY Citywide 2', fid: '369748', url: 'https://www.broadcastify.com/calls/fid/369748' }
] as const;

export const nypdCitywideLiveReference = {
  label: 'NYPD Citywide 1/2/3',
  feedId: '47753',
  url: 'https://www.broadcastify.com/listen/feed/47753'
} as const;

export const dashboardFeedLinks = [
  ...fdnyPlaylistMappings.map((feed) => ({
    id: `fdny-${feed.borough.toLowerCase().replaceAll(' ', '-')}`,
    name: `FDNY ${feed.borough} Dispatch`,
    agency: 'FDNY' as const,
    borough: feed.borough,
    url: `https://www.broadcastify.com/calls/playlists/?uuid=${feed.playlistUuid}`
  })),
  ...fdnyCitywideCallPageReferences.map((feed) => ({
    id: `fdny-citywide-${feed.fid}`,
    name: feed.label,
    agency: 'FDNY' as const,
    borough: 'Citywide' as const,
    url: feed.url
  })),
  {
    id: 'nypd-citywide-1-2-3',
    name: nypdCitywideLiveReference.label,
    agency: 'NYPD' as const,
    borough: 'Citywide' as const,
    url: nypdCitywideLiveReference.url
  }
] as const;

export interface FeedSubscriptionTarget {
  borough: Borough;
  agency: Agency;
}
