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

  it('matches the audit-derived Bronx cross-feed pattern with a one-number street address and corrected suffix', () => {
    const original = {
      ...initial,
      borough: 'Bronx' as const,
      incidentType: 'fire' as const,
      location: '1717 West Farms Rd',
      eventDescription: 'Heavy fire reported at commercial building, second alarm',
      boxNumbers: ['BOX 2908'],
      unitIds: [],
      occurredAt: 50_000_000
    };
    const crossFeed = {
      ...original,
      borough: 'Queens' as const,
      location: '1717 West Farms Road',
      eventDescription: 'Second alarm transmitted at 1717 West Farms Road; defensive operation',
      boxNumbers: ['BOX 2910'],
      occurredAt: original.occurredAt + 13 * 60_000
    };
    assert.equal(isSameIncident(original, crossFeed), true);
  });

  it('matches an under-control status with an unspecified type at the same exact address', () => {
    const activeFire = {
      ...initial,
      borough: 'Bronx' as const,
      incidentType: 'fire' as const,
      location: '1717 West Farms Road',
      eventDescription: 'Heavy fire, second alarm commercial building',
      unitIds: [],
      occurredAt: 50_000_000
    };
    assert.equal(isSameIncident(activeFire, {
      ...activeFire,
      borough: 'Manhattan',
      incidentType: 'other',
      eventDescription: 'Fire under control',
      occurredAt: activeFire.occurredAt + 16 * 60_000
    }), true);
  });

  it('still rejects different addresses or conflicting precise coordinates across borough feed labels', () => {
    const original = {
      ...initial,
      borough: 'Bronx' as const,
      incidentType: 'fire' as const,
      location: '1717 West Farms Road',
      unitIds: [],
      occurredAt: 60_000_000
    };
    assert.equal(isSameIncident(original, {
      ...original, borough: 'Queens', location: '1718 West Farms Road', occurredAt: original.occurredAt + 30_000
    }), false);
    assert.equal(isSameIncident({ ...original, latitude: 40.84, longitude: -73.88 }, {
      ...original, borough: 'Queens', latitude: 40.75, longitude: -73.99, occurredAt: original.occurredAt + 30_000
    }), false);
    assert.equal(isSameIncident(original, {
      ...original, borough: 'Queens', incidentType: 'vehicle', occurredAt: original.occurredAt + 30_000
    }), false);
    assert.equal(isSameIncident({ ...original, location: '999 Example Road, Bronx' }, {
      ...original, borough: 'Queens', location: '999 Example Road, Queens', occurredAt: original.occurredAt + 30_000
    }), false);
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

  it('does not merge different explicit Manhattan addresses just because Box and unit match', () => {
    const earlier = {
      ...initial,
      borough: 'Manhattan' as const,
      incidentType: 'fire' as const,
      location: '320 St. Nicholas Avenue',
      unitIds: ['ENGINE 12'],
      boxNumbers: ['BOX 1489'],
      eventDescription: 'Electrical fire reported.',
      occurredAt: 10_000_000
    };
    const later = {
      ...earlier,
      location: '359 West 126th Street',
      eventDescription: 'Engine 12 requested to assist at another address.',
      occurredAt: earlier.occurredAt + 60_000
    };

    assert.equal(isSameIncident(earlier, later), false);
  });

  it('still matches spelling variants of the same explicit address with shared Box evidence', () => {
    const earlier = {
      ...initial,
      borough: 'Manhattan' as const,
      incidentType: 'fire' as const,
      location: '320 St. Nicholas Avenue',
      boxNumbers: ['BOX 1489'],
      occurredAt: 10_000_000
    };
    const later = {
      ...earlier,
      location: '320 Saint Nicholas Avenue, between 126th Street and 127th Street',
      occurredAt: earlier.occurredAt + 60_000
    };

    assert.equal(isSameIncident(earlier, later), true);
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

  it('matches an FDNY and NYPD follow-up with the same exact address, type, time, and specific event', () => {
    const fdny = {
      ...initial,
      agency: 'FDNY' as const,
      incidentType: 'fire' as const,
      location: '320 St. Nicholas Avenue, Manhattan',
      eventDescription: 'Fire reported in an occupied apartment building',
      unitIds: ['ENGINE 12'],
      occurredAt: 20_000_000
    };
    const nypd = {
      ...fdny,
      agency: 'NYPD' as const,
      eventDescription: 'NYPD units assisting at a reported fire in an occupied apartment building',
      unitIds: ['NYPD CAR 1234'],
      occurredAt: fdny.occurredAt + 2 * 60_000
    };
    assert.equal(isSameIncident(fdny, nypd), true);
  });

  it('rejects cross-agency matches based only on same-borough generic wording', () => {
    const fdny = {
      ...initial,
      agency: 'FDNY' as const,
      incidentType: 'fire' as const,
      location: 'Queens',
      eventDescription: 'Reported fire in a building',
      unitIds: [],
      occurredAt: 20_000_000
    };
    assert.equal(isSameIncident(fdny, {
      ...fdny,
      agency: 'NYPD',
      eventDescription: 'Reported fire in another building',
      occurredAt: fdny.occurredAt + 30_000
    }), false);
  });

  it('rejects cross-agency reports with conflicting explicit addresses or incident types', () => {
    const fdny = {
      ...initial,
      agency: 'FDNY' as const,
      incidentType: 'fire' as const,
      location: '320 St. Nicholas Avenue',
      eventDescription: 'Fire reported in an occupied apartment building',
      unitIds: [],
      occurredAt: 20_000_000
    };
    assert.equal(isSameIncident(fdny, {
      ...fdny,
      agency: 'NYPD',
      location: '359 West 126th Street',
      occurredAt: fdny.occurredAt + 30_000
    }), false);
    assert.equal(isSameIncident(fdny, {
      ...fdny,
      agency: 'NYPD',
      incidentType: 'vehicle',
      occurredAt: fdny.occurredAt + 30_000
    }), false);
  });

  it('does not link FDNY and NYPD reports using shared unit numbers or code-like wording alone', () => {
    const fdny = {
      ...initial,
      agency: 'FDNY' as const,
      incidentType: 'other' as const,
      location: '320 St. Nicholas Avenue',
      eventDescription: '10-10 reported',
      unitIds: ['ENGINE 12'],
      occurredAt: 20_000_000
    };
    assert.equal(isSameIncident(fdny, {
      ...fdny,
      agency: 'NYPD',
      unitIds: ['ENGINE 12'],
      occurredAt: fdny.occurredAt + 30_000
    }), false);
  });
});
