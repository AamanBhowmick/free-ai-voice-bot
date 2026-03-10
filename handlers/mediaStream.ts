import { WebSocket } from 'ws';
import { createSarvamSTTSession } from '../services/sarvamSTT';
import { getStreamingResponse } from '../services/gemini';
import { sarvamSynthesizeSpeech } from '../services/sarvamTTS';

interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  start?: { streamSid: string; accountSid: string; callSid: string };
  media?: { track: string; chunk: string; timestamp: string; payload: string };
  stop?: { accountSid: string; callSid: string };
}

const GREETING_TEXT = "Hey! I'm Simran, your personal trainer. Aap kaise hain? How can I help you today?";
const GREETING_LANG = 'en-IN';

// ── Pre-cache greeting at server start ──
let cachedGreetingAudio: Buffer | null = null;

export async function preGenerateGreeting(): Promise<void> {
  try {
    console.log('⏳ Pre-generating greeting audio via Sarvam TTS...');
    cachedGreetingAudio = await sarvamSynthesizeSpeech(GREETING_TEXT, GREETING_LANG);
    console.log(`✅ Greeting pre-cached (${cachedGreetingAudio.length} bytes, ~${(cachedGreetingAudio.length / 8000).toFixed(1)}s)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to pre-cache greeting:', msg);
  }
}

/**
 * handleMediaStream
 * Orchestrates the full AI pipeline using ONLY Sarvam AI for both STT and TTS:
 *   Twilio audio → Sarvam STT (REST, chunked) → Gemini AI → Sarvam TTS → Twilio audio
 *
 * Auto-detects Hindi/English and responds in the same language.
 */
function handleMediaStream(twilioWs: WebSocket): void {
  console.log('\n🔗 New call connected – AI pipeline starting');

  let streamSid: string | null = null;
  let isProcessing = false;
  let audioQueue: Promise<void> = Promise.resolve();

  // ── Sarvam STT session (chunked REST with VAD) ──────────
  const sttSession = createSarvamSTTSession(async (transcript: string, detectedLang: string) => {
    if (!transcript.trim() || isProcessing) return;

    console.log(`\n👤 Caller said [${detectedLang}]: "${transcript}"`);
    isProcessing = true;

    audioQueue = audioQueue.then(async () => {
      try {
        let buffer = '';

        for await (const chunk of getStreamingResponse(transcript, detectedLang)) {
          buffer += chunk;

          // Stream TTS sentence-by-sentence (Hindi + English punctuation)
          if (/[.!?।]/.test(buffer)) {
            const sentence = buffer.trim();
            buffer = '';
            if (sentence) {
              console.log(`🤖 AI [${detectedLang}]: "${sentence}"`);
              await sendTextAsAudio(sentence, twilioWs, streamSid, detectedLang);
            }
          }
        }

        // Flush trailing text
        if (buffer.trim()) {
          console.log(`🤖 AI (flush) [${detectedLang}]: "${buffer.trim()}"`);
          await sendTextAsAudio(buffer.trim(), twilioWs, streamSid, detectedLang);
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
          greetCaller(twilioWs, streamSid);
          break;

        case 'media':
          if (msg.media?.track === 'inbound') {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            sttSession.send(audioBuffer);
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
    sttSession.close();
  });

  twilioWs.on('error', (err: Error) => {
    console.error('❌ Twilio WS error:', err.message);
  });
}

// ── Greet caller ──────────────────────────────────────────────────
async function greetCaller(twilioWs: WebSocket, streamSid: string | null): Promise<void> {
  console.log(`👋 Sending greeting (cache: ${cachedGreetingAudio ? 'HIT' : 'MISS'})`);

  if (cachedGreetingAudio) {
    sendBufferToTwilio(cachedGreetingAudio, twilioWs, streamSid);
  } else {
    await sendTextAsAudio(GREETING_TEXT, twilioWs, streamSid, GREETING_LANG);
  }
}

// ── TTS → audio → Twilio ─────────────────────────────────────────
async function sendTextAsAudio(
  text: string,
  ws: WebSocket,
  streamSid: string | null,
  language: string
): Promise<void> {
  try {
    const audioBuffer = await sarvamSynthesizeSpeech(text, language);
    sendBufferToTwilio(audioBuffer, ws, streamSid);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ TTS error:', message);
  }
}

// ── Send raw µ-law buffer to Twilio in chunks ────────────────────
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

  const CHUNK = 8000; // 1-second chunks

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
