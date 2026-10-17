import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SPEED_LIMIT, isOverSpeedLimit, speedFromMetersPerSecond } from './lib/drivingAssistant';
import { loadGoogleMaps } from './lib/googleMaps';

type CheckState = 'ok' | 'pending' | 'blocked';
type Position = { latitude: number; longitude: number; accuracy: number; speed: number | null; timestamp: number };

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function statusLabel(state: CheckState): string {
  return state === 'ok' ? 'Đạt' : state === 'blocked' ? 'Cần xử lý' : 'Đang kiểm tra';
}

export default function App() {
  const [standalone, setStandalone] = useState(isStandalone);
  const [gpsState, setGpsState] = useState<CheckState>('pending');
  const [wakeState, setWakeState] = useState<CheckState>('pending');
  const [serverState, setServerState] = useState<CheckState>('pending');
  const [position, setPosition] = useState<Position | null>(null);
  const [speedLimit, setSpeedLimit] = useState(DEFAULT_SPEED_LIMIT);
  const [error, setError] = useState<string | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const watchId = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const memberId = useRef(crypto.randomUUID()).current;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const tripId = new URLSearchParams(window.location.search).get('trip');

  const currentSpeed = useMemo(() => speedFromMetersPerSecond(position?.speed ?? null), [position]);
  const speeding = isOverSpeedLimit(currentSpeed, speedLimit);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) {
      setWakeState('blocked');
      return;
    }
    try {
      wakeLock.current = await navigator.wakeLock.request('screen');
      setWakeState('ok');
    } catch {
      setWakeState('blocked');
    }
  }, []);

  useEffect(() => {
    const updateStandalone = () => setStandalone(isStandalone());
    window.addEventListener('visibilitychange', updateStandalone);
    void requestWakeLock();
    return () => window.removeEventListener('visibilitychange', updateStandalone);
  }, [requestWakeLock]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsState('blocked');
      setError('Thiết bị không hỗ trợ GPS trên trình duyệt này.');
      return;
    }
    watchId.current = navigator.geolocation.watchPosition(
      (next) => {
        setPosition({ latitude: next.coords.latitude, longitude: next.coords.longitude, accuracy: next.coords.accuracy, speed: next.coords.speed, timestamp: next.timestamp });
        setGpsState('ok');
        setError(null);
      },
      (nextError) => {
        setGpsState('blocked');
        setError(nextError.message);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error('server');
        if (!cancelled) setServerState('ok');
      })
      .catch(() => {
        if (!cancelled) setServerState('blocked');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!tripId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const nextSocket = new WebSocket(`${protocol}://${window.location.host}/ws/${tripId}`);
    socket.current = nextSocket;
    nextSocket.addEventListener('open', () => {
      setServerState('ok');
      if (position) sendPosition(nextSocket, memberId, position, currentSpeed);
    });
    nextSocket.addEventListener('error', () => setServerState('blocked'));
    return () => {
      nextSocket.close();
      socket.current = null;
    };
  }, [tripId]);

  useEffect(() => {
    if (socket.current?.readyState === WebSocket.OPEN && position) {
      sendPosition(socket.current, memberId, position, currentSpeed);
    }
  }, [position, currentSpeed, memberId]);

  useEffect(() => {
    if (!mapsKey || !mapRef.current) return;
    void loadGoogleMaps(mapsKey)
      .then(() => {
        if (!mapRef.current || !window.google?.maps) return;
        const center = position ? { lat: position.latitude, lng: position.longitude } : { lat: 10.7769, lng: 106.7009 };
        new window.google.maps.Map(mapRef.current, { center, zoom: position ? 16 : 12, disableDefaultUI: true });
      })
      .catch(() => setError('Không tải được Google Maps. Kiểm tra key local.'));
  }, [mapsKey, position]);

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">PHASE 0 · PRIVATE BETA</p><h1>Group Navigation</h1></div>
        <span className="pill">LOCAL ONLY</span>
      </header>

      <section className="hero">
        <div><p className="eyebrow">DRIVING ASSISTANT</p><h2>Kiểm tra trước khi lăn bánh.</h2><p className="muted">GPS foreground và cảnh báo tốc độ thủ công.</p></div>
        {speeding && <div className="warning">Giảm tốc độ · đang vượt {speedLimit} km/h</div>}
      </section>

      <section className="grid">
        <div className="panel checklist">
          <div className="panel-heading"><h3>Điều kiện thiết bị</h3><span>4 mục</span></div>
          <CheckRow label="Đã cài vào màn hình chính" state={standalone ? 'ok' : 'blocked'} />
          <CheckRow label="Quyền truy cập GPS" state={gpsState} />
          <CheckRow label="Giữ màn hình sáng" state={wakeState} />
          <CheckRow label="Kết nối máy chủ local" state={serverState} />
          {!standalone && <p className="hint">Mở menu trình duyệt và chọn “Thêm vào Màn hình chính”.</p>}
        </div>

        <div className="panel speed-panel">
          <div className="panel-heading"><h3>Tốc độ hiện tại</h3><span>GPS</span></div>
          <div className={`speed ${speeding ? 'speed-danger' : ''}`}>{currentSpeed ?? '—'}<small> km/h</small></div>
          <label htmlFor="speed-limit">Ngưỡng cảnh báo</label>
          <div className="range-row"><input id="speed-limit" type="range" min="30" max="120" step="5" value={speedLimit} onChange={(event) => setSpeedLimit(Number(event.target.value))} /><output>{speedLimit} km/h</output></div>
          <p className="hint">Tốc độ đến từ GPS. Không phải giới hạn pháp lý.</p>
        </div>
      </section>

      <section className="panel map-panel">
        <div className="panel-heading"><h3>Bản đồ đoàn xe</h3><span>{position ? 'Đã có vị trí' : 'Chờ GPS'}</span></div>
        {mapsKey ? <div className="map" ref={mapRef} /> : <div className="map map-placeholder"><span>GOOGLE MAPS</span><p>Thêm `VITE_GOOGLE_MAPS_API_KEY` vào `.env.local` để bật bản đồ.</p></div>}
        {position && <div className="location-line"><span>● {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}</span><span>± {Math.round(position.accuracy)} m</span><span>{new Date(position.timestamp).toLocaleTimeString('vi-VN')}</span></div>}
      </section>

      <footer><span>Biển báo và giới hạn tốc độ: phase sau.</span><span>{error ?? 'Không dùng dữ liệu thật trong PoC.'}</span></footer>
    </main>
  );
}

function CheckRow({ label, state }: { label: string; state: CheckState }) {
  return <div className="check-row"><span className={`dot dot-${state}`} /> <span>{label}</span><strong>{statusLabel(state)}</strong></div>;
}

function sendPosition(socket: WebSocket, memberId: string, position: Position, speedKmh: number | null) {
  socket.send(JSON.stringify({
    type: 'location',
    memberId,
    latitude: position.latitude,
    longitude: position.longitude,
    accuracy: position.accuracy,
    speedKmh: speedKmh ?? undefined,
    recordedAt: new Date(position.timestamp).toISOString(),
  }));
}
