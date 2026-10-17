import { describe, expect, it } from 'vitest';
import { hasNewerCommit } from './appUpdate';
import { speedFromMetersPerSecond } from './drivingAssistant';

describe('driving assistant', () => {
  it('converts GPS speed to rounded km/h', () => {
    expect(speedFromMetersPerSecond(10)).toBe(36);
  });

  it('detects a newer Git commit', () => {
    expect(hasNewerCommit({ builtAt: 1000, commitSha: null }, { committedAt: 2000, sha: 'new' })).toBe(true);
    expect(hasNewerCommit({ builtAt: 1000, commitSha: 'old' }, { committedAt: 500, sha: 'new' })).toBe(true);
    expect(hasNewerCommit({ builtAt: 1000, commitSha: 'same' }, { committedAt: 2000, sha: 'same' })).toBe(false);
  });
});
