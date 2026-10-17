import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, Map as MapLibreMap, Marker } from 'maplibre-gl';
import QRCode from 'qrcode';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getLatestCommit, hasNewerCommit, type BuildInfo } from './lib/appUpdate';
import { DEFAULT_SPEED_LIMIT, isOverSpeedLimit, speedFromMetersPerSecond } from './lib/drivingAssistant';
import { parseLiveLocation, type LiveLocation } from './lib/liveLocation';

type CheckState = 'ok' | 'pending' | 'blocked';
type Position = { latitude: number; longitude: number; accuracy: number; speed: number | null; timestamp: number };
type TripInfo = { id: string; name: string; status: string };
type TripMember = { memberId: string; displayName: string; joinedAt?: string };
const VEHICLE_COLORS = ['#39794b', '#3f78b5', '#a7652d', '#8a4f9f', '#bd4e65', '#16828a', '#6d6b2f', '#c34f2d'];

const workerOrigin = (import.meta.env.VITE_WORKER_ORIGIN
  ?? (import.meta.env.DEV ? window.location.origin : 'https://group-navigation-local.eventnpi2026.workers.dev')).replace(/\/$/, '');

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
  const [members, setMembers] = useState<Record<string, LiveLocation>>({});
  const [speedLimit, setSpeedLimit] = useState(DEFAULT_SPEED_LIMIT);
  const [error, setError] = useState<string | null>(null);
  const [tripInput, setTripInput] = useState('');
  const [tripName, setTripName] = useState('Chuyến đi mới');
  const [memberName, setMemberName] = useState('');
  const [memberReady, setMemberReady] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [tripInfo, setTripInfo] = useState<TripInfo | null>(null);
  const [roster, setRoster] = useState<TripMember[]>([]);
  const [tripBusy, setTripBusy] = useState(false);
  const [tripError, setTripError] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState('Chia sẻ');
  const [shareOpen, setShareOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const watchId = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const mapInstance = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const colors = useRef<Map<string, string>>(new Map());
  const centeredOnPosition = useRef(false);
  const memberId = useRef(crypto.randomUUID()).current;
  const mapRef = useRef<HTMLDivElement>(null);
  const tripId = new URLSearchParams(window.location.search).get('trip');
  const shareUrl = tripId ? `${window.location.origin}${window.location.pathname}?trip=${encodeURIComponent(tripId)}` : '';

  const currentSpeed = useMemo(() => speedFromMetersPerSecond(position?.speed ?? null), [position]);
  const speeding = isOverSpeedLimit(currentSpeed, speedLimit);
  const getVehicleColor = (id: string) => {
    const existing = colors.current.get(id);
    if (existing) return existing;
    const color = VEHICLE_COLORS[colors.current.size % VEHICLE_COLORS.length];
    colors.current.set(id, color);
    return color;
  };
  const liveMembers = useMemo(() => {
    if (!position) return members;
    return {
      ...members,
      [memberId]: {
        memberId,
        displayName: memberName || 'Xe của bạn',
        latitude: position.latitude,
        longitude: position.longitude,
        accuracy: position.accuracy,
        speedKmh: currentSpeed ?? undefined,
        recordedAt: new Date(position.timestamp).toISOString(),
      },
    };
  }, [currentSpeed, memberId, memberName, members, position]);

  const registerMember = async (id: string, name: string) => {
    const response = await fetch(`${workerOrigin}/api/trips/${id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, displayName: name.trim() }),
    });
    if (!response.ok) throw new Error('Không đăng ký được tên xe.');
  };

  const createTrip = async () => {
    const vehicleName = memberName.trim();
    if (!vehicleName) {
      setTripError('Đặt tên xe trước khi tạo chuyến đi.');
      return;
    }
    setTripBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: tripName.trim() || 'Chuyến đi mới' }),
      });
      if (!response.ok) throw new Error('Không tạo được chuyến đi.');
      const created = (await response.json()) as { id?: string };
      if (!created.id) throw new Error('Mã chuyến đi không hợp lệ.');
      localStorage.setItem(`weemap-member:${created.id}`, vehicleName);
      window.location.assign(`${window.location.pathname}?trip=${encodeURIComponent(created.id)}`);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không tạo được chuyến đi.');
      setTripBusy(false);
    }
  };

  const joinTrip = async () => {
    const id = tripInput.trim();
    const vehicleName = memberName.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setTripError('Nhập đúng mã chuyến đi 36 ký tự.');
      return;
    }
    if (!vehicleName) {
      setTripError('Đặt tên xe trước khi tham gia.');
      return;
    }
    setTripBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${id}`);
      if (!response.ok) throw new Error('Không tìm thấy chuyến đi.');
      await registerMember(id, vehicleName);
      localStorage.setItem(`weemap-member:${id}`, vehicleName);
      window.location.assign(`${window.location.pathname}?trip=${encodeURIComponent(id)}`);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không tham gia được chuyến đi.');
      setTripBusy(false);
    }
  };

  const enterSharedTrip = async () => {
    const vehicleName = memberName.trim();
    if (!vehicleName || !tripId) {
      setTripError('Đặt tên xe trước khi vào đoàn.');
      return;
    }
    setMemberBusy(true);
    setTripError(null);
    try {
      await registerMember(tripId, vehicleName);
      localStorage.setItem(`weemap-member:${tripId}`, vehicleName);
      setMemberReady(true);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không vào được đoàn.');
    } finally {
      setMemberBusy(false);
    }
  };

  const copyTripLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareStatus('Đã sao chép');
    } catch {
      setShareStatus('Không sao chép được');
    }
  };

  useEffect(() => {
    if (!shareOpen || !shareUrl) {
      setQrDataUrl('');
      return;
    }
    let active = true;
    void QRCode.toDataURL(shareUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [shareOpen, shareUrl]);

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
    if (!tripId) {
      setMemberReady(true);
      return;
    }
    let cancelled = false;
    const loadTrip = async () => {
      try {
        const tripResponse = await fetch(`${workerOrigin}/api/trips/${tripId}`, { signal: controller.signal });
        if (!tripResponse.ok) throw new Error('Không tìm thấy chuyến đi.');
        const trip = (await tripResponse.json()) as TripInfo;
        if (cancelled) return;
        setTripInfo(trip);
        const savedName = localStorage.getItem(`weemap-member:${tripId}`) ?? '';
        if (savedName) {
          setMemberName(savedName);
          await registerMember(tripId, savedName);
          if (!cancelled) setMemberReady(true);
        }
        const membersResponse = await fetch(`${workerOrigin}/api/trips/${tripId}/members`, { signal: controller.signal });
        if (!membersResponse.ok) throw new Error('Không tải được danh sách xe.');
        const data = (await membersResponse.json()) as { members?: Array<{ member_id: string; display_name: string; joined_at?: string }> };
        if (!cancelled) {
          const nextRoster = (data.members ?? []).map((member) => ({ memberId: member.member_id, displayName: member.display_name, joinedAt: member.joined_at }));
          setRoster(nextRoster);
          nextRoster.forEach((member) => getVehicleColor(member.memberId));
        }
      } catch (nextError) {
        if (!cancelled) setTripError(nextError instanceof Error ? nextError.message : 'Không tải được chuyến đi.');
      }
    };
    const controller = new AbortController();
    void loadTrip();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [tripId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${workerOrigin}/api/health`)
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
    if (!tripId || !memberReady) return;
    const socketOrigin = workerOrigin.replace(/^http/, 'ws');
    const nextSocket = new WebSocket(`${socketOrigin}/ws/${tripId}`);
    socket.current = nextSocket;
    nextSocket.addEventListener('open', () => {
      setServerState('ok');
      if (position) sendPosition(nextSocket, memberId, memberName, position, currentSpeed);
    });
    nextSocket.addEventListener('message', (event) => {
      try {
        const location = parseLiveLocation(JSON.parse(event.data) as unknown);
        if (location) {
          setMembers((previous) => ({ ...previous, [location.memberId]: location }));
          setRoster((previous) => previous.some((member) => member.memberId === location.memberId)
            ? previous.map((member) => member.memberId === location.memberId && location.displayName ? { ...member, displayName: location.displayName } : member)
            : [...previous, { memberId: location.memberId, displayName: location.displayName ?? `Xe ${location.memberId.slice(0, 4)}` }]);
          getVehicleColor(location.memberId);
        }
      } catch {
        // Ignore malformed room messages.
      }
    });
    nextSocket.addEventListener('error', () => setServerState('blocked'));
    return () => {
      nextSocket.close();
      socket.current = null;
    };
  }, [memberReady, tripId]);

  useEffect(() => {
    if (socket.current?.readyState === WebSocket.OPEN && position) {
      sendPosition(socket.current, memberId, memberName, position, currentSpeed);
    }
  }, [position, currentSpeed, memberId, memberName]);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const map = new MapLibreMap({
      container: mapRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            // shortcut: public OSM tiles are for the PoC; switch provider before production traffic.
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [106.7009, 10.7769],
      zoom: mapZoom,
      attributionControl: false,
    });
    map.addControl(new AttributionControl({ compact: true }), 'top-left');
    mapInstance.current = map;
    return () => {
      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  useEffect(() => {
    if (!position || !mapInstance.current || centeredOnPosition.current) return;
    centeredOnPosition.current = true;
    mapInstance.current.flyTo({ center: [position.longitude, position.latitude], zoom: Math.max(mapZoom, 15) });
  }, [mapZoom, position]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const activeIds = new Set(Object.keys(liveMembers));
    for (const [id, location] of Object.entries(liveMembers)) {
      const isCurrent = id === memberId;
      const displayName = location.displayName ?? roster.find((member) => member.memberId === id)?.displayName ?? `Xe ${id.slice(0, 4)}`;
      const color = getVehicleColor(id);
      let marker = markers.current.get(id);
      if (!marker) {
        marker = new Marker({ element: createVehicleMarker(isCurrent, id, displayName, color) }).setLngLat([location.longitude, location.latitude]).addTo(map);
        markers.current.set(id, marker);
      } else {
        marker.setLngLat([location.longitude, location.latitude]);
      }
      updateVehicleMarker(marker.getElement(), isCurrent, displayName, color, location.speedKmh);
    }
    for (const [id, marker] of markers.current) {
      if (!activeIds.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [liveMembers, memberId, roster]);

  const vehicleList = useMemo(() => {
    const list = [...roster];
    for (const location of Object.values(liveMembers)) {
      if (!list.some((member) => member.memberId === location.memberId)) {
        list.push({ memberId: location.memberId, displayName: location.displayName ?? `Xe ${location.memberId.slice(0, 4)}` });
      }
    }
    return list;
  }, [liveMembers, roster]);

  return (
    <main className="map-shell">
      <section className="map-stage" aria-label="Bản đồ WeeMap">
        <div className="map" ref={mapRef} />

        <header className="map-toolbar">
          <div className="brand-lockup"><span className="brand-dot" /> <strong>WeeMap</strong><span className="trip-label">{tripId ? 'Đang theo đoàn' : 'Bản đồ nhóm'}</span></div>
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

        <div className="map-controls" aria-label="Điều khiển bản đồ">
          <button className="map-control" type="button" aria-label="Phóng to" onClick={() => { const nextZoom = Math.min(20, mapZoom + 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>+</button>
          <button className="map-control" type="button" aria-label="Thu nhỏ" onClick={() => { const nextZoom = Math.max(4, mapZoom - 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>−</button>
          <button className="map-control locate-control" type="button" aria-label="Vị trí hiện tại" disabled={!position} onClick={() => position && mapInstance.current?.flyTo({ center: [position.longitude, position.latitude], zoom: Math.max(mapZoom, 15) })}>⌖</button>
        </div>

        <div className="map-sheet">
          {speeding && <div className="speed-alert" role="alert">Giảm tốc độ · trên {speedLimit} km/h</div>}
          <div className="sheet-heading"><div><span className="eyebrow">CHUYẾN ĐI</span><h1>{tripId ? tripInfo?.name ?? 'Đoàn xe đang chạy' : 'Bản đồ của bạn'}</h1></div><span className={`connection-pill connection-${serverState}`}>{serverState === 'ok' ? 'Trực tuyến' : 'PoC'}</span></div>
          <div className="driving-row">
            <div><span className="metric-label">Tốc độ hiện tại</span><strong className={speeding ? 'speed-danger' : ''}>{currentSpeed ?? '—'} <small>km/h</small></strong></div>
            <div className="driving-divider" />
            <div><span className="metric-label">Xe trong đoàn</span><strong>{Object.keys(liveMembers).length} <small>xe</small></strong></div>
            {position && <span className="last-seen">{new Date(position.timestamp).toLocaleTimeString('vi-VN')}</span>}
          </div>
          {tripId ? <><div className="trip-room"><span>Mã đoàn: <strong>{tripId}</strong></span><button className="trip-button trip-button-soft" type="button" onClick={() => setShareOpen(true)}>Chia sẻ</button></div>{!memberReady && <div className="trip-entry"><strong>Đặt tên xe để vào đoàn</strong><div className="trip-entry-row"><input className="trip-input" value={memberName} onChange={(event) => setMemberName(event.target.value)} aria-label="Tên xe" placeholder="Ví dụ: Xe Antony" maxLength={40} /><button className="trip-button" type="button" disabled={memberBusy} onClick={() => void enterSharedTrip()}>{memberBusy ? 'Đang vào…' : 'Vào đoàn'}</button></div></div>}{shareOpen && <div className="share-box" role="dialog" aria-label="Chia sẻ chuyến đi"><div className="share-heading"><strong>Mời xe vào đoàn</strong><button type="button" className="share-close" aria-label="Đóng" onClick={() => setShareOpen(false)}>×</button></div>{qrDataUrl ? <img className="share-qr" src={qrDataUrl} alt="Mã QR tham gia WeeMap" /> : <div className="share-qr share-qr-placeholder">Đang tạo QR…</div>}<span className="share-link">{shareUrl}</span><button className="trip-button" type="button" onClick={() => void copyTripLink()}>{shareStatus}</button></div>}<div className="vehicle-list"><div className="vehicle-list-heading"><strong>Xe trong đoàn</strong><span>{vehicleList.length}</span></div>{vehicleList.map((vehicle) => <div className="vehicle-row" key={vehicle.memberId}><span className="vehicle-swatch" style={{ backgroundColor: getVehicleColor(vehicle.memberId) }} /><span className="vehicle-name">{vehicle.displayName}</span><span className="vehicle-state">{liveMembers[vehicle.memberId] ? 'Đang chạy' : 'Đã vào'}</span></div>)}</div></> : <div className="trip-setup"><input className="trip-input" value={tripName} onChange={(event) => setTripName(event.target.value)} aria-label="Tên chuyến đi" placeholder="Tên chuyến đi" /><input className="trip-input" value={memberName} onChange={(event) => setMemberName(event.target.value)} aria-label="Tên xe" placeholder="Tên xe của bạn" maxLength={40} /><div className="trip-actions"><button className="trip-button" type="button" disabled={tripBusy} onClick={() => void createTrip()}>{tripBusy ? 'Đang tạo…' : 'Tạo đoàn mới'}</button><input className="trip-input trip-code-input" value={tripInput} onChange={(event) => setTripInput(event.target.value)} aria-label="Mã chuyến đi" placeholder="Dán mã đoàn" /><button className="trip-button trip-button-soft" type="button" disabled={tripBusy} onClick={() => void joinTrip()}>Tham gia</button></div>{tripError && <p className="trip-error" role="alert">{tripError}</p>}</div>}
          {settingsOpen && <div className="settings-panel"><label htmlFor="speed-limit">Ngưỡng cảnh báo</label><div className="range-row"><input id="speed-limit" type="range" min="30" max="120" step="5" value={speedLimit} onChange={(event) => setSpeedLimit(Number(event.target.value))} /><output>{speedLimit} km/h</output></div><p>{standalone ? 'Đã cài trên màn hình chính.' : 'Thêm app vào màn hình chính để dùng ổn định hơn.'} {wakeState === 'ok' ? 'Màn hình đang được giữ sáng.' : 'Màn hình chưa được giữ sáng.'}</p></div>}
          <div className="sheet-footer"><span>{tripId ? `${Object.keys(liveMembers).length} xe đang chia sẻ vị trí` : position ? `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}` : error ?? 'Bật GPS để bắt đầu'}</span><span>Biển báo · phase sau</span></div>
        </div>
      </section>
    </main>
  );
}

function createVehicleMarker(isCurrent: boolean, memberId: string, displayName: string, color: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `vehicle-marker${isCurrent ? ' vehicle-marker-current' : ''}`;
  element.style.setProperty('--vehicle-color', color);
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', isCurrent ? `Vị trí của ${displayName}` : displayName);
  element.dataset.label = displayName;
  return element;
}

function updateVehicleMarker(element: HTMLElement, isCurrent: boolean, displayName: string, color: string, speedKmh?: number): void {
  element.style.setProperty('--vehicle-color', color);
  element.textContent = isCurrent ? 'Bạn' : displayName;
  element.title = `${displayName} · ${speedKmh === undefined ? '—' : `${Math.round(speedKmh)} km/h`}`;
}

function sendPosition(socket: WebSocket, memberId: string, displayName: string, position: Position, speedKmh: number | null) {
  socket.send(JSON.stringify({
    type: 'location',
    memberId,
    displayName,
    latitude: position.latitude,
    longitude: position.longitude,
    accuracy: position.accuracy,
    speedKmh: speedKmh ?? undefined,
    recordedAt: new Date(position.timestamp).toISOString(),
  }));
}
