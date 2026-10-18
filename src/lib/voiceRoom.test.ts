import { describe, expect, it } from 'vitest';
import { isVoiceSignal } from './voiceRoom';

describe('voice signaling validation', () => {
  it('accepts SDP and ICE payloads but rejects arbitrary objects', () => {
    expect(isVoiceSignal({ type: 'offer', sdp: 'v=0' })).toBe(true);
    expect(isVoiceSignal({ candidate: 'candidate:1 1 UDP 1 127.0.0.1 9 typ host' })).toBe(true);
    expect(isVoiceSignal({ type: 'voice-state', speaking: true })).toBe(false);
  });
});
