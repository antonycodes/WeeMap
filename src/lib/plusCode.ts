import { OpenLocationCode } from 'open-location-code';

const codes = new OpenLocationCode();
export function resolvePlusCode(value: string, reference: { latitude: number; longitude: number }) {
  const input = value.trim().toUpperCase();
  const parts = input.split(/\s+/);
  let code = parts[0];
  const shortened = codes.isShort(code);
  if (shortened && parts.length > 1) throw new Error('Mã rút gọn kèm địa phương chưa được hỗ trợ. Hãy dùng Plus Code đầy đủ.');
  if (shortened) code = codes.recoverNearest(code, reference.latitude, reference.longitude);
  if (!codes.isFull(code)) throw new Error('Plus Code không hợp lệ. Hãy sao chép mã từ Google Maps.');
  const area = codes.decode(code);
  return { code, latitude: area.latitudeCenter, longitude: area.longitudeCenter, shortened };
}
