import WebSocket from 'ws';

/**
 * Sarvam AI TTS — WebSocket Streaming with Barge-In Support
 *
 * Protocol:
 *   1. Connect to wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3
 *   2. Send config message (speaker, language, codec=mulaw)
 *   3. Send text message
 *   4. Send flush message
 *   5. Receive audio chunks (base64-encoded mulaw) progressively
 *
 * Returns a cancel() function for barge-in interruption.
 */

interface TTSStreamOptions {
  text: string;
  language: string;
  onAudioChunk: (mulawBuffer: Buffer) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

/** Handle returned by sarvamStreamTTS — call cancel() to stop mid-stream */
export interface TTSHandle {
  cancel: () => void;
}

/**
 * sarvamStreamTTS
 * Opens a WebSocket to Sarvam TTS, streams text, and calls back with
 * mulaw audio chunks as they arrive.
 *
 * Returns a TTSHandle with a cancel() method for barge-in.
 */
export function sarvamStreamTTS(options: TTSStreamOptions): TTSHandle {
  const { text, language, onAudioChunk, onDone, onError } = options;
  const apiKey = process.env.SARVAM_API_KEY ?? '';
  const speaker = (process.env.SARVAM_TTS_SPEAKER ?? 'simran').toLowerCase();

  let cancelled = false;

  if (!apiKey) {
    onError(new Error('SARVAM_API_KEY is missing'));
    return { cancel: () => {} };
  }

  const langCode = normalizeLangCode(language);

  const wsUrl = new URL('wss://api.sarvam.ai/text-to-speech/ws');
  wsUrl.searchParams.set('model', 'bulbul:v3');
  wsUrl.searchParams.set('send_completion_event', 'true');
  wsUrl.searchParams.set('api_subscription_key', apiKey);

  const ws = new WebSocket(wsUrl.toString(), {
    headers: { 'api-subscription-key': apiKey },
  });

  let chunkCount = 0;
  let totalBytes = 0;
  let resolved = false;

  function finish() {
    if (resolved) return;
    resolved = true;
    if (cancelled) return; // Don't call onDone if cancelled
    onDone();
  }

  ws.on('open', () => {
    if (cancelled) { ws.close(); return; }

    // Step 1: Send config
    ws.send(JSON.stringify({
      type: 'config',
      data: {
        speaker,
        target_language_code: langCode,
        output_audio_codec: 'mulaw',
      },
    }));

    // Step 2: Send text
    ws.send(JSON.stringify({ type: 'text', data: { text } }));

    // Step 3: Flush
    ws.send(JSON.stringify({ type: 'flush' }));
  });

  ws.on('message', (rawData: WebSocket.Data) => {
    if (cancelled) return;

    try {
      const msg = JSON.parse(rawData.toString());

      if (msg.type === 'audio' && msg.data?.audio) {
        const rawChunk = Buffer.from(msg.data.audio, 'base64');
        const audioChunk = downsampleMulaw(rawChunk, 24000, 8000);
        chunkCount++;
        totalBytes += audioChunk.length;
        onAudioChunk(audioChunk);
      } else if (msg.type === 'event' && msg.data?.event_type === 'final') {
        console.log(`🎵 TTS done: ${chunkCount} chunks, ${totalBytes}B (~${(totalBytes / 8000).toFixed(1)}s)`);
        ws.close();
        finish();
      } else if (msg.type === 'error') {
        console.log('📥 TTS error:', JSON.stringify(msg).slice(0, 300));
      }
    } catch {
      if (Buffer.isBuffer(rawData) && !cancelled) {
        const audioChunk = downsampleMulaw(rawData, 24000, 8000);
        chunkCount++;
        totalBytes += audioChunk.length;
        onAudioChunk(audioChunk);
      }
    }
  });

  ws.on('error', (err: Error) => {
    if (!cancelled) {
      console.error('❌ TTS WS error:', err.message);
      onError(err);
    }
  });

  ws.on('close', (code: number) => {
    if (chunkCount === 0 && !cancelled && !resolved) {
      console.error(`❌ TTS closed without audio (code: ${code})`);
      onError(new Error(`TTS closed without audio (code: ${code})`));
    }
  });

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      console.log('🛑 TTS cancelled (barge-in)');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (!resolved) {
        resolved = true;
      }
    },
  };
}

/**
 * sarvamSynthesizeSpeech (Promise-based wrapper)
 * Collects all streaming chunks into a single buffer.
 * Used for greeting pre-caching.
 */
export function sarvamSynthesizeSpeech(
  text: string,
  language: string = 'en-IN'
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    sarvamStreamTTS({
      text,
      language,
      onAudioChunk: (chunk) => chunks.push(chunk),
      onDone: () => resolve(Buffer.concat(chunks)),
      onError: (err) => reject(err),
    });
  });
}

// ── Mulaw downsampling ─────────────────────────────────────────────

function downsampleMulaw(buf: Buffer, srcRate: number, targetRate: number): Buffer {
  if (srcRate === targetRate) return buf;
  const ratio = Math.round(srcRate / targetRate);
  const outLen = Math.floor(buf.length / ratio);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = buf[i * ratio];
  }
  return out;
}

// ── Language normalization ──────────────────────────────────────────

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
