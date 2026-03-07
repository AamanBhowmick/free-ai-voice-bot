import WebSocket from 'ws';

type TranscriptCallback = (transcript: string, detectedLanguage: string) => void;

interface SarvamSTTSession {
  send: (mulawBuffer: Buffer) => void;
  close: () => void;
}

/**
 * G.711 µ-law decoder — converts a single µ-law byte to a 16-bit PCM sample.
 * This is the inverse of the ITU-T G.711 µ-law encoder.
 */
function decodeMulaw(mulawByte: number): number {
  mulawByte = ~mulawByte & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Convert a Buffer of µ-law 8kHz bytes to PCM Int16LE 8kHz.
 * Each µ-law byte → 2-byte Int16LE sample.
 */
function mulawToPcm16(mulawBuf: Buffer): Buffer {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = decodeMulaw(mulawBuf[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

/**
 * createSarvamSTTSession
 * Opens a WebSocket to Sarvam AI's streaming STT endpoint.
 * Receives Twilio µ-law 8kHz audio, decodes to PCM, and streams to Sarvam.
 *
 * Uses `saaras:v3` with `transcribe` mode and auto language detection.
 *
 * @param onTranscript - called with each final transcript and detected language
 * @returns session with .send() and .close() methods
 */
export function createSarvamSTTSession(onTranscript: TranscriptCallback): SarvamSTTSession {
  const apiKey = process.env.SARVAM_API_KEY ?? '';

  if (!apiKey || apiKey === 'your_sarvam_api_key') {
    console.error('❌ SARVAM_API_KEY is missing or not set in .env!');
    console.error('   Get your key at: https://console.sarvam.ai');
  } else {
    console.log(`🔑 Sarvam STT key loaded: ${apiKey.slice(0, 12)}...`);
  }

  // Build WebSocket URL with query parameters
  const wsUrl = new URL('wss://api.sarvam.ai/speech-to-text/ws');
  wsUrl.searchParams.set('api_subscription_key', apiKey);  // auth via query param
  wsUrl.searchParams.set('model', 'saaras:v3');
  wsUrl.searchParams.set('mode', 'transcribe');
  wsUrl.searchParams.set('language_code', 'unknown');       // auto-detect language
  wsUrl.searchParams.set('sample_rate', '8000');
  wsUrl.searchParams.set('input_audio_codec', 'pcm_s16le');
  wsUrl.searchParams.set('high_vad_sensitivity', 'true');
  wsUrl.searchParams.set('vad_signals', 'true');

  console.log(`🔗 Sarvam STT connecting to: ${wsUrl.toString().replace(apiKey, '***')}`);

  const ws = new WebSocket(wsUrl.toString(), {
    headers: {
      'api-subscription-key': apiKey,
    },
  });

  let isOpen = false;
  let pendingChunks: Buffer[] = [];

  ws.on('open', () => {
    isOpen = true;
    console.log('🎙️  Sarvam STT WebSocket opened');

    // Send any buffered audio
    for (const chunk of pendingChunks) {
      sendPcmChunk(chunk);
    }
    pendingChunks = [];
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'speech_start') {
        console.log('🗣️  Sarvam: speech detected');
      } else if (msg.type === 'speech_end') {
        console.log('🤫 Sarvam: speech ended');
      } else if (msg.type === 'transcript') {
        const text: string = msg.transcript ?? msg.text ?? '';
        const lang: string = msg.language_code ?? msg.lang ?? 'en-IN';
        if (text.trim()) {
          console.log(`📝 Sarvam STT [${lang}]: "${text.trim()}"`);
          onTranscript(text.trim(), lang);
        }
      } else {
        // Handle any other response formats
        const text = msg.transcript ?? msg.text ?? '';
        if (text && typeof text === 'string' && text.trim()) {
          const lang = msg.language_code ?? 'en-IN';
          console.log(`📝 Sarvam STT [${lang}]: "${text.trim()}"`);
          onTranscript(text.trim(), lang);
        }
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.error('❌ Sarvam STT parse error:', m, '| raw:', data.toString().slice(0, 200));
    }
  });

  ws.on('error', (err: Error) => {
    console.error('❌ Sarvam STT WebSocket error:', err.message);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    isOpen = false;
    console.log(`🎙️  Sarvam STT closed (code: ${code}, reason: ${reason.toString() || 'n/a'})`);
  });

  /**
   * Send a PCM16LE chunk as base64-encoded JSON to Sarvam.
   * Sarvam's streaming API expects: { "audio": "<base64>", "encoding": "pcm_s16le", "sample_rate": 8000 }
   */
  function sendPcmChunk(pcmBuffer: Buffer): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      audio: pcmBuffer.toString('base64'),
      encoding: 'pcm_s16le',
      sample_rate: 8000,
    }));
  }

  return {
    /**
     * Accepts raw µ-law 8kHz audio from Twilio, converts to PCM16LE,
     * and sends to Sarvam STT WebSocket.
     */
    send(mulawBuffer: Buffer): void {
      const pcmBuffer = mulawToPcm16(mulawBuffer);

      if (isOpen) {
        sendPcmChunk(pcmBuffer);
      } else {
        pendingChunks.push(pcmBuffer);
      }
    },

    close(): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
  };
}
