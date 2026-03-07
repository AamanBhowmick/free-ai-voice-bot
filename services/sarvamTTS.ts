import axios from 'axios';
import type { AxiosResponse } from 'axios';

interface SarvamTTSRequest {
  inputs: string[];
  target_language_code: string;
  speaker: string;
  model: string;
  pace: number;
  sample_rate: number;
}

interface SarvamTTSResponse {
  request_id: string;
  audios: string[];   // base64-encoded WAV audio
}

/**
 * sarvamSynthesizeSpeech
 * Calls Sarvam AI TTS REST API (Bulbul v3) and returns a Buffer of
 * raw µ-law 8kHz bytes ready for Twilio.
 *
 * Sarvam returns a WAV file (PCM Int16LE, typically 22050 Hz).
 * Pipeline:  WAV → strip header → downsample to 8kHz → G.711 µ-law encode.
 */
export async function sarvamSynthesizeSpeech(
  text: string,
  language: string = 'en-IN'
): Promise<Buffer> {
  const apiKey = process.env.SARVAM_API_KEY ?? '';
  const speaker = (process.env.SARVAM_TTS_SPEAKER ?? 'simran').toLowerCase();

  if (!apiKey || apiKey === 'your_sarvam_api_key') {
    throw new Error('SARVAM_API_KEY is missing or not set in .env');
  }

  const langCode = normalizeLangCode(language);

  const payload: SarvamTTSRequest = {
    inputs: [text],
    target_language_code: langCode,
    speaker,
    model: 'bulbul:v3',
    pace: 1.0,
    sample_rate: 8000,  // request 8kHz (Sarvam may still return higher)
  };

  let response: AxiosResponse<SarvamTTSResponse>;

  try {
    response = await axios({
      method: 'POST',
      url: 'https://api.sarvam.ai/text-to-speech',
      headers: {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json',
      },
      data: payload,
      timeout: 20_000,
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const errBody = err.response.data;
      const errText = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
      throw new Error(`Sarvam TTS HTTP ${err.response.status}: ${errText}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Sarvam TTS error: ${msg}`);
  }

  const audios = response.data?.audios;
  if (!audios || audios.length === 0 || !audios[0]) {
    throw new Error('Sarvam TTS returned empty audio');
  }

  // Decode base64 → raw bytes (could be WAV or raw PCM)
  const rawBuffer = Buffer.from(audios[0], 'base64');

  // Parse the audio, handling WAV or raw PCM
  const { pcmData, sampleRate } = parseAudioBuffer(rawBuffer);

  // Downsample from source rate to 8000 Hz, then encode as µ-law
  const mulawBuffer = pcmToMulaw8k(pcmData, sampleRate);

  console.log(
    `🎵 Sarvam TTS [${langCode}/${speaker}]: ` +
    `WAV ${rawBuffer.length}B (${sampleRate}Hz) → µ-law ${mulawBuffer.length}B (~${(mulawBuffer.length / 8000).toFixed(1)}s)`
  );

  return mulawBuffer;
}

// ── Audio Parsing ────────────────────────────────────────────────────

interface ParsedAudio {
  pcmData: Buffer;
  sampleRate: number;
}

/**
 * Parse audio buffer — detect WAV headers and extract PCM data + sample rate.
 */
function parseAudioBuffer(buf: Buffer): ParsedAudio {
  // Check for WAV RIFF header
  if (buf.length > 44 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);

    // Find 'data' chunk (usually at offset 36, but can vary)
    let dataOffset = 12;
    while (dataOffset < buf.length - 8) {
      const chunkId = buf.subarray(dataOffset, dataOffset + 4).toString('ascii');
      const chunkSize = buf.readUInt32LE(dataOffset + 4);
      if (chunkId === 'data') {
        dataOffset += 8; // skip chunk header
        break;
      }
      dataOffset += 8 + chunkSize;
    }

    console.log(
      `📦 WAV: ${sampleRate}Hz, ${bitsPerSample}bit, data@${dataOffset}, ` +
      `${buf.length - dataOffset}B audio`
    );

    return {
      pcmData: buf.subarray(dataOffset),
      sampleRate,
    };
  }

  // Not WAV — assume raw PCM Int16LE at 8kHz
  console.log(`📦 Raw PCM: ${buf.length}B assumed 8kHz`);
  return { pcmData: buf, sampleRate: 8000 };
}

// ── Sample Rate Conversion + µ-law Encoding ─────────────────────────

/**
 * Downsample PCM Int16LE from `srcRate` to 8000 Hz, then G.711 µ-law encode.
 * Uses linear interpolation for smooth downsampling.
 */
function pcmToMulaw8k(pcmBuffer: Buffer, srcRate: number): Buffer {
  const TARGET_RATE = 8000;
  const srcSamples = Math.floor(pcmBuffer.length / 2);

  if (srcRate === TARGET_RATE) {
    // No downsampling needed — just encode
    const output = Buffer.alloc(srcSamples);
    for (let i = 0; i < srcSamples; i++) {
      output[i] = g711Mulaw(pcmBuffer.readInt16LE(i * 2));
    }
    return output;
  }

  // Downsample with linear interpolation
  const ratio = srcRate / TARGET_RATE;
  const outSamples = Math.floor(srcSamples / ratio);
  const output = Buffer.alloc(outSamples);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;

    // Linear interpolation between adjacent samples
    const s0 = idx < srcSamples ? pcmBuffer.readInt16LE(idx * 2) : 0;
    const s1 = (idx + 1) < srcSamples ? pcmBuffer.readInt16LE((idx + 1) * 2) : s0;
    const sample = Math.round(s0 + frac * (s1 - s0));

    output[i] = g711Mulaw(sample);
  }

  return output;
}

/** Standard ITU-T G.711 µ-law encoder */
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

// ── Language Code Normalization ─────────────────────────────────────

function normalizeLangCode(lang: string): string {
  const l = lang.toLowerCase();
  if (l.startsWith('hi')) return 'hi-IN';
  if (l.startsWith('en')) return 'en-IN';
  if (l.startsWith('bn')) return 'bn-IN';
  if (l.startsWith('ta')) return 'ta-IN';
  if (l.startsWith('te')) return 'te-IN';
  if (l.startsWith('kn')) return 'kn-IN';
  if (l.startsWith('ml')) return 'ml-IN';
  if (l.startsWith('mr')) return 'mr-IN';
  if (l.startsWith('gu')) return 'gu-IN';
  if (l.startsWith('pa')) return 'pa-IN';
  if (l.startsWith('od') || l.startsWith('or')) return 'od-IN';
  return 'en-IN';
}
