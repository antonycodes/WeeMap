import type { FeatureCollection } from 'geojson';
import { parseDestinationInput, parseDestinationTarget, type DestinationTarget } from './lib/destination';
import { getRouteProgress, parsePlannedRoute, type PlannedRoute } from './lib/plannedRoute';
import GoogleSignIn from './GoogleSignIn';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, Marker, LngLatBounds, type GeoJSONSource } from 'maplibre-gl';
import QRCode from 'qrcode';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getLatestCommit, hasNewerCommit, type BuildInfo } from './lib/appUpdate';
import { speedFromMetersPerSecond } from './lib/drivingAssistant';
import { distanceBetweenKm, isLiveLocationStale, parseLiveLocation, type LiveLocation } from './lib/liveLocation';
import { extractTripCode, isValidTripCode } from './lib/tripCode';
import { hasValidVehicleSet, isValidVehicleCode, parseVehicleCodes } from './lib/vehicleSlots';
import { BrowserQRCodeReader } from '@zxing/browser';
import { formatRouteEstimate, parseRouteEstimates, type RouteEstimates } from './lib/routeEstimate';
import { parseSharedRouteState } from './lib/routeState';
import { VoiceRoom, type VoiceRoomStatus } from './lib/voiceRoom';

type CheckState = 'ok' | 'pending' | 'blocked';
type Position = { latitude: number; longitude: number; accuracy: number; speed: number | null; timestamp: number };
type TripSlot = { code: string; memberId?: string | null; claimed: boolean };
type TripInfo = { id: string; name: string; status: string; hasGoogleLeader?: boolean; hasLeaderPassword?: boolean; slots?: TripSlot[] };
type TripMember = { memberId: string; displayName: string; joinedAt?: string };
type SignalIssue = TripMember & { issue: 'missing' | 'stale' };
type RouteTarget = DestinationTarget;
const VEHICLE_COLORS = ['#39794b', '#3f78b5', '#a7652d', '#8a4f9f', '#bd4e65', '#16828a', '#6d6b2f', '#c34f2d'];

const workerOrigin = (import.meta.env.VITE_WORKER_ORIGIN
  ?? (import.meta.env.DEV ? window.location.origin : 'https://group-navigation-local.eventnpi2026.workers.dev')).replace(/\/$/, '');

