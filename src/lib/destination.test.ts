import { describe, expect, it } from 'vitest';
import { parseDestinationInput } from './destination';

const reference = { latitude: 10.7769, longitude: 106.7009 };

describe('destination input', () => {
  it('reads coordinates from a Google Maps link', () => {
    const result = parseDestinationInput('https://www.google.com/maps/@10.7,106.6,17z', reference);
    expect(result).toMatchObject({ target: { latitude: 10.7, longitude: 106.6 } });
  });

  it('reads encoded coordinates from a Google Maps query link', () => {
    const result = parseDestinationInput('https://www.google.com/maps/search/?api=1&query=10.7%2C106.6', reference);
    expect(result).toMatchObject({ target: { latitude: 10.7, longitude: 106.6 } });
  });

  it('extracts a place name from a Google Maps search link', () => {
    expect(parseDestinationInput('https://www.google.com/maps/search/?api=1&query=Ben+Thanh+Market', reference)).toEqual({ geocodeText: 'Ben Thanh Market' });
  });

  it('sends a shortened code with locality to geocoding', () => {
    expect(parseDestinationInput('7P28+5G, Hồ Chí Minh', reference)).toEqual({ geocodeText: 'Hồ Chí Minh', shortCode: '7P28+5G' });
  });

  it('sends a normal address to geocoding', () => {
    expect(parseDestinationInput('1 Lê Duẩn, Quận 1, Hồ Chí Minh', reference)).toEqual({ geocodeText: '1 Lê Duẩn, Quận 1, Hồ Chí Minh' });
  });
});
