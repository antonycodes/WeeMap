import { describe, expect, it } from 'vitest';
import { hasNewerCommit } from './appUpdate';
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

  it('detects a newer Git commit', () => {
    expect(hasNewerCommit({ builtAt: 1000, commitSha: null }, { committedAt: 2000, sha: 'new' })).toBe(true);
    expect(hasNewerCommit({ builtAt: 1000, commitSha: 'old' }, { committedAt: 500, sha: 'new' })).toBe(true);
    expect(hasNewerCommit({ builtAt: 1000, commitSha: 'same' }, { committedAt: 2000, sha: 'same' })).toBe(false);
  });
});
