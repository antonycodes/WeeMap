import { describe, expect, it } from 'vitest';
import { isOverSpeedLimit, speedFromMetersPerSecond } from './drivingAssistant';

describe('driving assistant', () => {
  it('converts GPS speed to rounded km/h', () => {
    expect(speedFromMetersPerSecond(10)).toBe(36);
  });

  it('does not warn when GPS speed is unavailable', () => {
    expect(isOverSpeedLimit(null, 60)).toBe(false);
  });

  it('warns only above the manual threshold', () => {
    expect(isOverSpeedLimit(61, 60)).toBe(true);
    expect(isOverSpeedLimit(60, 60)).toBe(false);
  });
});
