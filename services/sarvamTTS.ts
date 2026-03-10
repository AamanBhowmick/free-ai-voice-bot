import WebSocket from 'ws';

/**
 * Sarvam AI TTS — WebSocket Streaming
 *
 * Protocol:
 *   1. Connect to wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3
 *   2. Send config message (speaker, language, codec=mulaw, sample_rate=8000)
 *   3. Send text message
 *   4. Send flush message
 *   5. Receive audio chunks (base64-encoded mulaw) progressively
 *
 * This gives us mulaw 8kHz directly — zero conversion needed for Twilio!
 */

interface TTSStreamOptions {
  text: string;
  language: string;
  onAudioChunk: (mulawBuffer: Buffer) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

/**
 * sarvamStreamTTS
 * Opens a WebSocket to Sarvam TTS, streams text, and calls back with
 * mulaw audio chunks as they arrive. Much lower latency than REST.
 */
export function sarvamStreamTTS(options: TTSStreamOptions): void {
  const { text, language, onAudioChunk, onDone, onError } = options;
  const apiKey = process.env.SARVAM_API_KEY ?? '';
  const speaker = (process.env.SARVAM_TTS_SPEAKER ?? 'simran').toLowerCase();

  if (!apiKey) {
    onError(new Error('SARVAM_API_KEY is missing'));
    return;
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

  ws.on('open', () => {
    // Step 1: Send config
    const configMsg = {
      type: 'config',
      data: {
        speaker,
        target_language_code: langCode,
        output_audio_codec: 'mulaw',
      },
    };
    console.log('📤 TTS WS config:', JSON.stringify(configMsg));
    ws.send(JSON.stringify(configMsg));

    // Step 2: Send text
    const textMsg = { type: 'text', data: { text } };
    console.log('📤 TTS WS text:', JSON.stringify(textMsg).slice(0, 200));
    ws.send(JSON.stringify(textMsg));

    // Step 3: Flush to trigger generation
    ws.send(JSON.stringify({ type: 'flush' }));
    console.log('📤 TTS WS flush sent');
  });

  ws.on('message', (rawData: WebSocket.Data) => {
    try {
      const msg = JSON.parse(rawData.toString());

      // Audio chunk received
      if (msg.type === 'audio' && msg.data?.audio) {
        const rawChunk = Buffer.from(msg.data.audio, 'base64');
        const audioChunk = downsampleMulaw(rawChunk, 24000, 8000);
        chunkCount++;
        totalBytes += audioChunk.length;
        onAudioChunk(audioChunk);
      }
      // Completion event
      else if (msg.type === 'event' && msg.data?.event_type === 'final') {
        console.log(`🎵 TTS stream done: ${chunkCount} chunks, ${totalBytes}B (~${(totalBytes / 8000).toFixed(1)}s)`);
        ws.close();
        onDone();
      }
      // Log other messages (errors, etc.)
      else {
        console.log('📥 TTS WS msg:', JSON.stringify(msg).slice(0, 300));
      }
    } catch (err: unknown) {
      // Binary audio data (non-JSON)
      if (Buffer.isBuffer(rawData)) {
        const audioChunk = downsampleMulaw(rawData, 24000, 8000);
        chunkCount++;
        totalBytes += audioChunk.length;
        onAudioChunk(audioChunk);
      } else {
        console.log('📥 TTS WS raw:', rawData.toString().slice(0, 300));
      }
    }
  });

  ws.on('error', (err: Error) => {
    console.error('❌ TTS stream WS error:', err.message);
    onError(err);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    if (chunkCount === 0) {
      console.error(`❌ TTS stream closed without audio (code: ${code}, reason: ${reason.toString() || 'n/a'})`);
      onError(new Error(`TTS stream closed without audio (code: ${code})`));
    }
  });
}

/**
 * sarvamSynthesizeSpeech (Promise-based wrapper)
 * For backward compatibility: collects all streaming chunks into a single buffer.
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

/**
 * Downsample mulaw audio by picking every Nth sample.
 * Mulaw = 1 byte per sample, so 24kHz→8kHz = take every 3rd byte.
 */
function downsampleMulaw(buf: Buffer, srcRate: number, targetRate: number): Buffer {
  if (srcRate === targetRate) return buf;
  const ratio = Math.round(srcRate / targetRate); // 24000/8000 = 3
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
