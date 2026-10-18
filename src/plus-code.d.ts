declare module 'open-location-code' {
  export class OpenLocationCode {
    isShort(code: string): boolean;
    isFull(code: string): boolean;
    recoverNearest(code: string, latitude: number, longitude: number): string;
    decode(code: string): { latitudeCenter: number; longitudeCenter: number };
  }
}
