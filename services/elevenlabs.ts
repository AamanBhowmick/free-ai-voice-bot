import axios from 'axios';
import type { AxiosResponse } from 'axios';

interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

interface ElevenLabsTTSPayload {
  text: string;
  model_id: string;
  voice_settings: ElevenLabsVoiceSettings;
}

/**
 * synthesizeSpeech
 * Gets PCM audio from ElevenLabs and converts to G.711 µ-law 8kHz
 * (Twilio's native audio format).
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const voiceId: string = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
  const apiKey = process.env.ELEVENLABS_API_KEY ?? '';

  if (!apiKey || apiKey === 'your_elevenlabs_api_key') {
    throw new Error('ELEVENLABS_API_KEY is missing or not set in .env');
  }

  const payload: ElevenLabsTTSPayload = {
    text,
    model_id: 'eleven_turbo_v2',   // v2 — stable, well-supported
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  let response: AxiosResponse<ArrayBuffer>;

  try {
    response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_16000`,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      data: payload,
      responseType: 'arraybuffer',
      timeout: 20_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ElevenLabs HTTP error: ${msg}`);
  }

  const raw = Buffer.from(response.data);
  const contentType = response.headers?.['content-type'] as string ?? 'unknown';

  // ── Diagnostics ────────────────────────────────────────────────
  console.log(`📡 ElevenLabs response: ${raw.length} bytes | Content-Type: ${contentType}`);
  console.log(`🔬 First 16 bytes (hex): ${raw.slice(0, 16).toString('hex')}`);

  // If JSON came back, ElevenLabs returned an error
  if (contentType.includes('application/json') || isJsonBuffer(raw)) {
    const errText = raw.toString('utf8');
    throw new Error(`ElevenLabs API error: ${errText}`);
  }

  // Strip WAV header if present (pcm_* sometimes returns WAV-wrapped audio)
  const pcm16Buffer = stripWavHeader(raw);
  console.log(`🎙️ PCM16 after header strip: ${pcm16Buffer.length} bytes (~${(pcm16Buffer.length / 32000).toFixed(1)}s)`);

  // Convert 16kHz Int16LE PCM → 8kHz µ-law (G.711)
  const mulawBuffer = pcm16kToMulaw8k(pcm16Buffer);
  console.log(`✅ µ-law output: ${mulawBuffer.length} bytes (~${(mulawBuffer.length / 8000).toFixed(1)}s)`);

  return mulawBuffer;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Detect if the buffer looks like JSON (starts with { or [) */
function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length < 1) return false;
  const first = buf[0];
  return first === 0x7b || first === 0x5b; // '{' or '['
}

/** Strip RIFF/WAV container if present, returning raw audio payload */
function stripWavHeader(buffer: Buffer): Buffer {
  if (buffer.length < 12) return buffer;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') return buffer;

  console.log('📦 WAV container detected — stripping header');
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId   = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return buffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1; // WAV even-alignment
  }
  return buffer;
}

/**
 * Convert Int16LE PCM at 16kHz → µ-law bytes at 8kHz.
 * Downsamples 2:1 (simple decimation — fine for phone quality).
 * Encodes using standard ITU-T G.711 µ-law algorithm.
 */
function pcm16kToMulaw8k(pcmBuffer: Buffer): Buffer {
  const numInputSamples  = Math.floor(pcmBuffer.length / 2); // 2 bytes per Int16
  const numOutputSamples = Math.floor(numInputSamples / 2);  // 2:1 downsample
  const output = Buffer.alloc(numOutputSamples);

  for (let i = 0; i < numOutputSamples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 4); // stride=4: every other sample
    output[i] = g711Mulaw(sample);
  }

  return output;
}

/** Standard ITU-T G.711 µ-law encoder for a single 16-bit PCM sample */
function g711Mulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