export default function App() {
  const [gpsState, setGpsState] = useState<CheckState>('pending');
  const [gpsRefreshing, setGpsRefreshing] = useState(false);
  const [serverState, setServerState] = useState<CheckState>('pending');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<'create' | 'join' | null>(null);
  const [mapZoom, setMapZoom] = useState(12);
  const [position, setPosition] = useState<Position | null>(null);
  const [destination, setDestination] = useState('');
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeTarget, setRouteTarget] = useState<RouteTarget | null>(null);
  const [plannedRoute, setPlannedRoute] = useState<PlannedRoute | null>(null);
  const [routeStarted, setRouteStarted] = useState(false);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState('');
  const routeRequest = useRef<AbortController | null>(null);
  const lastRerouteAt = useRef(0);
  const [members, setMembers] = useState<Record<string, LiveLocation>>({});
  const [error, setError] = useState<string | null>(null);
  const [tripInput, setTripInput] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [leaderPassword, setLeaderPassword] = useState('');
  const [leaderUnlocked, setLeaderUnlocked] = useState(false);
  const [googleToken, setGoogleToken] = useState(() => sessionStorage.getItem('weemap-google-token') ?? '');
  const [googleName, setGoogleName] = useState('');
  const [tripName, setTripName] = useState('Chuyến đi mới');
  const [selectedVehicleCode, setSelectedVehicleCode] = useState('XE-01');
  const [vehicleCount, setVehicleCount] = useState(2);
  const [vehicleCodeBoxes, setVehicleCodeBoxes] = useState(['XE-01', 'XE-02', 'XE-03', 'XE-04', 'XE-05']);
  const [newVehicleCode, setNewVehicleCode] = useState('');
  const [tripNameEdit, setTripNameEdit] = useState('');
  const [vehicleCodeToChange, setVehicleCodeToChange] = useState('');
  const [replacementVehicleCode, setReplacementVehicleCode] = useState('');
  const vehicleCodesInput = vehicleCodeBoxes.slice(0, vehicleCount).join('\n');
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
  const [routeEstimates, setRouteEstimates] = useState<RouteEstimates | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceRoomStatus>('idle');
  const [voiceError, setVoiceError] = useState('');
  const [speakingMembers, setSpeakingMembers] = useState<Record<string, boolean>>({});
  const [voiceCalls, setVoiceCalls] = useState<Record<string, boolean>>({});
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const watchId = useRef<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const voiceRoom = useRef<VoiceRoom | null>(null);
  const mapInstance = useRef<MapLibreMap | null>(null);
  const fittedRoute = useRef<PlannedRoute | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const colors = useRef<Map<string, string>>(new Map());
  const navigatorCycle = useRef({ key: '', index: 0 });
  const centeredOnPosition = useRef(false);
  const memberId = useRef(getStoredMemberId()).current;
  const mapRef = useRef<HTMLDivElement>(null);
  const scannerVideoRef = useRef<HTMLVideoElement>(null);
  const tripId = new URLSearchParams(window.location.search).get('trip');
  const shareUrl = tripId ? `${window.location.origin}${window.location.pathname}?trip=${encodeURIComponent(tripId)}` : '';

  const currentSpeed = useMemo(() => speedFromMetersPerSecond(position?.speed ?? null), [position]);
  const routeProgress = useMemo(
    () => plannedRoute && position ? getRouteProgress(plannedRoute, [position.longitude, position.latitude]) : null,
    [plannedRoute, position],
  );
  const latestPosition = useRef(position);
  const latestSpeed = useRef(currentSpeed);
  latestPosition.current = position;
  latestSpeed.current = currentSpeed;
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

  const navigatorPoints = useMemo(() => [
    ...Object.values(displayedMembers).map((location) => ({ id: `vehicle:${location.memberId}`, latitude: location.latitude, longitude: location.longitude })),
    ...(routeTarget ? [{ id: 'destination', latitude: routeTarget.latitude, longitude: routeTarget.longitude }] : []),
  ], [displayedMembers, routeTarget]);

  const clearPlannedRoute = () => {
    routeRequest.current?.abort();
    routeRequest.current = null;
    lastRerouteAt.current = 0;
    fittedRoute.current = null;
    setRouteBusy(false);
    setPlannedRoute(null);
    setRouteStarted(false);
    setRouteTarget(null);
    setRouteError('');
  };

  const requestRoute = useCallback(async (start: Position, target: RouteTarget, closeSheet: boolean, clearCurrent: boolean) => {
    routeRequest.current?.abort();
    const controller = new AbortController();
    routeRequest.current = controller;
    setRouteBusy(true);
    setRouteError('');
    if (clearCurrent) setPlannedRoute(null);
    try {
      const response = await fetch(`${workerOrigin}/api/directions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ start: [start.longitude, start.latitude], end: [target.longitude, target.latitude] }),
        signal: controller.signal,
      });
      const data: unknown = await response.json().catch(() => { throw new Error('Máy chủ chưa trả về lộ trình hợp lệ. Hãy thử lại sau.'); });
      if (!response.ok) {
        const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error.slice(0, 200) : 'Không tìm được lộ trình. Hãy thử lại sau.';
        throw new Error(message);
      }
      const route = parsePlannedRoute(data);
      if (!route) throw new Error('Dữ liệu lộ trình không hợp lệ.');
      if (!controller.signal.aborted) {
        lastRerouteAt.current = Date.now();
        setPlannedRoute(route);
        if (clearCurrent) setRouteStarted(false);
        if (closeSheet) setRouteOpen(false);
      }
    } catch (error) {
      if (!controller.signal.aborted) setRouteError(error instanceof Error ? error.message : 'Không tải được lộ trình.');
    } finally {
      if (routeRequest.current === controller) { routeRequest.current = null; setRouteBusy(false); }
    }
  }, []);

  const planRoute = async () => {
    setRouteError('');
    if (!position || isLiveLocationStale(new Date(position.timestamp).toISOString())) {
      setRouteError('Cần GPS mới để chọn điểm xuất phát.');
      return;
    }
    if (!routeTarget) {
      try {
        const input = parseDestinationInput(destination, position);
        if (!input) throw new Error('Nhập điểm đến trước khi tìm đường.');
        let target: RouteTarget | null = 'target' in input ? input.target : null;
        if (!target) {
          setRouteBusy(true);
          const response = await fetch(`${workerOrigin}/api/geocode`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'geocodeText' in input ? input.geocodeText : '', shortCode: 'shortCode' in input ? input.shortCode : undefined }),
          });
          const data: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error.slice(0, 200) : 'Không tìm thấy điểm đến.';
            throw new Error(message);
          }
          target = parseDestinationTarget(data);
          if (!target) throw new Error('Dữ liệu điểm đến không hợp lệ.');
        }
        setRouteTarget(target);
        mapInstance.current?.flyTo({ center: [target.longitude, target.latitude], zoom: 15 });
      } catch (error) { setRouteError(error instanceof Error ? error.message : 'Không xác định được điểm đến.'); }
      finally { setRouteBusy(false); }
      return;
    }
    await requestRoute(position, routeTarget, true, true);
  };

  const startRoute = async () => {
    if (!routeTarget) return;
    if (!tripId) {
      setRouteStarted(true);
      return;
    }
    if (!leaderUnlocked) return;
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}/route-state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}) },
        body: JSON.stringify({ target: routeTarget, leaderPassword: googleToken ? undefined : leaderPassword }),
      });
      if (!response.ok) throw new Error('Không thể bắt đầu lộ trình cho cả đoàn.');
      setRouteStarted(true);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : 'Không thể bắt đầu lộ trình.');
    }
  };

  useEffect(() => () => {
    routeRequest.current?.abort();
    fittedRoute.current = null;
  }, []);

  useEffect(() => {
    if (!routeStarted || !plannedRoute || !routeTarget || !position || routeBusy || !routeProgress?.offRoute) return;
    const now = Date.now();
    if (now - lastRerouteAt.current < 30_000) return;
    lastRerouteAt.current = now;
    void requestRoute(position, routeTarget, false, false);
  }, [plannedRoute, position, requestRoute, routeBusy, routeProgress, routeStarted, routeTarget]);

  useEffect(() => {
    if (!tripId || !routeStarted || !routeTarget || plannedRoute || !position || routeBusy) return;
    void requestRoute(position, routeTarget, false, false);
  }, [plannedRoute, position, requestRoute, routeBusy, routeStarted, routeTarget, tripId]);

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

  const signInGoogle = async (token: string) => {
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/auth/google`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Không xác minh được Google. Hãy đăng nhập lại.');
      const user = await response.json() as { name: string };
      sessionStorage.setItem('weemap-google-token', token);
      setGoogleToken(token);
      setGoogleName(user.name);
    } catch (error) {
      setTripError(error instanceof Error ? error.message : 'Không đăng nhập được Google.');
    }
  };

  const signOutGoogle = () => {
    sessionStorage.removeItem('weemap-google-token');
    setGoogleToken('');
    setGoogleName('');
    setLeaderUnlocked(false);
    window.google?.accounts.id.disableAutoSelect();
  };

  useEffect(() => {
    if (!googleToken) return;
    const controller = new AbortController();
    void fetch(`${workerOrigin}/api/auth/google`, { method: 'POST', headers: { Authorization: `Bearer ${googleToken}` }, signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { signOutGoogle(); return; }
        if (!response.ok) throw new Error('Google unavailable');
        const user = await response.json() as { name: string };
        if (!controller.signal.aborted) setGoogleName(user.name);
        if (tripId) {
          const access = await fetch(`${workerOrigin}/api/trips/${tripId}/leader`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${googleToken}` }, body: '{}', signal: controller.signal });
          if (!controller.signal.aborted) setLeaderUnlocked(access.ok);
        }
      }).catch(() => { /* Keep current session during temporary network failures. */ });
    return () => controller.abort();
  }, [googleToken, tripId]);

  const createTrip = async () => {
    if (!googleToken) { setTripError('Đăng nhập Google trước khi tạo chuyến.'); return; }
    const requestedCode = customCode.trim();
    const vehicleCodes = parseVehicleCodes(vehicleCodesInput);
    const leaderVehicleCode = selectedVehicleCode.trim().toUpperCase();
    const requestedVehicleCount = vehicleCount;
    if (!hasValidVehicleSet(vehicleCodes, requestedVehicleCount)) {
      setTripError(`Nhập đúng ${vehicleCount} mã xe khác nhau. Mỗi mã tối đa 20 ký tự.`);
      return;
    }
    if (!vehicleCodes.includes(leaderVehicleCode)) {
      setTripError('Chọn mã xe của trưởng đoàn trong danh sách.');
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
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${googleToken}` },
        body: JSON.stringify({
          name: tripName.trim() || 'Chuyến đi mới',
          code: requestedCode || undefined,
          vehicleCodes,
          vehicleCode: leaderVehicleCode,
          memberId,
        }),
      });
      if (response.status === 401) { signOutGoogle(); throw new Error('Phiên Google đã hết hạn. Hãy đăng nhập lại.'); }
      if (!response.ok) throw new Error(response.status === 409 ? 'Mã đoàn đã tồn tại. Chọn mã khác.' : 'Không tạo được chuyến đi.');
      const created = (await response.json()) as { id?: string; memberToken?: string };
      if (!created.id) throw new Error('Mã chuyến đi không hợp lệ.');
      localStorage.setItem(`weemap-vehicle:${created.id}`, leaderVehicleCode);
      if (created.memberToken) localStorage.setItem(`weemap-member-token:${created.id}`, created.memberToken);
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
      if (!response.ok && response.status !== 403) throw new Error('Không thể thoát đoàn.');
      localStorage.removeItem(`weemap-vehicle:${tripId}`);
      localStorage.removeItem(`weemap-member-token:${tripId}`);
      window.location.assign(window.location.pathname);
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không thể thoát đoàn.');
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
        headers: { 'content-type': 'application/json', ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}) },
        body: JSON.stringify({ requesterMemberId: memberId, targetMemberId, leaderPassword }),
      });
      if (response.status === 401 || response.status === 403) { setLeaderUnlocked(false); }
      if (!response.ok) throw new Error(response.status === 403 ? 'Quyền quản lý không còn hợp lệ trên máy này.' : response.status === 409 ? 'Đoàn này chưa có mật khẩu trưởng đoàn.' : 'Không xóa được xe khỏi đoàn.');
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

  const addVehicle = async () => {
    if (!tripId || !leaderUnlocked) return;
    const slotCode = newVehicleCode.trim().toUpperCase();
    if (!isValidVehicleCode(slotCode)) {
      setTripError('Mã xe dùng 1–20 ký tự: chữ, số, gạch ngang hoặc gạch dưới.');
      return;
    }
    setMemberBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}/slots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}) },
        body: JSON.stringify({ slotCode, leaderPassword }),
      });
      const data = await response.json().catch(() => null) as { code?: string; error?: string } | null;
      if (response.status === 401 || response.status === 403) {
        setLeaderUnlocked(false);
        throw new Error('Quyền trưởng đoàn không còn hợp lệ.');
      }
      if (!response.ok) throw new Error(data?.error ?? 'Không thêm được xe vào chuyến đi.');
      setTripSlots((previous) => [...previous, { code: data?.code ?? slotCode, memberId: null, claimed: false }]);
      setNewVehicleCode('');
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không thêm được xe vào chuyến đi.');
    } finally {
      setMemberBusy(false);
    }
  };

  const renameTrip = async () => {
    if (!tripId || !leaderUnlocked || !tripNameEdit.trim()) return;
    setMemberBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}) },
        body: JSON.stringify({ name: tripNameEdit, leaderPassword }),
      });
      const data = await response.json().catch(() => null) as { name?: string; error?: string } | null;
      if (response.status === 401 || response.status === 403) {
        setLeaderUnlocked(false);
        throw new Error('Quyền trưởng đoàn không còn hợp lệ.');
      }
      if (!response.ok) throw new Error(data?.error ?? 'Không đổi được tên chuyến đi.');
      setTripInfo((previous) => previous ? { ...previous, name: data?.name ?? tripNameEdit.trim() } : previous);
      setTripNameEdit(data?.name ?? tripNameEdit.trim());
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không đổi được tên chuyến đi.');
    } finally {
      setMemberBusy(false);
    }
  };

  const renameVehicleCode = async () => {
    if (!tripId || !leaderUnlocked) return;
    const fromCode = vehicleCodeToChange.trim().toUpperCase();
    const toCode = replacementVehicleCode.trim().toUpperCase();
    if (!isValidVehicleCode(fromCode) || !isValidVehicleCode(toCode) || fromCode === toCode) {
      setTripError('Nhập hai mã xe hợp lệ và khác nhau.');
      return;
    }
    setMemberBusy(true);
    setTripError(null);
    try {
      const response = await fetch(`${workerOrigin}/api/trips/${tripId}/slots`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}) },
        body: JSON.stringify({ fromCode, toCode, leaderPassword }),
      });
      const data = await response.json().catch(() => null) as { code?: string; memberId?: string | null; error?: string } | null;
      if (response.status === 401 || response.status === 403) {
        setLeaderUnlocked(false);
        throw new Error('Quyền trưởng đoàn không còn hợp lệ.');
      }
      if (!response.ok) throw new Error(data?.error ?? 'Không đổi được mã xe.');
      setTripSlots((previous) => previous.map((slot) => slot.code === fromCode ? { ...slot, code: data?.code ?? toCode } : slot));
      if (data?.memberId) {
        setRoster((previous) => previous.map((member) => member.memberId === data.memberId ? { ...member, displayName: data.code ?? toCode } : member));
        if (data.memberId === memberId) {
          localStorage.setItem(`weemap-vehicle:${tripId}`, data.code ?? toCode);
          setSelectedVehicleCode(data.code ?? toCode);
        }
      }
      setVehicleCodeToChange('');
      setReplacementVehicleCode('');
    } catch (nextError) {
      setTripError(nextError instanceof Error ? nextError.message : 'Không đổi được mã xe.');
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
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock.current = await navigator.wakeLock.request('screen');
    } catch {
      // Screen wake lock is optional.
    }
  }, []);

  useEffect(() => {
    void requestWakeLock();
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
        const tripData = (await tripResponse.json()) as TripInfo & { has_leader_password?: boolean; has_google_leader?: boolean };
        const trip: TripInfo = { ...tripData, hasLeaderPassword: Boolean(tripData.has_leader_password), hasGoogleLeader: Boolean(tripData.has_google_leader) };
        if (cancelled) return;
        setTripInfo(trip);
        setTripNameEdit(trip.name);
        const slots = trip.slots ?? [];
        setTripSlots(slots);
        const savedVehicleCode = localStorage.getItem(`weemap-vehicle:${tripId}`) ?? '';
        const currentSlot = slots.find((slot) => slot.memberId === memberId);
        const savedSlot = currentSlot ?? slots.find((slot) => slot.code === savedVehicleCode);
        const activeVehicleCode = savedSlot && (!savedSlot.memberId || savedSlot.memberId === memberId) ? savedSlot.code : '';
        setSelectedVehicleCode(activeVehicleCode);
        if (activeVehicleCode) {
          localStorage.setItem(`weemap-vehicle:${tripId}`, activeVehicleCode);
          await registerMember(tripId, activeVehicleCode);
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
        const initialPassword = localStorage.getItem(`weemap-leader:${tripId}`) ?? sessionStorage.getItem(`weemap-leader:${tripId}`);
        if (initialPassword) {
          await verifyLeaderPassword(tripId, initialPassword);
          localStorage.setItem(`weemap-leader:${tripId}`, initialPassword);
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
    if (!tripId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const refreshRoster = async () => {
      try {
        const [tripResponse, membersResponse] = await Promise.all([
          fetch(`${workerOrigin}/api/trips/${tripId}`, { signal: controller.signal, cache: 'no-store' }),
          fetch(`${workerOrigin}/api/trips/${tripId}/members`, { signal: controller.signal, cache: 'no-store' }),
        ]);
        if (!tripResponse.ok || !membersResponse.ok) throw new Error('Không tải được danh sách xe.');
        const trip = await tripResponse.json() as TripInfo;
        const data = await membersResponse.json() as { members: Array<{ member_id: string; display_name: string; joined_at?: string }> };
        if (controller.signal.aborted) return;
        const slots = trip.slots ?? [];
        const currentSlot = slots.find((slot) => slot.memberId === memberId);
        if (currentSlot) {
          localStorage.setItem(`weemap-vehicle:${tripId}`, currentSlot.code);
          setSelectedVehicleCode(currentSlot.code);
        }
        setTripSlots(slots);
        setTripInfo((previous) => previous ? { ...previous, name: trip.name } : previous);
        setRoster(data.members.map((member) => ({ memberId: member.member_id, displayName: member.display_name, joinedAt: member.joined_at })));
      } catch {
        // Retain the last roster while the connection recovers.
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void refreshRoster(), 5000);
      }
    };
    void refreshRoster();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [tripId, leaderUnlocked]);

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
    const room = new VoiceRoom({
      memberId,
      getMemberToken: () => localStorage.getItem(`weemap-member-token:${tripId}`) ?? '',
      onStatus: (status, errorMessage) => {
        setVoiceStatus(status);
        setVoiceError(errorMessage ?? '');
      },
      onSpeaking: (speakingMemberId, speaking) => {
        setSpeakingMembers((previous) => ({ ...previous, [speakingMemberId]: speaking }));
      },
      onCall: (callingMemberId, active) => {
        setVoiceCalls((previous) => ({ ...previous, [callingMemberId]: active }));
      },
    });
    voiceRoom.current = room;
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
        room.attachSocket(nextSocket);
        const position = latestPosition.current;
        if (position) sendPosition(nextSocket, memberId, selectedVehicleCode, position, latestSpeed.current);
      });
      nextSocket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data) as unknown;
          room.handleMessage(message);
          const sharedRoute = parseSharedRouteState(message);
          if (sharedRoute) {
            setRouteTarget(sharedRoute.target);
            setRouteStarted(sharedRoute.started);
            return;
          }
          const location = parseLiveLocation(message);
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
      room.dispose();
      voiceRoom.current = null;
      setSpeakingMembers({});
      setVoiceCalls({});
      setVoiceStatus('idle');
    };
  }, [memberReady, selectedVehicleCode, tripId]);

  useEffect(() => {
    setRouteEstimates(null);
    if (!tripId || !memberReady) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const refreshRoutes = async () => {
      try {
        if (document.visibilityState === 'visible') {
          const response = await fetch(`${workerOrigin}/api/trips/${tripId}/routes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ memberId, memberToken: localStorage.getItem(`weemap-member-token:${tripId}`) }),
            signal: controller.signal,
            cache: 'no-store',
          });
          const estimates = response.ok ? parseRouteEstimates(await response.json()) : null;
          if (!controller.signal.aborted) setRouteEstimates(estimates);
        }
      } catch {
        if (!controller.signal.aborted) setRouteEstimates(null);
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void refreshRoutes(), 30_000);
      }
    };
    void refreshRoutes();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [tripId, memberReady, memberId]);

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
      const displayName = isCurrent && (!tripId || !memberReady || !selectedVehicleCode.trim())
        ? 'Bạn ở đây'
        : location.displayName ?? roster.find((member) => member.memberId === id)?.displayName ?? `Xe ${id.slice(0, 4)}`;
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
  }, [displayedMembers, memberId, memberReady, roster, selectedVehicleCode, tripId]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const marker = routeTarget ? new Marker({ color: '#f52450' }).setLngLat([routeTarget.longitude, routeTarget.latitude]).addTo(map) : undefined;
    if (marker) marker.getElement().setAttribute('aria-label', 'Điểm đến');
    return () => { marker?.remove(); };
  }, [routeTarget]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    const draw = () => {
      const features: FeatureCollection['features'] = [];
      if (plannedRoute) {
        const progress = routeStarted ? routeProgress : null;
        if (progress && progress.remaining.length > 1) features.push({ type: 'Feature', properties: { kind: 'remaining' }, geometry: { type: 'LineString', coordinates: progress.remaining } });
        if (progress && progress.traveled.length > 1) features.push({ type: 'Feature', properties: { kind: 'traveled' }, geometry: { type: 'LineString', coordinates: progress.traveled } });
        if (!progress) features.push({ type: 'Feature', properties: { kind: 'remaining' }, geometry: { type: 'LineString', coordinates: plannedRoute.coordinates } });
      }
      const data: FeatureCollection = { type: 'FeatureCollection', features };
      const source = map.getSource('planned-route') as GeoJSONSource | undefined;
      if (source) source.setData(data);
      else {
        map.addSource('planned-route', { type: 'geojson', data });
        map.addLayer({ id: 'planned-route-outline', type: 'line', source: 'planned-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
        map.addLayer({ id: 'planned-route-traveled', type: 'line', source: 'planned-route', filter: ['==', ['get', 'kind'], 'traveled'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1677df', 'line-width': 5 } });
        map.addLayer({ id: 'planned-route-line', type: 'line', source: 'planned-route', filter: ['==', ['get', 'kind'], 'remaining'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#87968f', 'line-width': 5 } });
      }
      if (plannedRoute && plannedRoute !== fittedRoute.current) {
        const bounds = plannedRoute.coordinates.reduce((area, point) => area.extend(point), new LngLatBounds(plannedRoute.coordinates[0], plannedRoute.coordinates[0]));
        map.fitBounds(bounds, { padding: { top: 200, right: 75, bottom: 180, left: 30 }, maxZoom: 16 });
        fittedRoute.current = plannedRoute;
      }
    };
    // Tile downloads can keep isStyleLoaded false after the one-time load event.
    if (map.getLayer('osm')) draw();
    else map.once('style.load', draw);
    return () => { map.off('style.load', draw); };
  }, [plannedRoute, routeProgress, routeStarted]);

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

  const vehicleDistance = (id: string): string => {
    if (id === memberId) return 'Bạn';
    const other = displayedMembers[id];
    if (!position || !other) return 'Chờ GPS';
    if (isLiveLocationStale(new Date(position.timestamp).toISOString(), signalCheckAt) || isLiveLocationStale(other.recordedAt, signalCheckAt)) return 'GPS đã cũ';
    const route = routeEstimates && signalCheckAt - routeEstimates.calculatedAt <= 90_000
      ? routeEstimates.routes.find((estimate) => estimate.memberId === id)
      : undefined;
    return route ? formatRouteEstimate(route) : formatDistance(distanceBetweenKm(position, other));
  };

  const focusMap = (latitude: number, longitude: number) => {
    mapInstance.current?.flyTo({ center: [longitude, latitude], zoom: Math.max(mapZoom, 15) });
  };

  const refreshGps = () => {
    if (!navigator.geolocation || gpsRefreshing) return;
    setGpsRefreshing(true);
    navigator.geolocation.getCurrentPosition(
      (next) => {
        setPosition({ latitude: next.coords.latitude, longitude: next.coords.longitude, accuracy: next.coords.accuracy, speed: next.coords.speed, timestamp: next.timestamp });
        setGpsState('ok');
        setError(null);
        setGpsRefreshing(false);
      },
      (nextError) => {
        setGpsState('blocked');
        setError(nextError.message);
        setGpsRefreshing(false);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  };

  const navigateMap = () => {
    const map = mapInstance.current;
    if (!map || !navigatorPoints.length) return;
    const key = navigatorPoints.map((point) => point.id).join('|');
    if (navigatorCycle.current.key !== key) navigatorCycle.current = { key, index: 0 };
    if (navigatorCycle.current.index === 0) {
      const bounds = new LngLatBounds();
      navigatorPoints.forEach((point) => bounds.extend([point.longitude, point.latitude]));
      map.fitBounds(bounds, { padding: { top: 120, right: 100, bottom: 180, left: 40 }, maxZoom: 15, duration: 700 });
      navigatorCycle.current.index = 1;
      return;
    }
    if (position) focusMap(position.latitude, position.longitude);
    navigatorCycle.current.index = 0;
  };

  const nearbyVehicles = vehicleList.filter((vehicle) => vehicle.memberId !== memberId && !vehicle.memberId.startsWith('slot:')).map((vehicle) => {
    const location = displayedMembers[vehicle.memberId];
    const fresh = position && location && !isLiveLocationStale(new Date(position.timestamp).toISOString(), signalCheckAt) && !isLiveLocationStale(location.recordedAt, signalCheckAt);
    const route = fresh && routeEstimates && signalCheckAt - routeEstimates.calculatedAt <= 90_000
      ? routeEstimates.routes.find((estimate) => estimate.memberId === vehicle.memberId) : undefined;
    return { ...vehicle, distance: fresh ? distanceBetweenKm(position, location) : undefined, route };
  });
  const diagramUsesRoad = nearbyVehicles.some((vehicle) => vehicle.distance !== undefined)
    && nearbyVehicles.filter((vehicle) => vehicle.distance !== undefined).every((vehicle) => vehicle.route);
  const diagramVehicles = nearbyVehicles.map((vehicle) => ({ ...vehicle, distance: diagramUsesRoad ? vehicle.route ? vehicle.route.distanceMeters / 1000 : undefined : vehicle.distance }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.displayName.localeCompare(b.displayName));
  const gpsHasSignal = gpsState === 'ok' && position !== null && !isLiveLocationStale(new Date(position.timestamp).toISOString(), signalCheckAt);
  const speakingVehicleNames = Object.entries(speakingMembers)
    .filter(([id, speaking]) => speaking && id !== memberId)
    .map(([id]) => roster.find((member) => member.memberId === id)?.displayName ?? `Xe ${id.slice(0, 4)}`)
    .join(', ');
  const callingVehicleNames = Object.entries(voiceCalls)
    .filter(([id, active]) => active && id !== memberId)
    .map(([id]) => roster.find((member) => member.memberId === id)?.displayName ?? `Xe ${id.slice(0, 4)}`)
    .join(', ');
  const ownVoiceCall = voiceStatus === 'requesting' || voiceStatus === 'speaking';
  const incomingVoiceCall = Boolean(callingVehicleNames);
  const voiceCallActive = ownVoiceCall || incomingVoiceCall;
  const voiceCallerName = ownVoiceCall ? (selectedVehicleCode || 'Xe của bạn') : callingVehicleNames;
  const voiceBannerTitle = voiceStatus === 'requesting' ? 'Đang kết nối bộ đàm' : ownVoiceCall ? 'Bạn đang gọi' : 'Xe đang gọi';
  const voiceBannerHint = voiceStatus === 'requesting' ? 'đang mở micro' : ownVoiceCall ? 'bấm để kết thúc' : 'chạm để trả lời';

  return (
    <main className="map-shell">
      <section className="map-stage" aria-label="Bản đồ WeeMap">
        <div className="map" ref={mapRef} />

        <header className="map-toolbar">
          <div className="map-info-stack">
            <div className="brand-lockup"><img className="brand-logo" src="/icons/weemap.png" alt="" /><div className="brand-copy"><strong>WeeMap - Di chuyển nhóm</strong><small>Sản phẩm thử nghiệm của Antony</small></div></div>
            <div className="map-status" aria-live="polite">
              <span className={`status-dot status-${gpsState}`} />
              <span>{position ? 'Đang định vị' : gpsState === 'blocked' ? 'GPS chưa sẵn sàng' : 'Đang tìm vị trí'}</span>
              {position && <small>± {Math.round(position.accuracy)} m</small>}
              {signalIssueVehicles.length > 0 && <span className="map-signal-warning" role="alert">{signalIssueVehicles.length} xe cần kiểm tra GPS</span>}
              {speakingVehicleNames && <span className="voice-speaking" role="status">Đang nói: {speakingVehicleNames}</span>}
              {voiceStatus === 'error' && <span className="map-signal-warning" role="alert">{voiceError || 'Bộ đàm chưa sẵn sàng'}</span>}
            </div>
            <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
            {updateAvailable && (
              <div className="update-banner" role="status">
                <span>Cập nhật phiên bản mới nhất</span>
                <button type="button" aria-label="Cập nhật phiên bản mới nhất" onClick={() => window.location.reload()}><img src="/icons/update.png" alt="" /></button>
              </div>
            )}
          </div>
          <button className="round-button" type="button" aria-label={panelOpen ? 'Đóng thiết lập chuyến đi' : 'Mở thiết lập chuyến đi'} onClick={() => { setPanelOpen((open) => !open); setSetupMode(null); setTripError(null); setRouteOpen(false); }}><img src="/icons/settings.png" alt="" /></button>
        </header>

        {tripId && memberReady && voiceCallActive && <section className="voice-banner" role="status" aria-live="assertive" aria-label={`Cuộc gọi từ ${voiceCallerName}`}>
          <img src="/icons/voice.png" alt="" />
          <div className="voice-banner-copy">
            <span>{voiceBannerTitle}</span>
            <strong>{voiceCallerName}</strong>
            <small>Âm thanh trực tiếp · {voiceBannerHint}</small>
          </div>
          <div className="voice-waveform" role="img" aria-label="Đang truyền âm thanh"><i /><i /><i /><i /><i /><i /><i /></div>
          <span className="voice-banner-live" aria-hidden="true" />
          {!ownVoiceCall && <button className="voice-banner-action" type="button" onClick={() => void voiceRoom.current?.toggleTalking()}>Trả lời</button>}
        </section>}

        <div className={`map-controls${panelOpen || routeOpen ? '' : ' map-controls-full'}`} aria-label="Điều khiển bản đồ">
          <button className="map-control" type="button" aria-label="Phóng to" onClick={() => { const nextZoom = Math.min(20, mapZoom + 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>+</button>
          <button className="map-control" type="button" aria-label="Thu nhỏ" onClick={() => { const nextZoom = Math.max(4, mapZoom - 1); setMapZoom(nextZoom); mapInstance.current?.setZoom(nextZoom); }}>−</button>
          <button className="map-control locate-control" type="button" aria-label="Toàn cảnh và từng vị trí" disabled={!navigatorPoints.length} onClick={navigateMap}><img src="/icons/navigator.png" alt="" /></button>
          <button className="map-control gps-signal-control" type="button" aria-label={`GPS Signal: ${gpsHasSignal ? 'có tín hiệu' : 'mất tín hiệu'}`} title="GPS Signal" disabled={gpsRefreshing} onClick={refreshGps}><img src={gpsHasSignal ? '/icons/gps-signal-active.png' : '/icons/gps-signal-lost.png'} alt="" /></button>
          <button className="map-control route-control" type="button" aria-label="Lập lộ trình" aria-expanded={routeOpen} onClick={() => { setRouteOpen((open) => !open); setPanelOpen(false); }}><img src="/icons/route.png" alt="" /></button>
          {tripId && memberReady && <button
            className={`map-control voice-control${ownVoiceCall ? ' voice-control-active' : incomingVoiceCall ? ' voice-control-ringing' : ''}`}
            type="button"
            aria-label={ownVoiceCall ? 'Kết thúc cuộc gọi' : incomingVoiceCall ? 'Trả lời cuộc gọi từ xe khác' : 'Bắt đầu cuộc gọi với các xe trong chuyến'}
            title={ownVoiceCall ? 'Kết thúc cuộc gọi' : incomingVoiceCall ? 'Trả lời cuộc gọi' : 'Bắt đầu cuộc gọi'}
            aria-pressed={ownVoiceCall || incomingVoiceCall}
            onClick={() => void voiceRoom.current?.toggleTalking()}
          ><img src="/icons/voice.png" alt="" /></button>}
          <button className="map-control refresh-control" type="button" aria-label="Làm mới vị trí" onClick={() => window.location.reload()}><img src="/icons/refresh.png" alt="" /></button>
        </div>

        {tripId && memberReady && !panelOpen && !routeOpen && <section className="convoy-diagram" aria-label="Khoảng cách">
          <div className="convoy-heading"><img src="/icons/distance.png" alt="" /><h2>Khoảng cách</h2></div>
          <ol className="convoy-nodes">
            <li className="convoy-node"><button className="convoy-node-button" type="button" disabled={!position} onClick={() => position && focusMap(position.latitude, position.longitude)}><strong style={{ backgroundColor: getVehicleColor(memberId) }}>{selectedVehicleCode || 'Xe của bạn'}</strong></button><span>Bạn</span></li>
            {diagramVehicles.map((vehicle) => <li className="convoy-node" key={vehicle.memberId}><button className="convoy-node-button" type="button" disabled={!displayedMembers[vehicle.memberId]} onClick={() => { const location = displayedMembers[vehicle.memberId]; if (location) focusMap(location.latitude, location.longitude); }}><strong style={{ backgroundColor: getVehicleColor(vehicle.memberId) }}>{vehicle.displayName}</strong></button><span>{vehicle.distance === undefined ? vehicleDistance(vehicle.memberId) : formatDistance(vehicle.distance)}</span></li>)}
            {routeStarted && routeTarget && <li className="convoy-node" key="destination"><button className="convoy-node-button" type="button" onClick={() => focusMap(routeTarget.latitude, routeTarget.longitude)}><strong style={{ backgroundColor: '#f52450' }}>Đích đến</strong></button><span>{routeProgress ? formatDistance(routeProgress.remainingDistanceMeters / 1000) : 'Chờ GPS'}</span></li>}
          </ol>
        </section>}

        {routeOpen && <section className="map-sheet route-sheet" role="dialog" aria-label="Lập lộ trình">
          <div className="sheet-heading"><h1>Lập lộ trình</h1><button className="share-close" type="button" aria-label="Đóng lộ trình" onClick={() => setRouteOpen(false)}>×</button></div>
          <form className="trip-setup" onSubmit={(event) => { event.preventDefault(); void planRoute(); }}>
            <label className="trip-field"><span>Điểm xuất phát</span><select className="trip-input" aria-label="Điểm xuất phát"><option>Vị trí hiện tại của bạn</option></select></label>
            {!position && <p className="route-note" role="status">Bật quyền vị trí và chờ GPS để chọn điểm xuất phát.</p>}
            <label className="trip-field"><span>Điểm đến</span><input className="trip-input" value={destination} maxLength={160} placeholder="Plus Code, tọa độ, địa chỉ hoặc link Google Maps" onChange={(event) => { clearPlannedRoute(); setDestination(event.target.value); }} /></label>
            {routeTarget && <div className="trip-field"><strong>{routeTarget.label ?? routeTarget.code}</strong><span>Điểm đến: {routeTarget.latitude.toFixed(5)}, {routeTarget.longitude.toFixed(5)}</span><span>{routeTarget.shortened ? 'Mã rút gọn được xác định theo địa phương. ' : ''}Kiểm tra ghim đỏ trên bản đồ trước khi vẽ đường.</span><button className="trip-button trip-button-soft" type="button" onClick={() => setRouteOpen(false)}>Xem ghim trên bản đồ</button></div>}
            {routeError && <p className="trip-error" role="alert">{routeError}</p>}
            <button className="trip-button" type="submit" disabled={routeBusy || !destination.trim() || !position}>{routeBusy ? 'Đang tính đường…' : routeTarget ? 'Vẽ lộ trình' : 'Xem điểm đến'}</button>
            <p className="route-note">Đường ô tô · thời gian ước tính. Dữ liệu điểm đến có thể được gửi tới <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">openrouteservice</a> để tìm vị trí và tính đường. © OpenStreetMap contributors.</p>
            {(routeTarget || plannedRoute) && <button className="trip-button trip-button-soft" type="button" onClick={clearPlannedRoute}>Xóa lộ trình</button>}
          </form>
        </section>}
        {plannedRoute && !panelOpen && !routeOpen && <div className="route-summary" role="status"><strong>{!routeStarted ? 'Sẵn sàng bắt đầu' : routeProgress?.offRoute ? 'Đang tính lại tuyến…' : `${formatDistance((routeProgress?.remainingDistanceMeters ?? plannedRoute.distanceMeters) / 1000)} còn lại · khoảng ${Math.max(1, Math.ceil((plannedRoute.durationSeconds * (routeProgress?.remainingDistanceMeters ?? plannedRoute.distanceMeters)) / Math.max(1, plannedRoute.distanceMeters) / 60))} phút`}</strong><span>{routeProgress?.offRoute && routeStarted ? 'Bạn đang lệch tuyến' : 'Đường ô tô · openrouteservice · © OpenStreetMap'}</span>{!routeStarted && (!tripId || leaderUnlocked) && <button className="trip-button" type="button" onClick={() => void startRoute()}>Bắt đầu đi</button>}<button className="trip-button trip-button-soft" type="button" onClick={clearPlannedRoute}>Xóa</button></div>}

        {panelOpen && <div className="map-sheet" role="dialog" aria-label="Thiết lập chuyến đi">
          <div className="sheet-heading"><div><span className="eyebrow">CHUYẾN ĐI</span><h1>{tripId ? tripInfo?.name ?? 'Đoàn xe đang chạy' : setupMode === 'create' ? 'Tạo chuyến mới' : setupMode === 'join' ? 'Tham gia chuyến' : 'Hôm nay bạn muốn đi đâu ?'}</h1></div>{serverState === 'ok' && <span className="connection-pill connection-ok">Trực tuyến</span>}</div>
          {tripId && <><div className="driving-row">
            <div><span className="metric-label">Xe trong đoàn</span><strong>{Object.keys(displayedMembers).length} <small>xe</small></strong></div>
            {position && <span className="last-seen">{new Date(position.timestamp).toLocaleTimeString('vi-VN')}</span>}
          </div>
          {signalIssueVehicles.length > 0 && <div className="signal-alert" role="alert"><span className="signal-alert-dot" aria-hidden="true" /><div><strong>GPS xe cần kiểm tra</strong><span>{signalIssueVehicles.map((vehicle) => `${vehicle.displayName} · ${vehicle.issue === 'missing' ? 'chưa có tín hiệu' : 'mất tín hiệu'}`).join('  ·  ')}</span></div></div>}
          </>}
          {!tripId && setupMode && <button className="trip-button trip-button-soft" type="button" onClick={() => { setSetupMode(null); setTripError(null); }}>← Quay lại</button>}
          {tripId && leaderUnlocked && <div className="trip-entry"><strong>Chỉnh sửa chuyến đi</strong><div className="trip-entry-row"><input className="trip-input" value={tripNameEdit} maxLength={80} aria-label="Tên chuyến đi mới" placeholder="Tên chuyến đi mới" onChange={(event) => setTripNameEdit(event.target.value)} /><button className="trip-button" type="button" disabled={memberBusy || !tripNameEdit.trim()} onClick={() => void renameTrip()}>Lưu tên</button></div><div className="trip-entry-row"><input className="trip-input" value={newVehicleCode} maxLength={20} aria-label="Mã xe mới" placeholder="Mã xe mới" onChange={(event) => setNewVehicleCode(event.target.value.toUpperCase())} /><button className="trip-button" type="button" disabled={memberBusy || !newVehicleCode.trim()} onClick={() => void addVehicle()}>{memberBusy ? 'Đang thêm…' : 'Thêm xe'}</button></div><div className="trip-entry-row"><select className="trip-input" value={vehicleCodeToChange} aria-label="Mã xe cần đổi" onChange={(event) => setVehicleCodeToChange(event.target.value)}><option value="">Chọn mã xe cần đổi</option>{tripSlots.map((slot) => <option key={slot.code} value={slot.code}>{slot.code}{slot.claimed ? ' · đang dùng' : ''}</option>)}</select><input className="trip-input" value={replacementVehicleCode} maxLength={20} aria-label="Mã xe thay thế" placeholder="Mã xe thay thế" onChange={(event) => setReplacementVehicleCode(event.target.value.toUpperCase())} /></div><button className="trip-button trip-button-soft" type="button" disabled={memberBusy || !vehicleCodeToChange || !replacementVehicleCode.trim()} onClick={() => void renameVehicleCode()}>Đổi mã xe</button></div>}
          {tripId ? <><div className="trip-room"><span>Mã đoàn: <strong>{tripId}</strong></span><div className="trip-room-actions"><button className="trip-button trip-button-soft" type="button" onClick={() => setShareOpen(true)}>Chia sẻ</button><button className="trip-button trip-button-danger" type="button" disabled={memberBusy} onClick={() => void leaveTrip()}>Thoát đoàn</button></div></div>{leaderUnlocked && <div className="trip-entry"><strong>Bạn là trưởng đoàn</strong>{googleToken && <button className="trip-button trip-button-soft" type="button" onClick={signOutGoogle}>Đăng xuất Google</button>}</div>}{tripError && <p className="trip-error" role="alert">{tripError}</p>}{!memberReady && <div className="trip-entry"><strong>Chọn mã xe để vào đoàn</strong><div className="trip-entry-row"><select className="trip-input" value={selectedVehicleCode} onChange={(event) => setSelectedVehicleCode(event.target.value)} aria-label="Mã xe"><option value="">Chọn xe</option>{tripSlots.map((slot) => <option key={slot.code} value={slot.code} disabled={slot.claimed && slot.memberId !== memberId}>{slot.code}{slot.claimed ? ' · đã chọn' : ''}</option>)}</select><button className="trip-button" type="button" disabled={memberBusy || !selectedVehicleCode} onClick={() => void enterSharedTrip()}>{memberBusy ? 'Đang vào…' : 'Vào đoàn'}</button></div></div>}{shareOpen && <div className="share-box" role="dialog" aria-label="Chia sẻ chuyến đi"><div className="share-heading"><strong>Mời xe vào đoàn</strong><button type="button" className="share-close" aria-label="Đóng" onClick={() => setShareOpen(false)}>×</button></div>{qrDataUrl ? <img className="share-qr" src={qrDataUrl} alt="Mã QR tham gia WeeMap" /> : <div className="share-qr share-qr-placeholder">Đang tạo QR…</div>}<span className="share-link">{shareUrl}</span><button className="trip-button" type="button" onClick={() => void copyTripLink()}>{shareStatus}</button></div>}<div className="vehicle-list"><div className="vehicle-list-heading"><strong>Xe trong đoàn</strong><span>{vehicleList.length}</span></div>{vehicleList.map((vehicle) => <div className="vehicle-row" key={vehicle.memberId}><span className="vehicle-swatch" style={{ backgroundColor: getVehicleColor(vehicle.memberId) }} /><span className="vehicle-name">{vehicle.displayName}</span><span className="vehicle-distance">{vehicleDistance(vehicle.memberId)}</span><span className="vehicle-state">{vehicle.memberId.startsWith('slot:') ? 'Chưa chọn' : displayedMembers[vehicle.memberId] ? 'Đang chạy' : 'Đã vào'}</span>{leaderUnlocked && !vehicle.memberId.startsWith('slot:') && <button className="trip-button trip-button-danger" type="button" disabled={memberBusy} onClick={() => void removeVehicle(vehicle.memberId)}>Xóa xe</button>}</div>)}<p className="route-note">Đường ô tô · thời gian ước tính, chưa tính giao thông trực tiếp. <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">openrouteservice</a> · © OpenStreetMap contributors</p></div></> : <div className="trip-setup">{setupMode === null ? <>{!googleToken ? <><GoogleSignIn onCredential={(token) => void signInGoogle(token)} /><button className="trip-button trip-button-soft" type="button" onClick={() => setSetupMode('join')}>Tham gia chuyến</button></> : <><div className="trip-entry-row"><span>{googleName || 'Đã đăng nhập Google'}</span><button className="trip-button trip-button-soft" type="button" onClick={signOutGoogle}>Đăng xuất</button></div><button className="trip-button" type="button" onClick={() => setSetupMode('create')}>Tạo chuyến mới</button><button className="trip-button trip-button-soft" type="button" onClick={() => setSetupMode('join')}>Tham gia chuyến</button></>}</> : setupMode === 'create' ? <>{!googleToken ? <GoogleSignIn onCredential={(token) => void signInGoogle(token)} /> : <><div className="trip-entry-row"><span>{googleName || 'Đã đăng nhập Google'}</span><button className="trip-button trip-button-soft" type="button" onClick={signOutGoogle}>Đăng xuất</button></div><label className="trip-field"><span>Tên chuyến đi</span><input className="trip-input" value={tripName} onChange={(event) => setTripName(event.target.value)} aria-label="Tên chuyến đi" placeholder="Tên chuyến đi" /></label><label className="trip-field"><span>Mã đoàn (không bắt buộc)</span><input className="trip-input" value={customCode} onChange={(event) => setCustomCode(event.target.value.toUpperCase())} aria-label="Mã đoàn tuỳ chọn" placeholder="Mã đoàn tuỳ chọn (không bắt buộc)" maxLength={32} /></label><div className="vehicle-count-row"><label htmlFor="vehicle-count">Số lượng xe</label><select id="vehicle-count" className="trip-input" value={vehicleCount} onChange={(event) => setVehicleCount(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select></div><div className="trip-field"><span>Danh sách mã xe</span>{vehicleCodeBoxes.slice(0, vehicleCount).map((code, index) => <label className="trip-field" key={index}><span>Xe {index + 1}</span><input className="trip-input" maxLength={20} value={code} onChange={(event) => setVehicleCodeBoxes((previous) => previous.map((value, i) => i === index ? event.target.value.toUpperCase() : value))} /></label>)}</div><label className="trip-field"><span>Mã xe của trưởng đoàn</span><select className="trip-input" value={selectedVehicleCode} onChange={(event) => setSelectedVehicleCode(event.target.value)} aria-label="Mã xe của trưởng đoàn"><option value="">Chọn mã xe của bạn</option>{parseVehicleCodes(vehicleCodesInput).map((code) => <option key={code} value={code}>{code}</option>)}</select></label><button className="trip-button" type="button" disabled={tripBusy} onClick={() => void createTrip()}>{tripBusy ? 'Đang tạo…' : 'Tạo đoàn mới'}</button></>}</> : <><div className="trip-code-group"><input className="trip-input trip-code-input" value={tripInput} onChange={(event) => setTripInput(event.target.value)} aria-label="Mã chuyến đi hoặc liên kết" placeholder="Nhập mã đoàn" /><button className="trip-button trip-button-soft trip-scan-button" type="button" disabled={tripBusy} onClick={() => { setScanError(null); setScannerOpen(true); }}>QR</button></div><button className="trip-button trip-button-soft" type="button" disabled={tripBusy} onClick={() => void joinTrip()}>Tham gia</button></>}{tripError && <p className="trip-error" role="alert">{tripError}</p>}</div>}
          <div className="sheet-footer"><span>{tripId ? `${Object.keys(displayedMembers).length}/${tripSlots.length || '—'} xe đang chia sẻ vị trí` : position ? `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}` : error ?? 'Bật GPS để bắt đầu'}</span></div>
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
  element.setAttribute('aria-label', displayName);
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
  element.setAttribute('aria-label', displayName);
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
