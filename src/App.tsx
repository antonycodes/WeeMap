import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, Map as MapLibreMap, Marker } from 'maplibre-gl';
import QRCode from 'qrcode';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getLatestCommit, hasNewerCommit, type BuildInfo } from './lib/appUpdate';
import { speedFromMetersPerSecond } from './lib/drivingAssistant';
import { distanceBetweenKm, isLiveLocationStale, parseLiveLocation, type LiveLocation } from './lib/liveLocation';
import { extractTripCode, isValidTripCode } from './lib/tripCode';
import { hasValidVehicleSet, parseVehicleCodes } from './lib/vehicleSlots';
import { BrowserQRCodeReader } from '@zxing/browser';

type CheckState = 'ok' | 'pending' | 'blocked';
type Position = { latitude: number; longitude: number; accuracy: number; speed: number | null; timestamp: number };
type TripSlot = { code: string; memberId?: string | null; claimed: boolean };
type TripInfo = { id: string; name: string; status: string; hasLeaderPassword?: boolean; slots?: TripSlot[] };
type TripMember = { memberId: string; displayName: string; joinedAt?: string };
type SignalIssue = TripMember & { issue: 'missing' | 'stale' };
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [mapZoom, setMapZoom] = useState(12);
  const [position, setPosition] = useState<Position | null>(null);
  const [destination, setDestination] = useState('');
  const [members, setMembers] = useState<Record<string, LiveLocation>>({});
  const [error, setError] = useState<string | null>(null);
  const [tripInput, setTripInput] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [leaderPassword, setLeaderPassword] = useState('');
  const [leaderUnlocked, setLeaderUnlocked] = useState(false);
  const [tripName, setTripName] = useState('Chuyến đi mới');
  const [selectedVehicleCode, setSelectedVehicleCode] = useState('XE-01');
  const [vehicleCount, setVehicleCount] = useState<number | ''>(2);
  const [vehicleCodesInput, setVehicleCodesInput] = useState('XE-01\nXE-02');
  const [memberReady, setMemberReady] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [tripInfo, setTripInfo] = useState<TripInfo | null>(null);
  const [roster, setRoster] = useState<TripMember[]>([]);
  const [tripBusy, setTripBusy] = useState(false);
  const [tripError, setTripError] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState('Chia sẻ');
  const [shareOpen, setShareOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tripSlots, setTripSlots] = useState<TripSlot[]>([]);
  const [signalCheckAt, setSignalCheckAt] = useState(() => Date.now());
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const watchId = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const mapInstance = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const colors = useRef<Map<string, string>>(new Map());
  const centeredOnPosition = useRef(false);
  const memberId = useRef(getStoredMemberId()).current;
  const mapRef = useRef<HTMLDivElement>(null);
  const scannerVideoRef = useRef<HTMLVideoElement>(null);
  const tripId = new URLSearchParams(window.location.search).get('trip');
  const shareUrl = tripId ? `${window.location.origin}${window.location.pathname}?trip=${encodeURIComponent(tripId)}` : '';

  const currentSpeed = useMemo(() => speedFromMetersPerSecond(position?.speed ?? null), [position]);
  const latestPosition = useRef(position);
  const latestSpeed = useRef(currentSpeed);
  latestPosition.current = position;
  latestSpeed.current = currentSpeed;
  const directionsUrl = position && destination.trim()
    ? `https://www.google.com/maps/dir/?api=1&origin=${position.latitude},${position.longitude}&destination=${encodeURIComponent(destination.trim())}&travelmode=driving`
    : undefined;
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
        displayName: selectedVehicleCode || 'Xe của bạn',
        latitude: position.latitude,
        longitude: position.longitude,
        accuracy: position.accuracy,
        speedKmh: currentSpeed ?? undefined,
        recordedAt: new Date(position.timestamp).toISOString(),
      },
    };
  }, [currentSpeed, memberId, members, position, selectedVehicleCode]);
  const displayedMembers = useMemo(() => {
    if (!tripSlots.length) return liveMembers;
    const allowedIds = new Set(roster.map((member) => member.memberId));
    return Object.fromEntries(Object.entries(liveMembers).filter(([id]) => id === memberId || allowedIds.has(id)));
  }, [liveMembers, memberId, roster, tripSlots.length]);

  const registerMember = async (id: string, vehicleCode: string) => {
    const tokenKey = `weemap-member-token:${id}`;
    const response = await fetch(`${workerOrigin}/api/trips/${id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, slotCode: vehicleCode.trim().toUpperCase(), memberToken: localStorage.getItem(tokenKey) }),
    });
    if (!response.ok) throw new Error(response.status === 409 ? 'Mã xe này đã được chọn.' : response.status === 403 ? 'Phiên xe đã hết quyền. Nhờ trưởng đoàn xóa xe cũ.' : 'Không đăng ký được mã xe.');
    const data = await response.json() as { memberToken?: string };
    if (data.memberToken) localStorage.setItem(tokenKey, data.memberToken);
  };

  const verifyLeaderPassword = async (id: string, password: string) => {
    const response = await fetch(`${workerOrigin}/api/trips/${id}/leader`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error(response.status === 403 ? 'Mật khẩu trưởng đoàn không đúng.' : 'Đoàn này chưa có mật khẩu trưởng đoàn.');
  };

  const createTrip = async () => {
    const requestedCode = customCode.trim();
    const vehicleCodes = parseVehicleCodes(vehicleCodesInput);
    const leaderVehicleCode = selectedVehicleCode.trim().toUpperCase();
    const requestedVehicleCount = vehicleCount === '' ? 0 : vehicleCount;
    if (!hasValidVehicleSet(vehicleCodes, requestedVehicleCount)) {
      setTripError(vehicleCount === '' ? 'Nhập số lượng xe từ 1 đến 20.' : `Nhập đúng ${vehicleCount} mã xe khác nhau. Mỗi mã tối đa 20 ký tự.`);
      return;
    }
    if (!vehicleCodes.includes(leaderVehicleCode)) {
      setTripError('Chọn mã xe của trưởng đoàn trong danh sách.');
      return;
    }
    if (leaderPassword.length < 8) {
      setTripError('Mật khẩu trưởng đoàn cần ít nhất 8 ký tự.');
      return;
    }
    if (requestedCode && !isValidTripCode(requestedCode)) {
      setTripError('Mã đoàn dùng 4–32 ký tự: chữ, số, gạch ngang hoặc gạch dưới.');
      return;
    }
    setTripBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: tripName.trim() || 'Chuyến đi mới',
          code: requestedCode || undefined,
          vehicleCodes,
          vehicleCode: leaderVehicleCode,
          memberId,
          leaderPassword,
        }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'Mã đoàn đã tồn tại. Chọn mã khác.' : 'Không tạo được chuyến đi.');
      const created = (await response.json()) as { id?: string; memberToken?: string };
      if (!created.id) throw new Error('Mã chuyến đi không hợp lệ.');
      localStorage.setItem(`weemap-vehicle:${created.id}`, leaderVehicleCode);
      if (created.memberToken) localStorage.setItem(`weemap-member-token:${created.id}`, created.memberToken);
      sessionStorage.setItem(`weemap-leader:${created.id}`, leaderPassword);
      window.location.assign(`${window.location.pathname}?trip=${encodeURIComponent(created.id)}`);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không tạo được chuyến đi.');
      setTripBusy(false);
    }
  };

  const joinTrip = async () => {
    const id = extractTripCode(tripInput);
    if (!isValidTripCode(id)) {
      setTripError('Nhập mã đoàn hoặc quét QR hợp lệ.');
      return;
    }
    setTripBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${id}`);
      if (!response.ok) throw new Error('Không tìm thấy chuyến đi.');
      window.location.assign(`${window.location.pathname}?trip=${encodeURIComponent(id)}`);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không tham gia được chuyến đi.');
      setTripBusy(false);
    }
  };

  const enterSharedTrip = async () => {
    if (!selectedVehicleCode || !tripId) {
      setTripError('Chọn mã xe để vào đoàn.');
      return;
    }
    setMemberBusy(true);
    setTripError(null);
    try {
      await registerMember(tripId, selectedVehicleCode);
      localStorage.setItem(`weemap-vehicle:${tripId}`, selectedVehicleCode);
      setTripSlots((previous) => previous.map((slot) => slot.code === selectedVehicleCode ? { ...slot, memberId, claimed: true } : slot));
      setRoster((previous) => previous.some((member) => member.memberId === memberId)
        ? previous.map((member) => member.memberId === memberId ? { ...member, displayName: selectedVehicleCode } : member)
        : [...previous, { memberId, displayName: selectedVehicleCode }]);
      setMemberReady(true);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không vào được đoàn.');
    } finally {
      setMemberBusy(false);
    }
  };

  const leaveTrip = async () => {
    if (!tripId) return;
    setMemberBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}/members`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requesterMemberId: memberId, targetMemberId: memberId, requesterToken: localStorage.getItem(`weemap-member-token:${tripId}`) }),
      });
      if (!response.ok) throw new Error('Không thể thoát đoàn.');
      localStorage.removeItem(`weemap-vehicle:${tripId}`);
      localStorage.removeItem(`weemap-member-token:${tripId}`);
      window.location.assign(window.location.pathname);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không thể thoát đoàn.');
      setMemberBusy(false);
    }
  };

  const unlockLeader = async () => {
    if (!tripId) return;
    setMemberBusy(true);
    setTripError(null);
    try {
      await verifyLeaderPassword(tripId, leaderPassword);
      setLeaderUnlocked(true);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không xác thực được trưởng đoàn.');
    } finally {
      setMemberBusy(false);
    }
  };

  const removeVehicle = async (targetMemberId: string) => {
    if (!tripId || !leaderUnlocked) return;
    setMemberBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}/members`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requesterMemberId: memberId, targetMemberId, leaderPassword }),
      });
      if (!response.ok) throw new Error('Không xóa được xe khỏi đoàn.');
      setRoster((previous) => previous.filter((member) => member.memberId !== targetMemberId));
      setTripSlots((previous) => previous.map((slot) => slot.memberId === targetMemberId ? { ...slot, memberId: null, claimed: false } : slot));
      if (targetMemberId === memberId) {
        localStorage.removeItem(`weemap-vehicle:${tripId}`);
        localStorage.removeItem(`weemap-member-token:${tripId}`);
        setSelectedVehicleCode('');
        setMemberReady(false);
      }
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không xóa được xe khỏi đoàn.');
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

  useEffect(() => {
    if (!scannerOpen || !scannerVideoRef.current) return;
    const reader = new BrowserQRCodeReader();
    let controls: { stop: () => void } | undefined;
    let disposed = false;
    void reader.decodeFromVideoDevice(undefined, scannerVideoRef.current, (result) => {
      if (!result) return;
      const code = extractTripCode(result.getText());
      if (!isValidTripCode(code)) {
        setScanError('QR không chứa mã đoàn WeeMap.');
        return;
      }
      setTripInput(code);
      setScanError(null);
      setScannerOpen(false);
      controls?.stop();
    }).then((nextControls) => {
      if (disposed) nextControls.stop();
      else controls = nextControls;
    }).catch(() => {
      setScanError('Không mở được camera. Hãy cho phép camera hoặc nhập mã thủ công.');
    });
    return () => {
      disposed = true;
      controls?.stop();
    };
  }, [scannerOpen]);

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
        const tripData = (await tripResponse.json()) as TripInfo & { has_leader_password?: boolean };
        const trip: TripInfo = { ...tripData, hasLeaderPassword: Boolean(tripData.has_leader_password) };
        if (cancelled) return;
        setTripInfo(trip);
        const slots = trip.slots ?? [];
        setTripSlots(slots);
        const savedVehicleCode = localStorage.getItem(`weemap-vehicle:${tripId}`) ?? '';
        const savedSlot = slots.find((slot) => slot.code === savedVehicleCode);
        setSelectedVehicleCode(savedSlot && (!savedSlot.memberId || savedSlot.memberId === memberId) ? savedVehicleCode : '');
        if (savedSlot && (!savedSlot.memberId || savedSlot.memberId === memberId)) {
          await registerMember(tripId, savedVehicleCode);
          if (!cancelled) setMemberReady(true);
        } else if (savedVehicleCode) {
          if (!cancelled) setTripError(`Mã xe ${savedVehicleCode} đang được giữ bởi phiên khác. Bấm “Thoát đoàn” để trả mã xe này.`);
        }
        const membersResponse = await fetch(`${workerOrigin}/api/trips/${tripId}/members`, { signal: controller.signal });
        if (!membersResponse.ok) throw new Error('Không tải được danh sách xe.');
        const data = (await membersResponse.json()) as { members?: Array<{ member_id: string; display_name: string; joined_at?: string }> };
        if (!cancelled) {
          const nextRoster = (data.members ?? []).map((member) => ({ memberId: member.member_id, displayName: member.display_name, joinedAt: member.joined_at }));
          setRoster(nextRoster);
          nextRoster.forEach((member) => getVehicleColor(member.memberId));
        }
        const initialPassword = sessionStorage.getItem(`weemap-leader:${tripId}`);
        if (initialPassword) {
          sessionStorage.removeItem(`weemap-leader:${tripId}`);
          await verifyLeaderPassword(tripId, initialPassword);
          if (!cancelled) {
            setLeaderPassword(initialPassword);
            setLeaderUnlocked(true);
          }
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
    let active = true;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    const connect = () => {
      const nextSocket = new WebSocket(`${socketOrigin}/ws/${tripId}`);
      socket.current = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (!active) return;
        reconnectAttempt = 0;
        setServerState('ok');
        const position = latestPosition.current;
        if (position) sendPosition(nextSocket, memberId, selectedVehicleCode, position, latestSpeed.current);
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
      nextSocket.addEventListener('close', () => {
        if (!active) return;
        setServerState('pending');
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** Math.min(reconnectAttempt++, 4), 15_000));
      });
    };
    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket.current?.close();
      socket.current = null;
    };
  }, [memberReady, selectedVehicleCode, tripId]);

  useEffect(() => {
    if (!tripId) return;
    const timer = window.setInterval(() => setSignalCheckAt(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [tripId]);

  useEffect(() => {
    if (socket.current?.readyState === WebSocket.OPEN && position) {
      sendPosition(socket.current, memberId, selectedVehicleCode, position, currentSpeed);
    }
  }, [position, currentSpeed, memberId, selectedVehicleCode]);

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
    const activeIds = new Set(Object.keys(displayedMembers));
    for (const [id, location] of Object.entries(displayedMembers)) {
      const isCurrent = id === memberId;
      const displayName = location.displayName ?? roster.find((member) => member.memberId === id)?.displayName ?? `Xe ${id.slice(0, 4)}`;
      const color = getVehicleColor(id);
      let marker = markers.current.get(id);
      if (!marker) {
        marker = new Marker({ element: createVehicleMarker(isCurrent, id, displayName, color), anchor: 'bottom' }).setLngLat([location.longitude, location.latitude]).addTo(map);
        markers.current.set(id, marker);
      } else {
        marker.setLngLat([location.longitude, location.latitude]);
      }
      updateVehicleMarker(marker.getElement(), displayName, color, location.speedKmh);
    }
    for (const [id, marker] of markers.current) {
      if (!activeIds.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [displayedMembers, memberId, roster]);

  const vehicleList = useMemo(() => {
    if (tripSlots.length) {
      return tripSlots.map((slot) => {
        const member = roster.find((candidate) => candidate.displayName === slot.code);
        return { memberId: slot.memberId ?? member?.memberId ?? `slot:${slot.code}`, displayName: slot.code, joinedAt: member?.joinedAt };
      });
    }
    const list = [...roster];
    for (const location of Object.values(displayedMembers)) {
      if (!list.some((member) => member.memberId === location.memberId)) {
        list.push({ memberId: location.memberId, displayName: location.displayName ?? `Xe ${location.memberId.slice(0, 4)}` });
      }
    }
    return list;
  }, [displayedMembers, roster, tripSlots]);
  const signalIssueVehicles = useMemo<SignalIssue[]>(() => vehicleList.flatMap((vehicle): SignalIssue[] => {
    if (vehicle.memberId.startsWith('slot:') || vehicle.memberId === memberId) return [];
    const location = displayedMembers[vehicle.memberId];
    if (!location) return [{ ...vehicle, issue: 'missing' as const }];
    return isLiveLocationStale(location.recordedAt, signalCheckAt) ? [{ ...vehicle, issue: 'stale' as const }] : [];
  }), [displayedMembers, memberId, signalCheckAt, vehicleList]);

  return (
    <main className="map-shell">
      <section className="map-stage" aria-label="Bản đồ WeeMap">
        <div className="map" ref={mapRef} />

        <header className="map-toolbar">
          <div className="brand-lockup"><span className="brand-dot" /> <strong>WeeMap</strong><span className="trip-label">{tripId ? 'Đang theo đoàn' : 'Bản đồ nhóm'}</span></div>
          <button className="round-button" type="button" aria-label={panelOpen ? 'Đóng thiết lập chuyến đi' : 'Mở thiết lập chuyến đi'} onClick={() => setPanelOpen((open) => !open)}><img src="/icons/settings.png" alt="" /></button>
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
          {signalIssueVehicles.length > 0 && <span className="map-signal-warning" role="alert">{signalIssueVehicles.length} xe cần kiểm tra GPS</span>}
        </div>

        <div className={`map-controls${panelOpen ? '' : ' map-controls-full'}`} aria-label="Điều khiển bản đồ">
          <button className="map-control" type="button" aria-label="Phóng to" onClick={() => { const nextZoom = Math.min(20, mapZoom + 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>+</button>
          <button className="map-control" type="button" aria-label="Thu nhỏ" onClick={() => { const nextZoom = Math.max(4, mapZoom - 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>−</button>
          <button className="map-control locate-control" type="button" aria-label="Vị trí hiện tại" disabled={!position} onClick={() => position && mapInstance.current?.flyTo({ center: [position.longitude, position.latitude], zoom: Math.max(mapZoom, 15) })}><img src="/icons/navigator.png" alt="" /></button>
          <button className="map-control refresh-control" type="button" aria-label="Làm mới dữ liệu" onClick={() => window.location.reload()}>↻</button>
        </div>

        {panelOpen && <div className="map-sheet" role="dialog" aria-label="Thiết lập chuyến đi">
          <div className="sheet-heading"><div><span className="eyebrow">CHUYẾN ĐI</span><h1>{tripId ? tripInfo?.name ?? 'Đoàn xe đang chạy' : 'Bản đồ của bạn'}</h1></div><span className={`connection-pill connection-${serverState}`}>{serverState === 'ok' ? 'Trực tuyến' : 'PoC'}</span></div>
          <div className="driving-row">
            <div><span className="metric-label">Xe trong đoàn</span><strong>{Object.keys(displayedMembers).length} <small>xe</small></strong></div>
            {position && <span className="last-seen">{new Date(position.timestamp).toLocaleTimeString('vi-VN')}</span>}
          </div>
          {signalIssueVehicles.length > 0 && <div className="signal-alert" role="alert"><span className="signal-alert-dot" aria-hidden="true" /><div><strong>GPS xe cần kiểm tra</strong><span>{signalIssueVehicles.map((vehicle) => `${vehicle.displayName} · ${vehicle.issue === 'missing' ? 'chưa có tín hiệu' : 'mất tín hiệu'}`).join('  ·  ')}</span></div></div>}
          <form className="destination-row" onSubmit={(event) => { event.preventDefault(); if (directionsUrl) window.open(directionsUrl, '_blank', 'noopener,noreferrer'); }}>
            <input className="trip-input" value={destination} onChange={(event) => setDestination(event.target.value)} aria-label="Điểm đến" placeholder="Nhập địa chỉ hoặc địa điểm cần đến" />
            <button className="trip-button" type="submit" disabled={!directionsUrl}>Dẫn đường</button>
          </form>
          {tripId ? <><div className="trip-room"><span>Mã đoàn: <strong>{tripId}</strong></span><div className="trip-room-actions"><button className="trip-button trip-button-soft" type="button" onClick={() => setShareOpen(true)}>Chia sẻ</button><button className="trip-button trip-button-danger" type="button" disabled={memberBusy} onClick={() => void leaveTrip()}>Thoát đoàn</button></div></div><div className="trip-entry"><strong>{leaderUnlocked ? 'Quyền trưởng đoàn đã mở' : 'Quản lý đoàn'}</strong>{tripInfo?.hasLeaderPassword === false ? <p className="trip-error" role="status">Đoàn được tạo trước tính năng mật khẩu. Hãy tạo đoàn mới để dùng quyền trưởng đoàn.</p> : !leaderUnlocked && <div className="trip-entry-row"><input className="trip-input" type="password" minLength={8} maxLength={64} value={leaderPassword} onChange={(event) => setLeaderPassword(event.target.value)} aria-label="Mật khẩu trưởng đoàn" placeholder="Nhập mật khẩu trưởng đoàn" /><button className="trip-button" type="button" disabled={memberBusy || !leaderPassword} onClick={() => void unlockLeader()}>Mở quyền</button></div>}{tripError && <p className="trip-error" role="alert">{tripError}</p>}</div>{!memberReady && <div className="trip-entry"><strong>Chọn mã xe để vào đoàn</strong><div className="trip-entry-row"><select className="trip-input" value={selectedVehicleCode} onChange={(event) => setSelectedVehicleCode(event.target.value)} aria-label="Mã xe"><option value="">Chọn xe</option>{tripSlots.map((slot) => <option key={slot.code} value={slot.code} disabled={slot.claimed && slot.memberId !== memberId}>{slot.code}{slot.claimed ? ' · đã chọn' : ''}</option>)}</select><button className="trip-button" type="button" disabled={memberBusy || !selectedVehicleCode} onClick={() => void enterSharedTrip()}>{memberBusy ? 'Đang vào…' : 'Vào đoàn'}</button></div></div>}{shareOpen && <div className="share-box" role="dialog" aria-label="Chia sẻ chuyến đi"><div className="share-heading"><strong>Mời xe vào đoàn</strong><button type="button" className="share-close" aria-label="Đóng" onClick={() => setShareOpen(false)}>×</button></div>{qrDataUrl ? <img className="share-qr" src={qrDataUrl} alt="Mã QR tham gia WeeMap" /> : <div className="share-qr share-qr-placeholder">Đang tạo QR…</div>}<span className="share-link">{shareUrl}</span><button className="trip-button" type="button" onClick={() => void copyTripLink()}>{shareStatus}</button></div>}<div className="vehicle-list"><div className="vehicle-list-heading"><strong>Xe trong đoàn</strong><span>{vehicleList.length}</span></div>{vehicleList.map((vehicle) => <div className="vehicle-row" key={vehicle.memberId}><span className="vehicle-swatch" style={{ backgroundColor: getVehicleColor(vehicle.memberId) }} /><span className="vehicle-name">{vehicle.displayName}</span><span className="vehicle-distance">{vehicle.memberId === memberId ? 'Bạn' : position && displayedMembers[vehicle.memberId] ? formatDistance(distanceBetweenKm(position, displayedMembers[vehicle.memberId]!)) : '—'}</span><span className="vehicle-state">{vehicle.memberId.startsWith('slot:') ? 'Chưa chọn' : displayedMembers[vehicle.memberId] ? 'Đang chạy' : 'Đã vào'}</span>{leaderUnlocked && !vehicle.memberId.startsWith('slot:') && <button className="trip-button trip-button-danger" type="button" disabled={memberBusy} onClick={() => void removeVehicle(vehicle.memberId)}>Xóa xe</button>}</div>)}</div></> : <div className="trip-setup"><input className="trip-input" value={tripName} onChange={(event) => setTripName(event.target.value)} aria-label="Tên chuyến đi" placeholder="Tên chuyến đi" /><input className="trip-input" value={customCode} onChange={(event) => setCustomCode(event.target.value.toUpperCase())} aria-label="Mã đoàn tuỳ chọn" placeholder="Mã đoàn tuỳ chọn (không bắt buộc)" maxLength={32} /><div className="vehicle-count-row"><label htmlFor="vehicle-count">Số lượng xe</label><input id="vehicle-count" className="trip-input" type="number" min="1" max="20" value={vehicleCount} onChange={(event) => { const value = event.target.value; setVehicleCount(value === '' ? '' : Math.min(20, Math.max(1, Number(value)))); }} /></div><textarea className="trip-input vehicle-code-editor" value={vehicleCodesInput} onChange={(event) => setVehicleCodesInput(event.target.value)} aria-label="Mã xe" placeholder="Mỗi dòng một mã xe: XE-01\nXE-02" /><select className="trip-input" value={selectedVehicleCode} onChange={(event) => setSelectedVehicleCode(event.target.value)} aria-label="Mã xe của trưởng đoàn"><option value="">Chọn mã xe của bạn</option>{parseVehicleCodes(vehicleCodesInput).map((code) => <option key={code} value={code}>{code}</option>)}</select><input className="trip-input" type="password" minLength={8} maxLength={64} value={leaderPassword} onChange={(event) => setLeaderPassword(event.target.value)} aria-label="Mật khẩu trưởng đoàn" placeholder="Mật khẩu trưởng đoàn (ít nhất 8 ký tự)" /><div className="trip-actions"><button className="trip-button" type="button" disabled={tripBusy} onClick={() => void createTrip()}>{tripBusy ? 'Đang tạo…' : 'Tạo đoàn mới'}</button><div className="trip-code-group"><input className="trip-input trip-code-input" value={tripInput} onChange={(event) => setTripInput(event.target.value)} aria-label="Mã chuyến đi hoặc liên kết" placeholder="Nhập mã đoàn" /><button className="trip-button trip-button-soft trip-scan-button" type="button" disabled={tripBusy} onClick={() => { setScanError(null); setScannerOpen(true); }}>QR</button></div><button className="trip-button trip-button-soft" type="button" disabled={tripBusy} onClick={() => void joinTrip()}>Tham gia</button></div>{tripError && <p className="trip-error" role="alert">{tripError}</p>}</div>}
          <div className="app-status"><p>{standalone ? 'Đã cài trên màn hình chính.' : 'Thêm app vào màn hình chính để dùng ổn định hơn.'} {wakeState === 'ok' ? 'Màn hình đang được giữ sáng.' : 'Màn hình chưa được giữ sáng.'}</p></div>
          <div className="sheet-footer"><span>{tripId ? `${Object.keys(displayedMembers).length}/${tripSlots.length || '—'} xe đang chia sẻ vị trí` : position ? `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}` : error ?? 'Bật GPS để bắt đầu'}</span><span>Biển báo · phase sau</span></div>
        </div>}
        {scannerOpen && <div className="qr-scanner" role="dialog" aria-label="Quét mã QR"><div className="qr-scanner-card"><div className="share-heading"><strong>Quét mã đoàn</strong><button type="button" className="share-close" aria-label="Đóng" onClick={() => setScannerOpen(false)}>×</button></div><video ref={scannerVideoRef} autoPlay muted playsInline /><p>Đưa mã QR tham gia WeeMap vào khung hình.</p>{scanError && <p className="trip-error" role="alert">{scanError}</p>}</div></div>}
      </section>
    </main>
  );
}

function getStoredMemberId(): string {
  const key = 'weemap-member-id';
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function createVehicleMarker(isCurrent: boolean, memberId: string, displayName: string, color: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `vehicle-marker${isCurrent ? ' vehicle-marker-current' : ''}`;
  element.style.setProperty('--vehicle-color', color);
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', isCurrent ? `Vị trí của ${displayName}` : displayName);
  element.dataset.label = displayName;
  const label = document.createElement('span');
  label.className = 'vehicle-marker-label';
  const pin = document.createElement('span');
  pin.className = 'vehicle-pin';
  pin.setAttribute('aria-hidden', 'true');
  element.append(label, pin);
  return element;
}

function updateVehicleMarker(element: HTMLElement, displayName: string, color: string, speedKmh?: number): void {
  element.style.setProperty('--vehicle-color', color);
  const label = element.querySelector<HTMLElement>('.vehicle-marker-label');
  if (label) label.textContent = displayName;
  element.title = `${displayName} · ${speedKmh === undefined ? '—' : `${Math.round(speedKmh)} km/h`}`;
}

function formatDistance(distanceKm: number): string {
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`;
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
