import { SarvamAIClient } from 'sarvamai';
import { Readable } from 'stream';

type TranscriptCallback = (transcript: string, detectedLanguage: string) => void;
type InterruptCallback = () => void;

interface SarvamSTTSession {
  send: (mulawBuffer: Buffer) => void;
  close: () => void;
  mute: (durationMs: number) => void;
  /** Set to true while bot is speaking — STT will detect speech as barge-in */
  setBotSpeaking: (speaking: boolean) => void;
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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// ── Silence detection helpers ──────────────────────────────────────

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
 * Uses Sarvam AI's REST STT with chunked audio.
 * Supports barge-in: when botSpeaking=true, detects loud speech
 * and fires the onInterrupt callback to cancel the bot's TTS.
 *
 * @param onTranscript - called with finished transcript + detected language
 * @param onInterrupt  - called when user speaks while bot is talking (barge-in)
 */
export function createSarvamSTTSession(
  onTranscript: TranscriptCallback,
  onInterrupt: InterruptCallback
): SarvamSTTSession {
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
  let botSpeaking = false;
  let bargeInFrames = 0;

  // Tuning constants
  const SILENCE_THRESHOLD = 150;
  const SILENCE_FRAMES_NEEDED = 8;   // ~1s for user to finish
  const MIN_SPEECH_BYTES = 3200;
  const MAX_SPEECH_BYTES = 240000;
  const BARGE_IN_THRESHOLD = 250;    // Higher threshold for barge-in (must speak clearly)
  const BARGE_IN_FRAMES = 3;         // ~0.4s of loud speech = definite barge-in

  function processAudio(mulawBuffer: Buffer): void {
    if (closed) return;

    // Skip if hard-muted (greeting only)
    if (Date.now() < mutedUntil) return;

    const pcmBuffer = mulawToPcm16(mulawBuffer);
    const rms = calcRMS(pcmBuffer);

    // ── Barge-in detection: user speaking while bot talks ──
    if (botSpeaking) {
      if (rms > BARGE_IN_THRESHOLD) {
        bargeInFrames++;
        if (bargeInFrames >= BARGE_IN_FRAMES) {
          console.log('🗣️  BARGE-IN detected! User is interrupting.');
          bargeInFrames = 0;
          botSpeaking = false;
          isProcessing = false;

          // Clear any accumulated audio
          pcmChunks.length = 0;
          totalPcmBytes = 0;
          silenceFrames = 0;
          speechDetected = false;

          // Fire interrupt callback
          onInterrupt();
        }
      } else {
        bargeInFrames = 0;
      }
      return; // Don't accumulate audio while bot is speaking
    }

    // ── Normal speech accumulation ──
    if (isProcessing) return;

    if (rms > SILENCE_THRESHOLD) {
      speechDetected = true;
      silenceFrames = 0;
      pcmChunks.push(pcmBuffer);
      totalPcmBytes += pcmBuffer.length;
    } else if (speechDetected) {
      silenceFrames++;
      pcmChunks.push(pcmBuffer);
      totalPcmBytes += pcmBuffer.length;

      if (silenceFrames >= SILENCE_FRAMES_NEEDED && totalPcmBytes >= MIN_SPEECH_BYTES) {
        flushToSTT();
      }
    }

    if (totalPcmBytes >= MAX_SPEECH_BYTES) {
      flushToSTT();
    }
  }

  async function flushToSTT(): Promise<void> {
    if (pcmChunks.length === 0 || isProcessing) return;

    isProcessing = true;

    const pcmData = Buffer.concat(pcmChunks);
    pcmChunks.length = 0;
    totalPcmBytes = 0;
    silenceFrames = 0;
    speechDetected = false;

    const duration = (pcmData.length / (8000 * 2)).toFixed(1);
    console.log(`🎤 Sending ${pcmData.length}B (~${duration}s) to Sarvam STT...`);

    try {
      const wavHeader = buildWavHeader(pcmData.length, 8000);
      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const audioStream = Readable.from(wavBuffer);

      const result = await client.speechToText.transcribe({
        file: audioStream,
        model: 'saaras:v3',
        language_code: 'unknown',
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
    mute(durationMs: number): void {
      mutedUntil = Date.now() + durationMs;
      pcmChunks.length = 0;
      totalPcmBytes = 0;
      silenceFrames = 0;
      speechDetected = false;
    },
    setBotSpeaking(speaking: boolean): void {
      botSpeaking = speaking;
      bargeInFrames = 0;
      if (!speaking) {
        // Clear accumulated audio when bot stops speaking
        pcmChunks.length = 0;
        totalPcmBytes = 0;
        silenceFrames = 0;
        speechDetected = false;
      }
    },
  };
}
