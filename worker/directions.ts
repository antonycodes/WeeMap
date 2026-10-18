import { parsePlannedRoute, type Coordinates } from '../src/lib/plannedRoute';

export async function calculateDirections(key: string, start: Coordinates, end: Coordinates) {
  const response = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
    method: 'POST', headers: { Authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ coordinates: [start, end], instructions: false }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Không tìm được đường ô tô hoặc dịch vụ đang bận.');
  const data = await response.json() as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: { summary?: { distance?: unknown; duration?: unknown } } }> };
  const feature = data.features?.[0];
  const route = feature?.geometry?.type === 'LineString' ? parsePlannedRoute({ coordinates: feature.geometry.coordinates, distanceMeters: feature.properties?.summary?.distance, durationSeconds: feature.properties?.summary?.duration }) : null;
  if (!route) throw new Error('Dữ liệu tuyến đường không hợp lệ.');
  return route;
}
