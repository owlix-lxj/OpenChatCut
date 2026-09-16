import assert from 'node:assert/strict';
import { avatarAudioWithinLimit } from './digitalHumanFlow';
import type { MediaAsset } from './types';

const audio = (durationInFrames: number): MediaAsset => ({
  id: 'voice', name: 'voice.wav', kind: 'audio', src: '/media/uploads/voice.wav', durationInFrames,
});

assert.equal(avatarAudioWithinLimit(audio(450), 30), true, 'exactly 15 seconds is accepted');
assert.equal(avatarAudioWithinLimit(audio(451), 30), false, 'audio beyond 15 seconds is rejected');
assert.equal(avatarAudioWithinLimit({ ...audio(300), kind: 'video' }, 30), false, 'non-audio assets are rejected');

console.log('digital human flow checks passed');
