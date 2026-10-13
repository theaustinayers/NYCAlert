import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractActingAsAssignments, extractUnitIds, isSameIncident } from './incident-correlation.js';

describe('extractUnitIds', () => {
  it('normalizes explicitly spoken fire/rescue unit identifiers', () => {
    assert.deepEqual(extractUnitIds('Engine 12 and Rescue 1 responding with Battalion 3'), [
      'ENGINE 12', 'RESCUE 1', 'BATTALION 3'
    ]);
  });

  it('does not infer a unit from an unqualified number', () => {
    assert.deepEqual(extractUnitIds('Respond to 123 Main Street, cross street 45th Avenue'), []);
  });

  it('recognizes explicitly spoken NYPD car numbers and phonetic call signs', () => {
    assert.deepEqual(extractUnitIds('Car 1234 and 5-Adam-12 responding'), ['NYPD CAR 1234', 'NYPD 5-ADAM-12']);
  });

  it('preserves explicit FDNY acting-as identities as an assignment pair', () => {
    assert.deepEqual(extractActingAsAssignments('Engine 7 acting as Engine 39 for this response.'), [
      { unitId: 'ENGINE 7', actingAsUnitId: 'ENGINE 39' }
    ]);
    assert.deepEqual(extractActingAsAssignments('Ladder 3 is acting as Ladder 10.'), [
      { unitId: 'LADDER 3', actingAsUnitId: 'LADDER 10' }
    ]);
    assert.deepEqual(extractActingAsAssignments('Engine 7 responding with Ladder 3.'), []);
  });
});

describe('isSameIncident', () => {
  const initial = {
    agency: 'FDNY' as const,
    borough: 'Queens' as const,
    incidentType: 'vehicle' as const,
    location: 'Long Island Expressway at Queens Boulevard',
    unitIds: ['ENGINE 12'],
    occurredAt: 1_000_000
  };

  it('matches compatible calls at the same explicit location within thirty minutes', () => {
    assert.equal(isSameIncident(initial, {
      ...initial,
      location: 'LIE near Queens Boulevard',
      unitIds: ['RESCUE 1'],
      occurredAt: initial.occurredAt + 20 * 60_000
    }), true);
  });

  it('merges the same explicit address and incident across incorrect borough feed labels', () => {
    const manhattan = {
      ...initial,
      borough: 'Manhattan' as const,
      incidentType: 'fire' as const,
      location: '598 West 178 Street',
      unitIds: [],
      occurredAt: 1_000_000
    };
    const statenIslandFeed = {
      ...manhattan,
      borough: 'Staten Island' as const,
      location: '598 West 178th Street between Saint Nicholas Avenue and Audubon Avenue',
      occurredAt: manhattan.occurredAt + 10_000
    };
    const queensFeed = {
      ...statenIslandFeed,
      borough: 'Queens' as const,
      location: '598 West 178 Street',
      occurredAt: manhattan.occurredAt + 20_000
    };

    assert.equal(isSameIncident(manhattan, statenIslandFeed), true);
    assert.equal(isSameIncident(manhattan, queensFeed), true);
  });

  it('does not merge cross-borough calls using only a street name or shared unit', () => {
    const manhattanFire = { ...initial, incidentType: 'fire' as const, location: 'West 178th Street', unitIds: ['ENGINE 12'] };
    const otherBoroughFire = { ...manhattanFire, borough: 'Bronx' as const, occurredAt: initial.occurredAt + 10_000 };

    assert.equal(isSameIncident(manhattanFire, otherBoroughFire), false);
  });

  it('groups a nearby, time-adjacent call when event details corroborate the same incident', () => {
    const first = {
      ...initial,
      incidentType: 'fire' as const,
      location: '598 West 178th Street',
      latitude: 40.84712,
      longitude: -73.93494,
      unitIds: [],
      eventDescription: 'Second Alarm Fire top floor five story multiple dwelling',
      occurredAt: 5_000_000
    };
    const followup = {
      ...first,
      location: 'West 178 Street between Saint Nicholas Avenue and Audubon Avenue',
      latitude: 40.84730,
      longitude: -73.93500,
      eventDescription: 'Second alarm fire on the top floor of a five-story apartment building',
      occurredAt: first.occurredAt + 4 * 60_000
    };

    assert.equal(isSameIncident(first, followup), true);
  });

  it('does not group similar-sounding incidents when geocoded locations conflict by several blocks', () => {
    const first = {
      ...initial,
      incidentType: 'fire' as const,
      location: '598 West 178th Street',
      latitude: 40.84712,
      longitude: -73.93494,
      unitIds: [],
      eventDescription: 'Second Alarm Fire top floor five story multiple dwelling',
      occurredAt: 5_000_000
    };
    const otherFire = {
      ...first,
      location: '598 West 27th Street',
      latitude: 40.75127,
      longitude: -74.00509,
      eventDescription: 'Second alarm fire on the top floor of a five-story apartment building',
      occurredAt: first.occurredAt + 2 * 60_000
    };

    assert.equal(isSameIncident(first, otherFire), false);
  });

  it('groups distinctive near-simultaneous train-car arson reports when one location is only the borough', () => {
    const reported = {
      ...initial,
      borough: 'Brooklyn' as const,
      incidentType: 'fire' as const,
      location: 'Brooklyn',
      unitIds: ['NYPD CAR 1530'],
      eventDescription: 'Reported EDP Fire reported fire set by EDP in train car',
      occurredAt: 10_000_000
    };
    const detailed = {
      ...reported,
      location: '2345 Atlantic Avenue, Brooklyn',
      unitIds: [],
      eventDescription: 'EDP Setting Fires EDP setting fires in train car at Brooklyn Center Station',
      occurredAt: reported.occurredAt + 45_000
    };

    assert.equal(isSameIncident(reported, detailed), true);
  });

  it('does not merge generic nearby fire reports without distinctive shared event details', () => {
    const first = {
      ...initial,
      borough: 'Brooklyn' as const,
      incidentType: 'fire' as const,
      location: 'Brooklyn',
      unitIds: [],
      eventDescription: 'Reported fire in building',
      occurredAt: 10_000_000
    };
    const second = {
      ...first,
      location: 'Nearby apartment building',
      eventDescription: 'Reported fire in apartment',
      occurredAt: first.occurredAt + 30_000
    };

    assert.equal(isSameIncident(first, second), false);
  });

  it('matches a short unit-linked status-only follow-up', () => {
    assert.equal(isSameIncident(initial, {
      agency: 'FDNY', borough: 'Queens', incidentType: 'other', unitIds: ['ENGINE 12'],
      occurredAt: initial.occurredAt + 4 * 60_000
    }), true);
  });

  it('does not merge different units without a matching location or incompatible event types', () => {
    assert.equal(isSameIncident(initial, {
      ...initial, location: 'Different Street and Another Avenue', unitIds: ['ENGINE 4'],
      occurredAt: initial.occurredAt + 60_000
    }), false);
    assert.equal(isSameIncident(initial, {
      ...initial, incidentType: 'fire', occurredAt: initial.occurredAt + 60_000
    }), false);
  });
});
