import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeMapLocation, NominatimIncidentGeocoder } from './map-geocoder.js';

describe('normalizeMapLocation', () => {
  it('expands common New York radio highway shorthand before lookup', () => {
    assert.equal(normalizeMapLocation('LIE at Queens Boulevard'), 'Long Island Expressway at Queens Boulevard');
    assert.equal(normalizeMapLocation('BQE near the FDR'), 'Brooklyn Queens Expressway near the FDR Drive');
    assert.equal(normalizeMapLocation('number four Street, between Two Six and Two Seven Avenues'), '4th Street, between 26th Avenue and 27th Avenue');
  });
});

describe('NominatimIncidentGeocoder', () => {
  it('geocodes within NYC bounds and caches repeated location requests', async () => {
    let requests = 0;
    let requestedUrl: URL | undefined;
    const geocoder = new NominatimIncidentGeocoder('ops@example.invalid', async (input) => {
      requests += 1;
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify([{
        lat: '40.72', lon: '-73.95',
        address: { road: 'Long Island Expressway at Queens Boulevard', suburb: 'Queens' }
      }]), { status: 200 });
    });

    const first = await geocoder.geocode('LIE at Queens Boulevard', 'Queens');
    const second = await geocoder.geocode('LIE at Queens Boulevard', 'Queens');

    assert.deepEqual(first, { latitude: 40.72, longitude: -73.95 });
    assert.deepEqual(second, first);
    assert.equal(requests, 1);
    assert.equal(requestedUrl?.searchParams.get('q'), 'Long Island Expressway at Queens Boulevard, Queens, New York City, NY');
    assert.equal(requestedUrl?.searchParams.get('email'), 'ops@example.invalid');
    assert.equal(requestedUrl?.searchParams.get('addressdetails'), '1');
  });

  it('does not return a point outside New York City bounds', async () => {
    const geocoder = new NominatimIncidentGeocoder(undefined, async () => new Response(JSON.stringify([{ lat: '41.2', lon: '-73.9' }])));
    assert.equal(await geocoder.geocode('123 Main Street', 'Queens'), undefined);
  });

  it('geocodes an exact house address separately from bad cross-street text and confirms its borough', async () => {
    const queries: string[] = [];
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      queries.push(query);
      if (query.startsWith('54 West 103rd Street')) return new Response(JSON.stringify([{
        lat: '40.7964623', lon: '-73.9624967',
        address: { house_number: '54', road: 'West 103rd Street', suburb: 'Manhattan' }
      }]));
      return new Response('[]');
    });

    const coordinates = await geocoder.geocode('54 West 103 Street between Fifth Avenue and Sixth Avenue', 'Manhattan');

    assert.deepEqual(coordinates, { latitude: 40.7964623, longitude: -73.9624967 });
    assert.equal(queries[0], '54 West 103rd Street, Manhattan, New York City, NY');
  });

  it('rejects a direct address pin that contradicts the explicitly stated cross-street segment', async () => {
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      if (query.startsWith('396 10 Avenue,')) return new Response(JSON.stringify([{
        lat: '40.75', lon: '-73.99',
        address: { house_number: '396', road: '10 Avenue', suburb: 'Manhattan' }
      }]));
      if (query.startsWith('10 Avenue and West 207th Street')) return new Response(JSON.stringify([{
        lat: '40.863', lon: '-73.929', address: { road: '10 Avenue', suburb: 'Manhattan' }
      }]));
      if (query.startsWith('10 Avenue and West 215th Street')) return new Response(JSON.stringify([{
        lat: '40.869', lon: '-73.926', address: { road: '10 Avenue', suburb: 'Manhattan' }
      }]));
      return new Response('[]');
    });

    const coordinates = await geocoder.geocode(
      '396 10 Avenue between West 207th Street and West 215th Street',
      'Manhattan'
    );

    assert.equal(coordinates, undefined);
  });

  it('keeps a verified direct address when it lies on the explicit cross-street segment', async () => {
    const direct = { latitude: 40.866, longitude: -73.927 };
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      if (query.startsWith('3961 10th Avenue,')) return new Response(JSON.stringify([{
        lat: String(direct.latitude), lon: String(direct.longitude),
        address: { house_number: '3961', road: '10th Avenue', suburb: 'Manhattan' }
      }]));
      if (query.startsWith('10th Avenue and West 207th Street')) return new Response(JSON.stringify([{
        lat: '40.863', lon: '-73.929', address: { road: '10th Avenue', suburb: 'Manhattan' }
      }]));
      if (query.startsWith('10th Avenue and West 215th Street')) return new Response(JSON.stringify([{
        lat: '40.869', lon: '-73.926', address: { road: '10th Avenue', suburb: 'Manhattan' }
      }]));
      return new Response('[]');
    });

    assert.deepEqual(
      await geocoder.geocode('3961 10th Avenue between West 207th Street and West 215th Street', 'Manhattan'),
      direct
    );
  });

  it('rejects a direct geocoder result whose borough or street does not match', async () => {
    const wrongBorough = new NominatimIncidentGeocoder(undefined, async () => new Response(JSON.stringify([{
      lat: '40.7964623', lon: '-73.9624967',
      address: { house_number: '54', road: 'West 103rd Street', suburb: 'Queens' }
    }])));
    const wrongStreet = new NominatimIncidentGeocoder(undefined, async () => new Response(JSON.stringify([{
      lat: '40.7964623', lon: '-73.9624967',
      address: { house_number: '54', road: 'East 103rd Street', suburb: 'Manhattan' }
    }])));

    assert.equal(await wrongBorough.geocode('54 West 103 Street', 'Manhattan'), undefined);
    assert.equal(await wrongStreet.geocode('54 West 103 Street', 'Manhattan'), undefined);
  });

  it('geocodes a street followed by an explicit borough without treating the borough as part of the street name', async () => {
    const queries: string[] = [];
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      queries.push(query);
      return new Response(JSON.stringify([{
        lat: '40.75', lon: '-73.98', name: 'Brooklyn Avenue',
        address: { road: 'Brooklyn Avenue', suburb: 'Manhattan' }
      }]));
    });

    assert.deepEqual(await geocoder.geocode('Brooklyn Avenue, Manhattan', 'Manhattan'), { latitude: 40.75, longitude: -73.98 });
    assert.equal(queries[0], 'Brooklyn Avenue, Manhattan, New York City, NY');
  });

  it('uses the midpoint of two verified cross-street intersections', async () => {
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      if (query.startsWith('4th Street between')) return new Response('[]');
      if (query.startsWith('4th Street and 26th Avenue')) return new Response(JSON.stringify([{ lat: '40.7760', lon: '-73.9330', address: { suburb: 'Queens' } }]));
      if (query.startsWith('4th Street and 27th Avenue')) return new Response(JSON.stringify([{ lat: '40.7747', lon: '-73.9332', address: { suburb: 'Queens' } }]));
      return new Response('[]');
    });

    const coordinates = await geocoder.geocode('4th Street between 26th Avenue and 27th Avenue', 'Queens');

    assert.deepEqual(coordinates, { latitude: 40.77535, longitude: -73.9331 });
  });

  it('geocodes a garbled street-between-avenues description only when one NYC road matches both avenues', async () => {
    const queries: string[] = [];
    const geocoder = new NominatimIncidentGeocoder(undefined, async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? '';
      queries.push(query);
      if (query.startsWith('7519 26-46')) return new Response('[]');
      if (query === '4th Street, Queens, New York City, NY') return new Response(JSON.stringify([
        { lat: '40.7754', lon: '-73.9330', address: { road: '4th Street', suburb: 'Queens' } },
        { lat: '40.7367', lon: '-73.7317', address: { road: '4th Street', suburb: 'Queens' } }
      ]));
      if (query.startsWith('4th Street and')) return new Response('[]');
      if (query.startsWith('26th Avenue')) return new Response(JSON.stringify([{ lat: '40.7763', lon: '-73.9331', address: { road: '26th Avenue', suburb: 'Queens' } }]));
      if (query.startsWith('27th Avenue')) return new Response(JSON.stringify([{ lat: '40.7747', lon: '-73.9333', address: { road: '27th Avenue', suburb: 'Queens' } }]));
      return new Response('[]');
    });

    const coordinates = await geocoder.geocode('7519 26-46 number four Street between Two Six and Two Seven Avenues', 'Queens');
    const secondAddressCoordinates = await geocoder.geocode('number four Street, between Two Six and Two Seven Avenues', 'Queens');

    assert.deepEqual(coordinates, { latitude: 40.7754, longitude: -73.933 });
    assert.deepEqual(secondAddressCoordinates, coordinates);
    assert.deepEqual(queries, [
      '7519 26-46 4th Street, Queens, New York City, NY',
      '4th Street and 26th Avenue, Queens, New York City, NY',
      '4th Street and 27th Avenue, Queens, New York City, NY',
      '4th Street, Queens, New York City, NY',
      '26th Avenue, Queens, New York City, NY',
      '27th Avenue, Queens, New York City, NY',
      '4th Street, Queens, New York City, NY',
      '4th Street and 26th Avenue, Queens, New York City, NY',
      '4th Street and 27th Avenue, Queens, New York City, NY',
      '4th Street, Queens, New York City, NY',
      '26th Avenue, Queens, New York City, NY',
      '27th Avenue, Queens, New York City, NY'
    ]);
  });
});
