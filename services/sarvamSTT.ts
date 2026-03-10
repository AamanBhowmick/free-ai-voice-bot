import { SarvamAIClient } from 'sarvamai';
import { Readable } from 'stream';

type TranscriptCallback = (transcript: string, detectedLanguage: string) => void;

interface SarvamSTTSession {
  send: (mulawBuffer: Buffer) => void;
  close: () => void;
  mute: (durationMs: number) => void;
}

// ── µ-law decoder ──────────────────────────────────────────────────

function decodeMulaw(mulawByte: number): number {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function mulawToPcm16(mulawBuf: Buffer): Buffer {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(decodeMulaw(mulawBuf[i]), i * 2);
  }
  return pcm;
}

// ── WAV header builder ─────────────────────────────────────────────

function buildWavHeader(dataLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // PCM chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);   // sample rate
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// ── Silence detection helpers ──────────────────────────────────────

/**
 * Calculate RMS (root mean square) amplitude of a PCM16LE buffer.
 * Returns a value between 0 and ~32768.
 */
function calcRMS(pcmBuf: Buffer): number {
  const samples = Math.floor(pcmBuf.length / 2);
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

// ── Main Session ───────────────────────────────────────────────────

/**
 * createSarvamSTTSession
 *
 * Uses Sarvam AI's REST STT (Saaras v3) with chunked audio.
 * Accumulates audio from Twilio, detects silence via amplitude,
 * then sends the chunk as a WAV file to Sarvam for transcription.
 *
 * Captures both Hindi and English with auto-detection.
 */
export function createSarvamSTTSession(onTranscript: TranscriptCallback): SarvamSTTSession {
  const apiKey = process.env.SARVAM_API_KEY ?? '';

  if (!apiKey || apiKey === 'your_sarvam_api_key') {
    console.error('❌ SARVAM_API_KEY is missing!');
  } else {
    console.log(`🔑 Sarvam STT key loaded: ${apiKey.slice(0, 12)}...`);
  }

  const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });

  // Audio accumulation state
  const pcmChunks: Buffer[] = [];
  let totalPcmBytes = 0;
  let silenceFrames = 0;
  let speechDetected = false;
  let isProcessing = false;
  let closed = false;
  let mutedUntil = 0;

  // Tuning constants (optimized for speed)
  const SILENCE_THRESHOLD = 150;    // RMS below this = silence
  const SILENCE_FRAMES_NEEDED = 8;  // ~8 frames of silence = ~1s (let user finish sentence)
  const MIN_SPEECH_BYTES = 3200;    // minimum ~0.2s of audio to process
  const MAX_SPEECH_BYTES = 240000;  // max ~15s of audio before force-flush

  /**
   * Process a µ-law audio chunk from Twilio.
   * Converts mulaw→PCM, accumulates, and detects speech boundaries.
   */
  function processAudio(mulawBuffer: Buffer): void {
    if (closed || isProcessing || Date.now() < mutedUntil) return;

    const pcmBuffer = mulawToPcm16(mulawBuffer);
    const rms = calcRMS(pcmBuffer);

    if (rms > SILENCE_THRESHOLD) {
      // Speech detected
      speechDetected = true;
      silenceFrames = 0;
      pcmChunks.push(pcmBuffer);
      totalPcmBytes += pcmBuffer.length;
    } else if (speechDetected) {
      // Silence after speech
      silenceFrames++;
      pcmChunks.push(pcmBuffer); // include trailing silence for cleaner cutoff
      totalPcmBytes += pcmBuffer.length;

      if (silenceFrames >= SILENCE_FRAMES_NEEDED && totalPcmBytes >= MIN_SPEECH_BYTES) {
        // End of speech segment — flush to STT
        flushToSTT();
      }
    }

    // Force flush if too much audio accumulated (prevents very long speeches from being lost)
    if (totalPcmBytes >= MAX_SPEECH_BYTES) {
      flushToSTT();
    }
  }

  /**
   * Send accumulated audio to Sarvam REST STT.
   */
  async function flushToSTT(): Promise<void> {
    if (pcmChunks.length === 0 || isProcessing) return;

    isProcessing = true;

    // Grab the accumulated PCM data and reset
    const pcmData = Buffer.concat(pcmChunks);
    pcmChunks.length = 0;
    totalPcmBytes = 0;
    silenceFrames = 0;
    speechDetected = false;

    const duration = (pcmData.length / (8000 * 2)).toFixed(1);
    console.log(`🎤 Sending ${pcmData.length}B (~${duration}s) to Sarvam STT...`);

    try {
      // Build WAV file from PCM data
      const wavHeader = buildWavHeader(pcmData.length, 8000);
      const wavBuffer = Buffer.concat([wavHeader, pcmData]);

      // Create a readable stream from the WAV buffer for the SDK
      const audioStream = Readable.from(wavBuffer);

      const result = await client.speechToText.transcribe({
        file: audioStream,
        model: 'saaras:v3',
        language_code: 'unknown',  // auto-detect Hindi/English
      });

      const transcript = (result as any).transcript ?? '';
      const langCode = (result as any).language_code ?? 'en-IN';

      if (transcript.trim()) {
        console.log(`📝 Sarvam STT [${langCode}]: "${transcript.trim()}"`);
        onTranscript(transcript.trim(), langCode);
      } else {
        console.log('📝 Sarvam STT: (empty transcript)');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('❌ Sarvam STT error:', msg);
    } finally {
      isProcessing = false;
    }
  }

  return {
    send(mulawBuffer: Buffer): void {
      processAudio(mulawBuffer);
    },
    close(): void {
      closed = true;
      if (pcmChunks.length > 0 && totalPcmBytes >= MIN_SPEECH_BYTES) {
        flushToSTT();
      }
      console.log('🎙️  Sarvam STT session closed');
    },
    /** Mute STT for durationMs ms (prevents greeting/TTS echo pickup) */
    mute(durationMs: number): void {
      mutedUntil = Date.now() + durationMs;
      pcmChunks.length = 0;
      totalPcmBytes = 0;
      silenceFrames = 0;
      speechDetected = false;
    },
  };
}
