import { describe, expect, it } from 'vitest';
import { getRouteProgress, type PlannedRoute } from './plannedRoute';

const route: PlannedRoute = {
  coordinates: [[106.6, 10.7], [106.61, 10.7], [106.62, 10.7]],
  distanceMeters: 2200,
  durationSeconds: 300,
};

describe('planned route progress', () => {
  it('splits the route at the nearest point', () => {
    const progress = getRouteProgress(route, [106.611, 10.7]);

    expect(progress.traveled).toEqual([[106.6, 10.7], [106.61, 10.7]]);
    expect(progress.remaining).toEqual([[106.61, 10.7], [106.62, 10.7]]);
    expect(progress.offRoute).toBe(false);
  });

  it('marks a vehicle far from the route', () => {
    expect(getRouteProgress(route, [106.61, 10.72]).offRoute).toBe(true);
  });
});
