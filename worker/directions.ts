import { parsePlannedRoute, type Coordinates } from '../src/lib/plannedRoute';

export class DirectionsError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

export async function calculateDirections(key: string, start: Coordinates, end: Coordinates) {
  const id = crypto.randomUUID();
  const started = performance.now();
  let stage = 'request';
  const log = (step: string, fields: Record<string, unknown> = {}) => console.info(JSON.stringify({ service: 'ors-directions', id, stage: step, elapsedMs: Math.round(performance.now() - started), ...fields }));
  log(stage);
  try {
    const response = await fetch('https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson', {
      method: 'POST', headers: { Authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ coordinates: [start, end], instructions: false, geometry_simplify: true }), signal: AbortSignal.timeout(45_000),
    });
    stage = 'headers';
    log(stage, { status: response.status });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'Điểm xuất phát hoặc điểm đến không có đường ô tô phù hợp.',
        404: 'Không tìm được đường ô tô tới điểm đã chọn.',
        401: 'Dịch vụ lộ trình chưa xác thực được API key.',
        403: 'API key chưa có quyền tính lộ trình hoặc đã hết hạn mức.',
        429: 'Dịch vụ tính đường đã hết lượt. Hãy thử lại sau.',
      };
      throw new DirectionsError(messages[response.status] ?? `Dịch vụ tính đường đang lỗi (${response.status}). Hãy thử lại sau.`);
    }
    stage = 'body';
    const data = await response.json() as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: { summary?: { distance?: unknown; duration?: unknown } } }> };
    log('body-complete');
    stage = 'validation';
    const feature = data.features?.[0];
    const route = feature?.geometry?.type === 'LineString' ? parsePlannedRoute({ coordinates: feature.geometry.coordinates, distanceMeters: feature.properties?.summary?.distance, durationSeconds: feature.properties?.summary?.duration }) : null;
    if (!route) throw new DirectionsError('Dữ liệu tuyến đường không hợp lệ.');
    log('complete');
    return route;
  } catch (error) {
    log('failed', { failedStage: stage, errorType: error instanceof Error ? error.name : 'Unknown' });
    throw error;
  }
}
