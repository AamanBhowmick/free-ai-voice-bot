import { WebSocket } from 'ws';
import { createSarvamSTTSession } from '../services/sarvamSTT';
import { getStreamingResponse, resetChat } from '../services/gemini';
import { sarvamSynthesizeSpeech, sarvamStreamTTS, TTSHandle } from '../services/sarvamTTS';

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
 * Full AI pipeline with barge-in support:
 *   Twilio → Sarvam STT → Gemini → Sarvam TTS (streaming) → Twilio
 *
 * If the user speaks while the bot is talking:
 *   1. TTS WebSocket is cancelled mid-stream
 *   2. Twilio audio queue is cleared
 *   3. New user speech is processed immediately
 */
function handleMediaStream(twilioWs: WebSocket): void {
  console.log('\n🔗 New call connected – AI pipeline starting');
  resetChat();

  let streamSid: string | null = null;
  let greetingSent = false;

  // Barge-in state
  let currentTTSHandle: TTSHandle | null = null;
  let interrupted = false;
  let processingPromise: Promise<void> | null = null;
  let isProcessing = false;

  // ── Interrupt handler: cancel everything when user barges in ──
  function handleInterrupt() {
    console.log('🛑 INTERRUPT: Cancelling bot speech...');
    interrupted = true;
    isProcessing = false;

    // 1. Cancel current TTS stream
    if (currentTTSHandle) {
      currentTTSHandle.cancel();
      currentTTSHandle = null;
    }

    // 2. Clear Twilio's audio queue so user hears silence immediately
    if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      console.log('🧹 Twilio audio queue cleared');
    }

    // 3. Tell STT to start listening for new speech
    sttSession.setBotSpeaking(false);
  }

  // ── Sarvam STT session with barge-in ────────────────────
  const sttSession = createSarvamSTTSession(
    // onTranscript
    async (transcript: string, detectedLang: string) => {
      if (!transcript.trim()) return;

      // If we're still processing and get a new transcript, it's a barge-in follow-up
      if (isProcessing) {
        handleInterrupt();
        // Small delay to let cancellation complete
        await new Promise(r => setTimeout(r, 100));
      }

      console.log(`\n👤 Caller said [${detectedLang}]: "${transcript}"`);
      isProcessing = true;
      interrupted = false;

      try {
        let buffer = '';

        for await (const chunk of getStreamingResponse(transcript, detectedLang)) {
          // Check if we were interrupted mid-generation
          if (interrupted) {
            console.log('⏹️  AI generation cancelled (barge-in)');
            break;
          }

          buffer += chunk;

          // Stream TTS sentence-by-sentence
          if (/[.!?।]/.test(buffer)) {
            const sentence = buffer.trim();
            buffer = '';
            if (sentence && !interrupted) {
              console.log(`🤖 AI [${detectedLang}]: "${sentence}"`);
              sttSession.setBotSpeaking(true);
              await streamTTSToTwilio(sentence, detectedLang, twilioWs, streamSid);
              if (!interrupted) {
                sttSession.setBotSpeaking(false);
              }
            }
          }
        }

        // Flush trailing text
        if (buffer.trim() && !interrupted) {
          console.log(`🤖 AI (flush) [${detectedLang}]: "${buffer.trim()}"`);
          sttSession.setBotSpeaking(true);
          await streamTTSToTwilio(buffer.trim(), detectedLang, twilioWs, streamSid);
          if (!interrupted) {
            sttSession.setBotSpeaking(false);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!interrupted) console.error('❌ Pipeline error:', msg);
      } finally {
        if (!interrupted) {
          isProcessing = false;
          sttSession.setBotSpeaking(false);
        }
      }
    },
    // onInterrupt (barge-in callback)
    handleInterrupt
  );

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

  // ── Stream TTS to Twilio (with barge-in cancel support) ─────────
  function streamTTSToTwilio(
    text: string,
    language: string,
    ws: WebSocket,
    sid: string | null,
  ): Promise<void> {
    return new Promise((resolve) => {
      let totalBytesSent = 0;

      const handle = sarvamStreamTTS({
        text,
        language,
        onAudioChunk: (chunk) => {
          if (interrupted) return;
          if (ws.readyState === WebSocket.OPEN && sid) {
            ws.send(
              JSON.stringify({
                event: 'media',
                streamSid: sid,
                media: { payload: chunk.toString('base64') },
              }),
              (err) => { if (err) console.error('❌ ws.send error:', err.message); }
            );
            totalBytesSent += chunk.length;
          }
        },
        onDone: () => {
          if (!interrupted) {
            console.log(`🔊 Streamed ${totalBytesSent}B (~${(totalBytesSent / 8000).toFixed(1)}s)`);
          }
          resolve();
        },
        onError: (err) => {
          if (!interrupted) console.error('❌ TTS error:', err.message);
          resolve();
        },
      });

      // Store handle so barge-in can cancel it
      currentTTSHandle = handle;
    });
  }
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

// ── Send pre-built buffer to Twilio ──────────────────────────────
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
