import { describe, expect, it, vi } from 'vitest';
import { isVoiceSignal, VoiceRoom } from './voiceRoom';

describe('voice signaling validation', () => {
  it('accepts SDP and ICE payloads but rejects arbitrary objects', () => {
    expect(isVoiceSignal({ type: 'offer', sdp: 'v=0' })).toBe(true);
    expect(isVoiceSignal({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host' })).toBe(true);
    expect(isVoiceSignal({ type: 'voice-state', speaking: true })).toBe(false);
  });

  it('notifies the UI when another vehicle starts and ends a call', () => {
    const onCall = vi.fn();
    const room = new VoiceRoom({
      memberId: 'car-2',
      getMemberToken: () => 'token',
      onStatus: vi.fn(),
      onSpeaking: vi.fn(),
      onCall,
    });

    room.handleMessage({ type: 'voice-call', memberId: 'car-1', active: true });
    room.handleMessage({ type: 'voice-call', memberId: 'car-1', active: false });

    expect(onCall).toHaveBeenNthCalledWith(1, 'car-1', true);
    expect(onCall).toHaveBeenNthCalledWith(2, 'car-1', false);
  });
});
