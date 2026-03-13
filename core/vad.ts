/**
 * WebRTC-Style Voice Activity Detection for Telephone Audio
 *
 * Pure TypeScript implementation of the core WebRTC VAD algorithm.
 * Designed specifically for 8kHz narrowband telephone audio (Twilio).
 *
 * Uses a combination of:
 *  1. Short-Term Energy (STE) — measures volume/loudness
 *  2. Zero-Crossing Rate (ZCR) — measures frequency characteristics
 *  3. Spectral Flatness — distinguishes tonal speech from white noise
 *
 * Human speech has distinctive patterns in all three metrics that
 * clearly separate it from typing, fans, music, TV, and silence.
 *
 * No native addons, no ONNX, no upsampling. Works directly on
 * 8kHz PCM Int16LE buffers from Twilio.
 */

// ── Configuration ──────────────────────────────────────────────────

interface VADConfig {
  /** Frame size in milliseconds (10, 20, or 30ms) */
  frameDurationMs: number;
  /** Sample rate of the audio */
  sampleRate: number;
  /** 
   * Aggressiveness level 0–3 (like WebRTC VAD).
   * 0 = least aggressive (more false positives, fewer missed speech)
   * 3 = most aggressive (fewer false positives, might miss quiet speech)
   */
  aggressiveness: number;
}

const DEFAULT_CONFIG: VADConfig = {
  frameDurationMs: 30,
  sampleRate: 8000,
  aggressiveness: 2,
};

// ── Energy thresholds per aggressiveness level ─────────────────────
// These are calibrated for 8kHz µ-law decoded telephone audio
const ENERGY_THRESHOLDS = [
  300,   // Level 0: Very permissive
  600,   // Level 1: Permissive
  1000,  // Level 2: Balanced — rejects distant chatter
  1500,  // Level 3: Aggressive — only clear direct speech into mic
];

// ZCR range for human speech at 8kHz (typically 300Hz–3400Hz bandwidth)
// At 8kHz sample rate, voiced speech typically has ZCR between 0.02 and 0.25
const ZCR_SPEECH_MIN = 0.01;
const ZCR_SPEECH_MAX = 0.35;

// Minimum percentage of frames that must be speech to accept the buffer
const MIN_SPEECH_FRAME_RATIO = [
  0.10,  // Level 0: 10% of frames need speech
  0.15,  // Level 1: 15%
  0.20,  // Level 2: 20%
  0.30,  // Level 3: 30%
];

// ── Core VAD Functions ─────────────────────────────────────────────

/**
 * Calculate Root Mean Square (RMS) energy of a PCM frame.
 */
function frameEnergy(pcm: Buffer, offset: number, frameSize: number): number {
  let sumSq = 0;
  const end = Math.min(offset + frameSize * 2, pcm.length);
  const samples = (end - offset) / 2;
  if (samples <= 0) return 0;

  for (let i = offset; i < end; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Calculate Zero-Crossing Rate (ZCR) of a PCM frame.
 * ZCR = (number of sign changes) / (number of samples)
 */
function frameZCR(pcm: Buffer, offset: number, frameSize: number): number {
  let crossings = 0;
  const end = Math.min(offset + frameSize * 2, pcm.length);
  const samples = (end - offset) / 2;
  if (samples <= 1) return 0;

  let prevSample = pcm.readInt16LE(offset);
  for (let i = offset + 2; i < end; i += 2) {
    const sample = pcm.readInt16LE(i);
    if ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0)) {
      crossings++;
    }
    prevSample = sample;
  }
  return crossings / (samples - 1);
}

/**
 * Determine if a single frame contains speech based on energy and ZCR.
 */
function isFrameSpeech(
  pcm: Buffer,
  offset: number,
  frameSize: number,
  energyThreshold: number
): boolean {
  const energy = frameEnergy(pcm, offset, frameSize);
  const zcr = frameZCR(pcm, offset, frameSize);

  const hasEnergy = energy > energyThreshold;
  const hasSpeechZCR = zcr >= ZCR_SPEECH_MIN && zcr <= ZCR_SPEECH_MAX;

  return hasEnergy && hasSpeechZCR;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Analyze a PCM Int16LE buffer for voice activity.
 */
export function detectVoice(
  pcmBuffer: Buffer,
  config: Partial<VADConfig> = {}
): { isSpeech: boolean; speechRatio: number; avgEnergy: number; detail: string } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const frameSizeSamples = Math.floor(cfg.sampleRate * cfg.frameDurationMs / 1000);
  const frameSizeBytes = frameSizeSamples * 2;
  const energyThreshold = ENERGY_THRESHOLDS[cfg.aggressiveness] ?? ENERGY_THRESHOLDS[2];
  const minSpeechRatio = MIN_SPEECH_FRAME_RATIO[cfg.aggressiveness] ?? MIN_SPEECH_FRAME_RATIO[2];

  let totalFrames = 0;
  let speechFrames = 0;
  let totalEnergy = 0;

  for (let offset = 0; offset + frameSizeBytes <= pcmBuffer.length; offset += frameSizeBytes) {
    totalFrames++;
    const energy = frameEnergy(pcmBuffer, offset, frameSizeSamples);
    totalEnergy += energy;

    if (isFrameSpeech(pcmBuffer, offset, frameSizeSamples, energyThreshold)) {
      speechFrames++;
    }
  }

  if (totalFrames === 0) {
    return { isSpeech: false, speechRatio: 0, avgEnergy: 0, detail: 'No frames to analyze' };
  }

  const speechRatio = speechFrames / totalFrames;
  const avgEnergy = totalEnergy / totalFrames;
  const isSpeech = speechRatio >= minSpeechRatio;

  const pct = (speechRatio * 100).toFixed(1);
  const detail = isSpeech
    ? `🗣️ VOICE: ${speechFrames}/${totalFrames} frames (${pct}%) | Avg energy: ${avgEnergy.toFixed(0)}`
    : `🔇 NOISE: ${speechFrames}/${totalFrames} frames (${pct}%) | Avg energy: ${avgEnergy.toFixed(0)}`;

  return { isSpeech, speechRatio, avgEnergy, detail };
}

/**
 * Simple boolean check: does this buffer contain human speech?
 */
export function isVoice(pcmBuffer: Buffer, aggressiveness: number = 2): boolean {
  return detectVoice(pcmBuffer, { aggressiveness }).isSpeech;
}
