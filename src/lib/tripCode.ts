const UUID_CODE = /^[0-9a-f-]{36}$/i;
const CUSTOM_CODE = /^[A-Z0-9_-]{4,32}$/;

export function normalizeTripCode(value: string): string {
  const trimmed = value.trim();
  return UUID_CODE.test(trimmed) ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

export function isValidTripCode(value: string): boolean {
  const normalized = normalizeTripCode(value);
  return UUID_CODE.test(normalized) || CUSTOM_CODE.test(normalized);
}

export function extractTripCode(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const trip = url.searchParams.get('trip');
    if (trip) return normalizeTripCode(trip);
  } catch {
    // Manual codes are not URLs.
  }
  return normalizeTripCode(trimmed);
}
