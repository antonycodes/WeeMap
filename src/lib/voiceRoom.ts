export type VoiceRoomStatus = 'idle' | 'requesting' | 'ready' | 'speaking' | 'error';

type VoiceSignal = RTCSessionDescriptionInit | RTCIceCandidateInit;
type VoiceMessage =
  | { type: 'voice-peer'; memberId: string; online: boolean }
  | { type: 'voice-signal'; memberId: string; signal: VoiceSignal }
  | { type: 'voice-state'; memberId: string; speaking: boolean }
  | { type: 'voice-call'; memberId: string; active: boolean };

export function isVoiceSignal(value: unknown): value is VoiceSignal {
  if (!value || typeof value !== 'object') return false;
  if ('candidate' in value) return typeof value.candidate === 'string' || value.candidate === null;
  return 'type' in value && (value.type === 'offer' || value.type === 'answer' || value.type === 'pranswer' || value.type === 'rollback');
}

type VoiceRoomOptions = {
  memberId: string;
  getMemberToken: () => string;
  getIceServers: () => Promise<RTCIceServer[]>;
  onStatus: (status: VoiceRoomStatus, error?: string) => void;
  onSpeaking: (memberId: string, speaking: boolean) => void;
  onCall: (memberId: string, active: boolean) => void;
};

export class VoiceRoom {
  private readonly memberId: string;
  private readonly getMemberToken: () => string;
  private readonly getIceServers: VoiceRoomOptions['getIceServers'];
  private readonly onStatus: VoiceRoomOptions['onStatus'];
  private readonly onSpeaking: VoiceRoomOptions['onSpeaking'];
  private readonly onCall: VoiceRoomOptions['onCall'];
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private readonly peers = new Set<string>();
  private readonly connections = new Map<string, RTCPeerConnection>();
  private readonly remoteAudio = new Map<string, HTMLAudioElement>();
  private readonly candidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly negotiating = new Set<string>();
  private pressed = false;

  constructor(options: VoiceRoomOptions) {
    this.memberId = options.memberId;
    this.getMemberToken = options.getMemberToken;
    this.getIceServers = options.getIceServers;
    this.onStatus = options.onStatus;
    this.onSpeaking = options.onSpeaking;
    this.onCall = options.onCall;
  }

  attachSocket(socket: WebSocket): void {
    this.socket = socket;
    this.send({ type: 'voice-join', memberId: this.memberId, memberToken: this.getMemberToken() });
  }

  handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    const message = value as VoiceMessage;
    if (message.type === 'voice-peer' && typeof message.memberId === 'string') {
      if (message.online) {
        this.peers.add(message.memberId);
        if (this.stream) void this.connectTo(message.memberId);
      } else {
        this.peers.delete(message.memberId);
        this.closePeer(message.memberId);
      }
      return;
    }
    if (message.type === 'voice-state' && typeof message.memberId === 'string') {
      this.onSpeaking(message.memberId, message.speaking === true);
      return;
    }
    if (message.type === 'voice-call' && typeof message.memberId === 'string' && typeof message.active === 'boolean') {
      this.onCall(message.memberId, message.active);
      return;
    }
    if (message.type === 'voice-signal' && typeof message.memberId === 'string' && isVoiceSignal(message.signal)) {
      void this.handleSignal(message.memberId, message.signal);
    }
  }

  async startTalking(): Promise<void> {
    this.pressed = true;
    if (!this.stream) {
      this.onStatus('requesting');
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        this.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
        this.send({ type: 'voice-call', memberId: this.memberId, memberToken: this.getMemberToken(), active: true });
        await Promise.all([...this.peers].map((memberId) => this.connectTo(memberId)));
        this.onStatus('ready');
      } catch (error) {
        this.pressed = false;
        this.onStatus('error', error instanceof Error ? error.message : 'Không mở được micro.');
        return;
      }
    }
    if (!this.pressed || !this.stream) return;
    this.stream.getAudioTracks().forEach((track) => { track.enabled = true; });
    this.onStatus('speaking');
    this.send({ type: 'voice-state', memberId: this.memberId, memberToken: this.getMemberToken(), speaking: true });
  }

  async toggleTalking(): Promise<void> {
    if (this.pressed) {
      this.stopTalking();
      return;
    }
    this.resumeAudio();
    await this.startTalking();
  }

  resumeAudio(): void {
    this.remoteAudio.forEach((audio) => {
      audio.muted = false;
      audio.volume = 1;
      void audio.play().catch(() => undefined);
    });
  }

  stopTalking(): void {
    this.pressed = false;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: 'voice-state', memberId: this.memberId, memberToken: this.getMemberToken(), speaking: false });
      this.send({ type: 'voice-call', memberId: this.memberId, memberToken: this.getMemberToken(), active: false });
    }
    if (this.stream) this.onStatus('ready');
  }

  dispose(): void {
    this.pressed = false;
    this.send({ type: 'voice-state', memberId: this.memberId, memberToken: this.getMemberToken(), speaking: false });
    this.send({ type: 'voice-call', memberId: this.memberId, memberToken: this.getMemberToken(), active: false });
    this.connections.forEach((connection) => connection.close());
    this.connections.clear();
    this.remoteAudio.forEach((audio) => audio.remove());
    this.remoteAudio.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.socket = null;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async connectTo(memberId: string): Promise<void> {
    await this.loadIceServers();
    const connection = this.ensurePeer(memberId);
    const hasLocalTrack = connection.getSenders().some((sender) => sender.track?.kind === 'audio');
    if (!hasLocalTrack || connection.signalingState !== 'stable' || this.negotiating.has(memberId)) return;
    this.negotiating.add(memberId);
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (connection.localDescription) this.send({ type: 'voice-signal', memberId: this.memberId, memberToken: this.getMemberToken(), targetId: memberId, signal: connection.localDescription });
    } catch {
      this.closePeer(memberId);
    } finally {
      this.negotiating.delete(memberId);
    }
  }

  private ensurePeer(memberId: string): RTCPeerConnection {
    const existing = this.connections.get(memberId);
    if (existing) {
      const track = this.stream?.getAudioTracks()[0];
      if (track && !existing.getSenders().some((sender) => sender.track?.kind === 'audio')) existing.addTrack(track, this.stream as MediaStream);
      return existing;
    }
    const connection = new RTCPeerConnection({ iceServers: this.iceServers ?? [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    this.connections.set(memberId, connection);
    const track = this.stream?.getAudioTracks()[0];
    if (track) connection.addTrack(track, this.stream as MediaStream);
    connection.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: 'voice-signal', memberId: this.memberId, memberToken: this.getMemberToken(), targetId: memberId, signal: event.candidate.toJSON() });
    };
    connection.ontrack = (event) => {
      const audio = this.remoteAudio.get(memberId) ?? document.body.appendChild(Object.assign(document.createElement('audio'), { autoplay: true, playsInline: true }));
      audio.muted = false;
      audio.volume = 1;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      audio.play().catch(() => { /* Browser may require a prior user gesture. */ });
      this.remoteAudio.set(memberId, audio);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') {
        this.onStatus('error', 'Không kết nối được âm thanh với xe này.');
        this.closePeer(memberId);
      } else if (connection.connectionState === 'closed') this.closePeer(memberId);
    };
    return connection;
  }

  private async handleSignal(memberId: string, signal: VoiceSignal): Promise<void> {
    await this.loadIceServers();
    const connection = this.ensurePeer(memberId);
    try {
      if ('candidate' in signal) {
        const candidate = signal as RTCIceCandidateInit;
        if (connection.remoteDescription) await connection.addIceCandidate(candidate);
        else this.candidates.set(memberId, [...(this.candidates.get(memberId) ?? []), candidate]);
        return;
      }
      const description = signal as RTCSessionDescriptionInit;
      if (!description.type) return;
      await connection.setRemoteDescription(description);
      for (const candidate of this.candidates.get(memberId) ?? []) await connection.addIceCandidate(candidate);
      this.candidates.delete(memberId);
      if (description.type === 'offer') {
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        if (connection.localDescription) this.send({ type: 'voice-signal', memberId: this.memberId, memberToken: this.getMemberToken(), targetId: memberId, signal: connection.localDescription });
      }
    } catch {
      this.closePeer(memberId);
    }
  }

  private closePeer(memberId: string): void {
    this.connections.get(memberId)?.close();
    this.connections.delete(memberId);
    this.candidates.delete(memberId);
    this.remoteAudio.get(memberId)?.remove();
    this.remoteAudio.delete(memberId);
    this.onSpeaking(memberId, false);
  }

  private iceServers: RTCIceServer[] | null = null;
  private iceServersRequest: Promise<RTCIceServer[]> | null = null;

  private async loadIceServers(): Promise<void> {
    if (this.iceServers || this.iceServersRequest) {
      if (this.iceServersRequest) this.iceServers = await this.iceServersRequest;
      return;
    }
    this.iceServersRequest = this.getIceServers()
      .then((iceServers) => iceServers.length ? iceServers : [{ urls: 'stun:stun.cloudflare.com:3478' }])
      .catch(() => [{ urls: 'stun:stun.cloudflare.com:3478' }]);
    this.iceServers = await this.iceServersRequest;
    this.iceServersRequest = null;
  }
}
