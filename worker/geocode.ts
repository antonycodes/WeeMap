import { resolvePlusCode } from '../src/lib/plusCode';
import { isCoordinates } from '../src/lib/plannedRoute';
import type { DestinationTarget } from '../src/lib/destination';

export class GeocodeError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

export async function geocodeDestination(key: string, text: string, shortCode?: string): Promise<DestinationTarget> {
  const url = new URL('https://api.openrouteservice.org/geocode/search');
  url.searchParams.set('text', text);
  url.searchParams.set('size', '1');
  const response = await fetch(url, {
    headers: { Authorization: key, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new GeocodeError('Dịch vụ tìm địa chỉ chưa được xác thực.', response.status);
    if (response.status === 429) throw new GeocodeError('Dịch vụ tìm địa chỉ đã hết lượt. Hãy thử lại sau.', 429);
    throw new GeocodeError('Không tìm thấy địa chỉ điểm đến.');
  }
  const data = await response.json() as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: { label?: unknown } }> };
  const feature = data.features?.[0];
  const coordinates = feature?.geometry?.coordinates;
  if (feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2
    || !isCoordinates(coordinates)) throw new GeocodeError('Không xác định được vị trí điểm đến.', 404);
  const label = typeof feature.properties?.label === 'string' ? feature.properties.label.slice(0, 160) : text.slice(0, 160);
  const [longitude, latitude] = coordinates;
  if (shortCode) return { ...resolvePlusCode(shortCode, { latitude, longitude }), label };
  return { code: label, label, latitude, longitude, shortened: false };
}
