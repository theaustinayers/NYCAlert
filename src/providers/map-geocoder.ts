import type { LocationPrecision } from '../domain/location.js';

export interface MapCoordinates {
  latitude: number;
  longitude: number;
  precision: LocationPrecision;
}

export function normalizeMapLocation(location: string): string {
  return normalizeLocationTokens(location)
    .replace(/\b(\d+)(?:st|nd|rd|th)?\s+(street|st|avenue|ave|road|rd|boulevard|blvd)\b/gi, (_match, number: string, suffix: string) => `${number}${ordinalSuffix(Number(number))} ${suffix}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocationTokens(location: string): string {
  return location
    .replace(/\bL\.?I\.?E\.?\b/gi, 'Long Island Expressway')
    .replace(/\bBQE\b/gi, 'Brooklyn Queens Expressway')
    .replace(/\bFDR\b/gi, 'FDR Drive')
    .replace(/\bnumber\s+four\s+(street|st)\b/gi, '4th $1')
    .replace(/\btwo\s+six\s+and\s+two\s+seven\s+avenues\b/gi, '26th Avenue and 27th Avenue')
    .replace(/\btwo\s+six\s+(avenue|ave)\b/gi, '26th $1')
    .replace(/\btwo\s+seven\s+(avenue|ave)\b/gi, '27th $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rate-limited Nominatim geocoder for incident pins. Cache both matches and misses. */
export class NominatimIncidentGeocoder {
  private readonly cache = new Map<string, Promise<MapCoordinates | undefined>>();
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    private readonly contactEmail?: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  geocode(location: string, borough: string): Promise<MapCoordinates | undefined> {
    const normalized = normalizeMapLocation(location);
    if (!normalized || isBoroughOnlyLocation(normalized, borough)) return Promise.resolve(undefined);
    const key = `${normalized.toLowerCase()}|${borough.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = this.queue.then(() => this.request(normalized, borough));
    this.queue = result.then(() => undefined, () => undefined);
    this.cache.set(key, result);
    return result;
  }

  private async request(location: string, borough: string): Promise<MapCoordinates | undefined> {
    const directLocation = stripTrailingBorough(location.replace(/\s+\bbetween\b\s+.+$/i, '').replace(/[,;\s]+$/g, '').trim());
    const direct = await this.search(`${directLocation}, ${borough}, New York City, NY`, 5);
    const block = parseBetweenBlock(location);
    const directMatches = direct.map((result) => verifiedDirectCoordinates(result, directLocation, borough)).filter(isCoordinates);
    if (!block) return directMatches[0];

    const firstIntersectionResults = await this.search(
      `${block.street} and ${block.firstCrossStreet}, ${borough}, New York City, NY`, 5
    );
    const secondIntersectionResults = await this.search(
      `${block.street} and ${block.secondCrossStreet}, ${borough}, New York City, NY`, 5
    );
    const firstIntersection = firstIntersectionResults.map((result) => coordinatesInBorough(result, borough, 'road_segment')).find(isCoordinates);
    const secondIntersection = secondIntersectionResults.map((result) => coordinatesInBorough(result, borough, 'road_segment')).find(isCoordinates);
    if (firstIntersection && secondIntersection) {
      const consistentDirectMatches = directMatches.filter((candidate) =>
        liesAlongCrossStreetSegment(candidate, firstIntersection, secondIntersection)
      );
      if (consistentDirectMatches.length === 1) {
        const match = consistentDirectMatches[0]!;
        return match.precision === 'street_address' ? match : { ...match, precision: 'road_segment' };
      }
      if (consistentDirectMatches.length > 1) return undefined;
    } else if (directMatches.length > 0) {
      return directMatches.length === 1 ? directMatches[0] : undefined;
    }

    if (firstIntersection && secondIntersection && distanceMeters(firstIntersection, secondIntersection) <= 500) {
      return {
        latitude: (firstIntersection.latitude + secondIntersection.latitude) / 2,
        longitude: (firstIntersection.longitude + secondIntersection.longitude) / 2,
        precision: 'road_segment'
      };
    }

    const streetResults = await this.search(`${block.street}, ${borough}, New York City, NY`, 50);
    const firstCrossStreetResults = await this.search(`${block.firstCrossStreet}, ${borough}, New York City, NY`, 50);
    const secondCrossStreetResults = await this.search(`${block.secondCrossStreet}, ${borough}, New York City, NY`, 50);
    const firstCrossStreets = firstCrossStreetResults.map((result) => coordinatesInBorough(result, borough)).filter(isCoordinates);
    const secondCrossStreets = secondCrossStreetResults.map((result) => coordinatesInBorough(result, borough)).filter(isCoordinates);
    const matchingRoads = streetResults.filter((result) => resultInBorough(result, borough)).map((result) => coordinatesFrom(result, 'road_segment')).filter(isCoordinates).filter((street) =>
      firstCrossStreets.some((first) => distanceMeters(street, first) <= 250)
      && secondCrossStreets.some((second) => distanceMeters(street, second) <= 250)
    );
    return matchingRoads.length === 1 ? matchingRoads[0] : undefined;
  }

  private async search(query: string, limit: number): Promise<GeocoderResult[]> {
    const waitMs = Math.max(0, 1_100 - (Date.now() - this.lastRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastRequestAt = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('viewbox', '-74.30,40.95,-73.65,40.45');
    url.searchParams.set('bounded', '1');
    if (this.contactEmail) url.searchParams.set('email', this.contactEmail);

    const response = await this.fetcher(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'NYCAlert/1.0 (incident map geocoding)' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`Incident map geocoding failed with HTTP ${response.status}`);
    return await response.json() as GeocoderResult[];
  }
}

/** Reject a direct-address pin when it conflicts with an explicitly stated between-block. */
function liesAlongCrossStreetSegment(
  candidate: MapCoordinates,
  first: MapCoordinates,
  second: MapCoordinates,
  toleranceMeters = 250
): boolean {
  const meanLatitude = (first.latitude + second.latitude + candidate.latitude) / 3;
  const metersPerDegreeLongitude = 111_320 * Math.cos(meanLatitude * Math.PI / 180);
  const origin = { x: first.longitude * metersPerDegreeLongitude, y: first.latitude * 111_320 };
  const end = { x: second.longitude * metersPerDegreeLongitude, y: second.latitude * 111_320 };
  const point = { x: candidate.longitude * metersPerDegreeLongitude, y: candidate.latitude * 111_320 };
  const dx = end.x - origin.x;
  const dy = end.y - origin.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distanceMeters(candidate, first) <= toleranceMeters;
  const projection = ((point.x - origin.x) * dx + (point.y - origin.y) * dy) / lengthSquared;
  if (projection < 0 || projection > 1) return false;
  const closest = { x: origin.x + projection * dx, y: origin.y + projection * dy };
  return Math.hypot(point.x - closest.x, point.y - closest.y) <= toleranceMeters;
}

function stripTrailingBorough(location: string): string {
  return location.replace(/,?\s+(?:in\s+)?(?:Manhattan|Bronx|Queens|Brooklyn|Staten\s+Island)\s*$/i, '').trim();
}

interface GeocoderResult {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  type?: string;
  addresstype?: string;
  address?: {
    house_number?: string;
    road?: string;
    suburb?: string;
    borough?: string;
    city_district?: string;
    county?: string;
    city?: string;
  };
}

function coordinatesFrom(result?: GeocoderResult, precision: LocationPrecision = 'place'): MapCoordinates | undefined {
  const latitude = Number(result?.lat);
  const longitude = Number(result?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 40.45 || latitude > 40.95 || longitude < -74.30 || longitude > -73.65) return undefined;
  return { latitude, longitude, precision };
}

function isCoordinates(value: MapCoordinates | undefined): value is MapCoordinates {
  return value !== undefined;
}

function coordinatesInBorough(result: GeocoderResult, borough: string, precision: LocationPrecision = 'place'): MapCoordinates | undefined {
  return resultInBorough(result, borough) ? coordinatesFrom(result, precision) : undefined;
}

function resultInBorough(result: GeocoderResult, borough: string): boolean {
  if (borough === 'Citywide') return true;
  const address = result.address;
  const locationText = [address?.suburb, address?.borough, address?.city_district, address?.county, result.display_name]
    .filter(Boolean).join(' ').toLowerCase();
  switch (borough.toLowerCase()) {
    case 'manhattan': return locationText.includes('manhattan') || locationText.includes('new york county');
    case 'bronx': return locationText.includes('bronx');
    case 'queens': return locationText.includes('queens');
    case 'brooklyn': return locationText.includes('brooklyn') || locationText.includes('kings county');
    case 'staten island': return locationText.includes('staten island') || locationText.includes('richmond county');
    default: return false;
  }
}

function verifiedDirectCoordinates(result: GeocoderResult, query: string, borough: string): MapCoordinates | undefined {
  if (!resultInBorough(result, borough)) return undefined;
  const coordinates = coordinatesFrom(result);
  if (!coordinates) return undefined;
  const houseMatch = query.match(/^(\d+(?:-\d+)?)/);
  if (houseMatch) {
    const expected = normalizeAddressTokens(query.slice(houseMatch[0].length).trim());
    const road = normalizeAddressTokens(result.address?.road ?? result.name ?? '');
    if (!expected.length || !road.length) return undefined;
    const overlap = expected.filter((token) => road.includes(token)).length;
    if (overlap / Math.max(expected.length, road.length) < 0.72) return undefined;
    const expectedHouse = normalizeHouseNumber(houseMatch[1]!);
    const returnedHouse = normalizeHouseNumber(result.address?.house_number ?? '');
    if (!returnedHouse || expectedHouse !== returnedHouse) return undefined;
  } else {
    const expected = normalizeAddressTokens(query.replace(/\b(at|near|the|and|intersection|between)\b/gi, ' '));
    const road = normalizeAddressTokens(result.address?.road || result.name || '');
    if (!expected.length || !road.length) return undefined;
    const overlap = expected.filter((token) => road.includes(token)).length;
    if (overlap / Math.max(expected.length, road.length) < 0.72) return undefined;
  }
  const isIntersection = result.addresstype === 'intersection' || result.type === 'intersection';
  return { ...coordinates, precision: houseMatch ? 'street_address' : isIntersection ? 'intersection' : 'place' };
}

function isBoroughOnlyLocation(location: string, borough: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const normalizedLocation = normalize(location);
  const normalizedBorough = normalize(borough);
  return normalizedLocation === normalizedBorough
    || ['citywide', 'city wide', 'nyc', 'new york city'].includes(normalizedLocation);
}

function normalizeAddressTokens(value: string): string[] {
  return normalizeLocationTokens(value)
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .match(/[a-z0-9]+/g) ?? [];
}

function normalizeHouseNumber(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[–—]/g, '-');
}

function ordinalSuffix(number: number): string {
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (number % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function parseBetweenBlock(location: string): { street: string; firstCrossStreet: string; secondCrossStreet: string } | undefined {
  const normalized = normalizeMapLocation(location);
  const match = normalized.match(/\bbetween\s+(.+?)\s+and\s+(.+?)\s*$/i);
  if (!match) return undefined;
  const streetMatches = [...normalized.slice(0, match.index).matchAll(/\b(?:\d+(?:st|nd|rd|th)?|[a-z]+)\s+(?:street|st|avenue|ave|boulevard|blvd|road|rd)\b/gi)];
  const street = streetMatches.at(-1)?.[0];
  const cleanCrossStreet = (value: string): string => value.replace(/[.,;]+$/g, '').trim();
  const firstCrossStreet = cleanCrossStreet(match[1]!);
  const secondCrossStreet = cleanCrossStreet(match[2]!);
  if (!street || !/(?:street|st|avenues?|aves?|boulevard|blvd|road|rd)$/i.test(firstCrossStreet)
    || !/(?:street|st|avenues?|aves?|boulevard|blvd|road|rd)$/i.test(secondCrossStreet)) return undefined;
  return { street, firstCrossStreet, secondCrossStreet };
}

function distanceMeters(left: MapCoordinates, right: MapCoordinates): number {
  const radians = Math.PI / 180;
  const dLat = (right.latitude - left.latitude) * radians;
  const dLon = (right.longitude - left.longitude) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
