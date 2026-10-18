import { isCoordinates } from './plannedRoute';

export type SharedRouteTarget = {
  code: string;
  latitude: number;
  longitude: number;
  shortened: boolean;
};

export type SharedRouteState = {
  started: boolean;
  target: SharedRouteTarget;
};

export function parseSharedRouteState(value: unknown): SharedRouteState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<SharedRouteState>;
  const target = state.target;
  if (!target || typeof target !== 'object') return null;
  const candidate = target as Partial<SharedRouteTarget>;
  if (typeof state.started !== 'boolean' || typeof candidate.code !== 'string' || !candidate.code || candidate.code.length > 160
    || typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number'
    || !isCoordinates([candidate.longitude, candidate.latitude]) || typeof candidate.shortened !== 'boolean') return null;
  return { started: state.started, target: { code: candidate.code, latitude: candidate.latitude, longitude: candidate.longitude, shortened: candidate.shortened } };
}
