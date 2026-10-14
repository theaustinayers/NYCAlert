export const locationPrecisions = [
  'rooftop',
  'street_address',
  'intersection',
  'road_segment',
  'box_area',
  'neighborhood',
  'borough',
  'place',
  'unresolved'
] as const;

export type LocationPrecision = (typeof locationPrecisions)[number];

/** Only verified address/intersection/road-segment points are eligible for a map marker. */
export function canShowMapMarker(precision: LocationPrecision | undefined): boolean {
  return precision === 'rooftop' || precision === 'street_address'
    || precision === 'intersection' || precision === 'road_segment';
}
