const VEHICLE_CODE = /^[A-Z0-9_-]{1,20}$/;

export const MAX_VEHICLES = 20;

export function parseVehicleCodes(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

export function isValidVehicleCode(code: string): boolean {
  return VEHICLE_CODE.test(code);
}

export function hasValidVehicleSet(codes: string[], count: number): boolean {
  return count >= 1 && count <= MAX_VEHICLES && codes.length === count && codes.every(isValidVehicleCode);
}
