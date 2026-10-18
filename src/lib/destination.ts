import { OpenLocationCode } from 'open-location-code';
import { resolvePlusCode } from './plusCode';
import { isCoordinates, type Coordinates } from './plannedRoute';

export type DestinationTarget = {
  code: string;
  latitude: number;
  longitude: number;
  shortened: boolean;
  label?: string;
};

export type DestinationInput =
  | { target: DestinationTarget }
  | { geocodeText: string; shortCode?: string }
  | null;

const codes = new OpenLocationCode();
const plusCodePattern = /[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,}/i;
const coordinatePatterns = [
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  /(?:^|[?&](?:q|query|destination)=)(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/i,
  /(^|\s|\()(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?=\s|\)|$)/,
  /(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
];

export function parseDestinationTarget(value: unknown): DestinationTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<DestinationTarget>;
  if (typeof target.code !== 'string' || !target.code || target.code.length > 160
    || typeof target.latitude !== 'number' || typeof target.longitude !== 'number'
    || !isCoordinates([target.longitude, target.latitude]) || typeof target.shortened !== 'boolean'
    || (target.label !== undefined && (typeof target.label !== 'string' || target.label.length > 160))) return null;
  return { code: target.code, latitude: target.latitude, longitude: target.longitude, shortened: target.shortened, label: target.label };
}

export function parseDestinationInput(value: string, reference: { latitude: number; longitude: number }): DestinationInput {
  const input = value.trim();
  if (!input) return null;

  const coordinateInputs = [input];
  try {
    const decoded = decodeURIComponent(input);
    if (decoded !== input) coordinateInputs.unshift(decoded);
  } catch {
    // Keep parsing the original link when its query is partially encoded.
  }
  for (const coordinateInput of coordinateInputs) {
    for (const pattern of coordinatePatterns) {
      const match = coordinateInput.match(pattern);
      if (!match) continue;
      const latitude = Number(match[match.length - 2]);
      const longitude = Number(match[match.length - 1]);
      if (isCoordinates([longitude, latitude])) return { target: { code: 'Tọa độ', label: input, latitude, longitude, shortened: false } };
    }
  }

  const plusCode = input.match(plusCodePattern)?.[0].toUpperCase();
  if (plusCode) {
    if (codes.isFull(plusCode)) {
      const target = resolvePlusCode(plusCode, reference);
      return { target: { ...target, label: input === plusCode ? undefined : input } };
    }
    if (codes.isShort(plusCode)) {
      const remainder = input.replace(plusCode, '').replace(/[\s,]+/g, ' ').trim();
      if (!remainder) return { target: resolvePlusCode(plusCode, reference) };
      return { geocodeText: remainder, shortCode: plusCode };
    }
  }

  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const query = url.searchParams.get('query') ?? url.searchParams.get('q');
      if (query?.trim()) return { geocodeText: query.trim() };
      const place = url.pathname.match(/\/place\/([^/]+)/i)?.[1];
      if (place) return { geocodeText: decodeURIComponent(place.replace(/\+/g, ' ')) };
    } catch {
      // Treat malformed links as normal address text for geocoding.
    }
  }

  return { geocodeText: input };
}

export function coordinatesFromTarget(target: DestinationTarget): Coordinates {
  return [target.longitude, target.latitude];
}
