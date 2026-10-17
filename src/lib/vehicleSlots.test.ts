import { describe, expect, it } from 'vitest';
import { hasValidVehicleSet, parseVehicleCodes } from './vehicleSlots';

describe('vehicle slots', () => {
  it('normalizes and deduplicates codes', () => {
    expect(parseVehicleCodes(' xe-01\nXE-02, xe-01 ')).toEqual(['XE-01', 'XE-02']);
    expect(hasValidVehicleSet(['XE-01', 'XE-02'], 2)).toBe(true);
  });

  it('requires the configured count', () => {
    expect(hasValidVehicleSet(['XE-01'], 2)).toBe(false);
    expect(hasValidVehicleSet(['Xe 1'], 1)).toBe(false);
  });
});
