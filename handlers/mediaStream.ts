import { WebSocket } from 'ws';
import { createSarvamSTTSession } from '../services/sarvamSTT';
import { getStreamingResponse, resetChat } from '../services/gemini';
import { sarvamSynthesizeSpeech, sarvamStreamTTS } from '../services/sarvamTTS';

interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  start?: { streamSid: string; accountSid: string; callSid: string };
  media?: { track: string; chunk: string; timestamp: string; payload: string };
  stop?: { accountSid: string; callSid: string };
}

const GREETING_TEXT = "Hi! I'm Simran, your personal fitness coach. How can I help you today?";
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
 * Twilio audio → Sarvam STT → Gemini AI → Sarvam Streaming TTS → Twilio
 *
 * TTS now streams: audio chunks are forwarded to Twilio AS THEY ARRIVE
 * from Sarvam's WebSocket, instead of waiting for the full audio.
 */
function handleMediaStream(twilioWs: WebSocket): void {
  console.log('\n🔗 New call connected – AI pipeline starting');
  resetChat();

  let streamSid: string | null = null;
  let isProcessing = false;
  let audioQueue: Promise<void> = Promise.resolve();
  let greetingSent = false;

  // ── Sarvam STT session ──────────────────────────────────
  const sttSession = createSarvamSTTSession(async (transcript: string, detectedLang: string) => {
    if (!transcript.trim() || isProcessing) return;

    console.log(`\n👤 Caller said [${detectedLang}]: "${transcript}"`);
    isProcessing = true;

    audioQueue = audioQueue.then(async () => {
      try {
        let buffer = '';

        for await (const chunk of getStreamingResponse(transcript, detectedLang)) {
          buffer += chunk;

          // Stream TTS sentence-by-sentence
          if (/[.!?।]/.test(buffer)) {
            const sentence = buffer.trim();
            buffer = '';
            if (sentence) {
              console.log(`🤖 AI [${detectedLang}]: "${sentence}"`);
              await streamTTSToTwilio(sentence, detectedLang, twilioWs, streamSid, sttSession);
            }
          }
        }

        // Flush trailing text
        if (buffer.trim()) {
          console.log(`🤖 AI (flush) [${detectedLang}]: "${buffer.trim()}"`);
          await streamTTSToTwilio(buffer.trim(), detectedLang, twilioWs, streamSid, sttSession);
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
          if (!greetingSent) {
            greetingSent = true;
            greetCaller(twilioWs, streamSid, sttSession);
          }
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

// ── Stream TTS audio to Twilio progressively ──────────────────────
function streamTTSToTwilio(
  text: string,
  language: string,
  twilioWs: WebSocket,
  streamSid: string | null,
  sttSession: { mute: (ms: number) => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let totalBytesSent = 0;

    // Mute STT immediately — we'll extend the mute time as audio comes in
    sttSession.mute(3000);

    sarvamStreamTTS({
      text,
      language,
      onAudioChunk: (chunk) => {
        // Forward each audio chunk directly to Twilio as it arrives!
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: chunk.toString('base64') },
            }),
            (err) => { if (err) console.error('❌ ws.send error:', err.message); }
          );
          totalBytesSent += chunk.length;

          // Extend mute for the duration of audio being played
          sttSession.mute(Math.ceil(totalBytesSent / 8000) * 1000 + 1000);
        }
      },
      onDone: () => {
        console.log(`🔊 Streamed ${totalBytesSent}B to Twilio (~${(totalBytesSent / 8000).toFixed(1)}s)`);
        resolve();
      },
      onError: (err) => {
        console.error('❌ TTS stream error:', err.message);
        // Fallback: resolve anyway so pipeline continues
        resolve();
      },
    });
  });
}

// ── Greet caller ──────────────────────────────────────────────────
async function greetCaller(
  twilioWs: WebSocket,
  streamSid: string | null,
  sttSession: { mute: (ms: number) => void }
): Promise<void> {
  console.log(`👋 Sending greeting (cache: ${cachedGreetingAudio ? 'HIT' : 'MISS'})`);

  let audioToSend: Buffer;

  if (cachedGreetingAudio) {
    audioToSend = cachedGreetingAudio;
  } else {
    audioToSend = await sarvamSynthesizeSpeech(GREETING_TEXT, GREETING_LANG);
  }

  const durationMs = Math.ceil(audioToSend.length / 8000) * 1000 + 1500;
  sttSession.mute(durationMs);
  sendBufferToTwilio(audioToSend, twilioWs, streamSid);
}

// ── Send pre-built buffer to Twilio (for cached greeting) ────────
function sendBufferToTwilio(
  audioBuffer: Buffer,
  ws: WebSocket,
  streamSid: string | null
): void {
  if (ws.readyState !== WebSocket.OPEN || !streamSid) return;

  const CHUNK = 8000;
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
