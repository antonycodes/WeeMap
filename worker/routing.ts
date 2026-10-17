export type RoutePoint = { memberId: string; latitude: number; longitude: number };
export type RouteMatrix = {
  calculatedAt: number;
  memberIds: string[];
  distances: Array<Array<number | null>>;
  durations: Array<Array<number | null>>;
};

function readMatrix(value: unknown, size: number): Array<Array<number | null>> {
  if (!Array.isArray(value) || value.length !== size || value.some((row) => !Array.isArray(row)
    || row.length !== size || row.some((cell: unknown) => cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell) || cell < 0)))) {
    throw new Error('Invalid routing response');
  }
  return value;
}

export async function calculateRouteMatrix(apiKey: string, points: RoutePoint[]): Promise<RouteMatrix> {
  const response = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
    method: 'POST',
    headers: { Authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ locations: points.map((point) => [point.longitude, point.latitude]), metrics: ['distance', 'duration'], units: 'm' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Routing service unavailable');
  const data = await response.json() as { distances?: unknown; durations?: unknown };
  return {
    calculatedAt: Date.now(),
    memberIds: points.map((point) => point.memberId),
    distances: readMatrix(data.distances, points.length),
    durations: readMatrix(data.durations, points.length),
  };
}

export function routesFromMatrix(matrix: RouteMatrix, sourceId: string, activeIds: Set<string>) {
  const sourceIndex = matrix.memberIds.indexOf(sourceId);
  if (sourceIndex < 0) return [];
  return matrix.memberIds.flatMap((memberId, index) => {
    const distanceMeters = matrix.distances[sourceIndex]?.[index];
    const durationSeconds = matrix.durations[sourceIndex]?.[index];
    if (memberId === sourceId || !activeIds.has(memberId) || distanceMeters == null || durationSeconds == null) return [];
    return [{ memberId, distanceMeters, durationSeconds }];
  });
}
