import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLatestCommit, hasNewerCommit, type BuildInfo } from './lib/appUpdate';
import { DEFAULT_SPEED_LIMIT, isOverSpeedLimit, speedFromMetersPerSecond } from './lib/drivingAssistant';
import { loadGoogleMaps } from './lib/googleMaps';

type CheckState = 'ok' | 'pending' | 'blocked';
type Position = { latitude: number; longitude: number; accuracy: number; speed: number | null; timestamp: number };
type MapController = { setZoom: (zoom: number) => void; panTo: (center: { lat: number; lng: number }) => void };

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export default function App() {
  const [standalone, setStandalone] = useState(isStandalone);
  const [gpsState, setGpsState] = useState<CheckState>('pending');
  const [wakeState, setWakeState] = useState<CheckState>('pending');
  const [serverState, setServerState] = useState<CheckState>('pending');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mapZoom, setMapZoom] = useState(12);
  const [position, setPosition] = useState<Position | null>(null);
  const [speedLimit, setSpeedLimit] = useState(DEFAULT_SPEED_LIMIT);
  const [error, setError] = useState<string | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const watchId = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const mapInstance = useRef<MapController | null>(null);
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
    const controller = new AbortController();
    let timer: number | undefined;

    const checkForUpdate = async () => {
      try {
        const [buildResponse, latestCommit] = await Promise.all([
          fetch('/build-info.json', { cache: 'no-store', signal: controller.signal }),
          getLatestCommit(controller.signal),
        ]);
        if (!buildResponse.ok) throw new Error('build-info');
        const buildInfo = (await buildResponse.json()) as BuildInfo;
        if (hasNewerCommit(buildInfo, latestCommit)) setUpdateAvailable(true);
      } catch {
        // Update checks are optional. GPS and navigation must keep working offline.
      }
      timer = window.setTimeout(() => void checkForUpdate(), 10 * 60 * 1000);
    };

    void checkForUpdate();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
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
        mapInstance.current = new window.google.maps.Map(mapRef.current, { center, zoom: mapZoom, disableDefaultUI: true });
      })
      .catch(() => setError('Không tải được Google Maps. Kiểm tra key local.'));
  }, [mapsKey, mapZoom, position]);

  return (
    <main className="map-shell">
      <section className="map-stage" aria-label="Bản đồ WeeMap">
        {mapsKey ? <div className="map" ref={mapRef} /> : <div className="map map-placeholder"><span>WEE<span>MAP</span></span><p>Đang chờ kết nối bản đồ.</p></div>}

        <header className="map-toolbar">
          <div className="brand-lockup"><span className="brand-dot" /> <strong>WeeMap</strong><span className="trip-label">{tripId ? 'Đang theo đoàn' : 'Chưa vào đoàn'}</span></div>
          <button className="round-button" type="button" aria-label="Mở cài đặt" onClick={() => setSettingsOpen((open) => !open)}>•••</button>
        </header>

        {updateAvailable && (
          <div className="update-banner" role="status">
            <span>Có bản cập nhật mới.</span>
            <button type="button" onClick={() => window.location.reload()}>Tải lại</button>
          </div>
        )}

        <div className="map-status" aria-live="polite">
          <span className={`status-dot status-${gpsState}`} />
          <span>{position ? 'Đang định vị' : gpsState === 'blocked' ? 'GPS chưa sẵn sàng' : 'Đang tìm vị trí'}</span>
          {position && <small>± {Math.round(position.accuracy)} m</small>}
        </div>

        {position && <div className="location-marker" aria-label="Vị trí hiện tại"><span /></div>}

        <div className="map-controls" aria-label="Điều khiển bản đồ">
          <button className="map-control" type="button" aria-label="Phóng to" disabled={!mapsKey} onClick={() => { const nextZoom = Math.min(20, mapZoom + 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>+</button>
          <button className="map-control" type="button" aria-label="Thu nhỏ" disabled={!mapsKey} onClick={() => { const nextZoom = Math.max(4, mapZoom - 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>−</button>
          <button className="map-control locate-control" type="button" aria-label="Vị trí hiện tại" disabled={!mapsKey || !position} onClick={() => position && mapInstance.current?.panTo({ lat: position.latitude, lng: position.longitude })}>⌖</button>
        </div>

        <div className="map-sheet">
          {speeding && <div className="speed-alert" role="alert">Giảm tốc độ · trên {speedLimit} km/h</div>}
          <div className="sheet-heading"><div><span className="eyebrow">CHUYẾN ĐI</span><h1>{tripId ? 'Đoàn xe đang chạy' : 'Bản đồ của bạn'}</h1></div><span className={`connection-pill connection-${serverState}`}>{serverState === 'ok' ? 'Trực tuyến' : 'PoC'}</span></div>
          <div className="driving-row">
            <div><span className="metric-label">Tốc độ hiện tại</span><strong className={speeding ? 'speed-danger' : ''}>{currentSpeed ?? '—'} <small>km/h</small></strong></div>
            <div className="driving-divider" />
            <div><span className="metric-label">Cảnh báo ở</span><strong>{speedLimit} <small>km/h</small></strong></div>
            {position && <span className="last-seen">{new Date(position.timestamp).toLocaleTimeString('vi-VN')}</span>}
          </div>
          {settingsOpen && <div className="settings-panel"><label htmlFor="speed-limit">Ngưỡng cảnh báo</label><div className="range-row"><input id="speed-limit" type="range" min="30" max="120" step="5" value={speedLimit} onChange={(event) => setSpeedLimit(Number(event.target.value))} /><output>{speedLimit} km/h</output></div><p>{standalone ? 'Đã cài trên màn hình chính.' : 'Thêm app vào màn hình chính để dùng ổn định hơn.'} {wakeState === 'ok' ? 'Màn hình đang được giữ sáng.' : 'Màn hình chưa được giữ sáng.'}</p></div>}
          <div className="sheet-footer"><span>{position ? `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}` : error ?? 'Bật GPS để bắt đầu'}</span><span>Biển báo · phase sau</span></div>
        </div>
      </section>
    </main>
  );
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