import { WebSocket } from 'ws';
import { createDeepgramSession } from '../services/deepgram';
import { getStreamingResponse } from '../services/gemini';
import { synthesizeSpeech } from '../services/elevenlabs';

interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  start?: { streamSid: string; accountSid: string; callSid: string };
  media?: { track: string; chunk: string; timestamp: string; payload: string };
  stop?: { accountSid: string; callSid: string };
}

const GREETING_TEXT = "Hey! This is Alex, your trainer. How can I help you today?";

// ── Pre-cache greeting at server start for zero-latency playback ──
let cachedGreetingAudio: Buffer | null = null;

export async function preGenerateGreeting(): Promise<void> {
  try {
    console.log('⏳ Pre-generating greeting audio...');
    cachedGreetingAudio = await synthesizeSpeech(GREETING_TEXT);
    console.log(`✅ Greeting pre-cached (${cachedGreetingAudio.length} bytes, ~${(cachedGreetingAudio.length / 8000).toFixed(1)}s)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to pre-cache greeting:', msg);
  }
}

/**
 * handleMediaStream
 * Orchestrates the full AI pipeline for a single Twilio Media Stream:
 *   Twilio audio → Deepgram STT → Gemini AI (streaming) → ElevenLabs TTS → Twilio audio
 */
function handleMediaStream(twilioWs: WebSocket): void {
  console.log('\n🔗 New call connected – AI pipeline starting');

  let streamSid: string | null = null;
  let isProcessing = false;
  let audioQueue: Promise<void> = Promise.resolve();

  // ── Deepgram STT session ──────────────────────────────────
  const dgSession = createDeepgramSession(async (transcript: string) => {
    if (!transcript.trim() || isProcessing) return;

    console.log(`\n👤 Caller said: "${transcript}"`);
    isProcessing = true;

    audioQueue = audioQueue.then(async () => {
      try {
        let buffer = '';

        for await (const chunk of getStreamingResponse(transcript)) {
          buffer += chunk;

          // Send sentence-by-sentence as soon as punctuation arrives (low-latency TTS)
          if (/[.!?]/.test(buffer)) {
            const sentence = buffer.trim();
            buffer = '';
            if (sentence) {
              console.log(`🤖 AI: "${sentence}"`);
              await sendTextAsAudio(sentence, twilioWs, streamSid);
            }
          }
        }

        // Flush trailing text
        if (buffer.trim()) {
          console.log(`🤖 AI (flush): "${buffer.trim()}"`);
          await sendTextAsAudio(buffer.trim(), twilioWs, streamSid);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('❌ Pipeline error:', msg);
      } finally {
        isProcessing = false;
      }
    });
  });

  // ── Handle Twilio WebSocket messages ─────────────────────
  twilioWs.on('message', (rawData: Buffer | string) => {
    try {
      const msg: TwilioMediaMessage = JSON.parse(rawData.toString());

      switch (msg.event) {
        case 'connected':
          console.log('📡 Twilio Media Stream connected');
          break;

        case 'start':
          streamSid = msg.start?.streamSid ?? null;
          console.log(`▶️  Stream SID: ${streamSid}`);
          // Send greeting immediately (use cache if available)
          greetCaller(twilioWs, streamSid);
          break;

        case 'media':
          if (msg.media?.track === 'inbound' && dgSession) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            dgSession.send(audioBuffer as unknown as Blob);
          }
          break;

        case 'stop':
          console.log('⏹️  Stream stopped');
          break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('❌ Error parsing Twilio message:', message);
    }
  });

  twilioWs.on('close', () => {
    console.log('🔌 Call ended – WebSocket closed\n');
    dgSession?.finish();
  });

  twilioWs.on('error', (err: Error) => {
    console.error('❌ Twilio WS error:', err.message);
  });
}

// ── Greet caller — use pre-cached audio or generate on demand ──────
async function greetCaller(twilioWs: WebSocket, streamSid: string | null): Promise<void> {
  console.log(`👋 Sending greeting (cache: ${cachedGreetingAudio ? 'HIT' : 'MISS'})`);

  if (cachedGreetingAudio) {
    sendBufferToTwilio(cachedGreetingAudio, twilioWs, streamSid);
  } else {
    // Cache miss — generate on-demand (slower, only happens if server just started)
    await sendTextAsAudio(GREETING_TEXT, twilioWs, streamSid);
  }
}

// ── Generate TTS from text and send to Twilio ─────────────────────
async function sendTextAsAudio(
  text: string,
  ws: WebSocket,
  streamSid: string | null
): Promise<void> {
  try {
    const audioBuffer = await synthesizeSpeech(text);
    sendBufferToTwilio(audioBuffer, ws, streamSid);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ TTS error:', message);
  }
}

// ── Send a pre-built audio buffer to Twilio over WebSocket ────────
function sendBufferToTwilio(
  audioBuffer: Buffer,
  ws: WebSocket,
  streamSid: string | null
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('⚠️  WebSocket not open – skipping audio');
    return;
  }
  if (!streamSid) {
    console.warn('⚠️  No streamSid – skipping audio');
    return;
  }

  const CHUNK = 8000; // send in 1-second chunks to avoid large WS frames

  for (let offset = 0; offset < audioBuffer.length; offset += CHUNK) {
    const slice = audioBuffer.subarray(offset, offset + CHUNK);
    ws.send(
      JSON.stringify({ event: 'media', streamSid, media: { payload: slice.toString('base64') } }),
      (err) => { if (err) console.error('❌ ws.send error:', err.message); }
    );
  }

  console.log(`🔊 Audio sent: ${audioBuffer.length} bytes in ${Math.ceil(audioBuffer.length / CHUNK)} chunk(s)`);
}

export default handleMediaStream;
