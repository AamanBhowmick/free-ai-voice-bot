import { WebSocket } from 'ws';
import { createSarvamSTTSession } from './stt';
import { getStreamingResponse, resetChat } from './ai';
import { sarvamSynthesizeSpeech, sarvamStreamTTS, TTSHandle } from './tts';
import { detectTurn, TurnResult } from './turnDetector';

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

export default function handleMediaStream(twilioWs: WebSocket): void {
  console.log('\n🔗 New call connected – AI pipeline starting');
  resetChat();

  let streamSid: string | null = null;
  let greetingSent = false;

  // ── Generation counter: prevents overlapping responses ──
  let currentGeneration = 0;
  let currentTTSHandle: TTSHandle | null = null;
  let isProcessing = false;

  // ── Turn detection buffer ───────────────────────────────
  let turnBuffer = '';
  let turnLang = 'en-IN';
  let turnTimeout: ReturnType<typeof setTimeout> | null = null;
  const TURN_HARD_TIMEOUT_MS = 2000;

  function clearTurnTimeout() {
    if (turnTimeout) {
      clearTimeout(turnTimeout);
      turnTimeout = null;
    }
  }

  // ── Cancel everything from the current generation ───────
  function cancelCurrentGeneration() {
    currentGeneration++;
    isProcessing = false;

    // Cancel TTS
    if (currentTTSHandle) {
      currentTTSHandle.cancel();
      currentTTSHandle = null;
    }

    // Clear Twilio audio queue
    if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
      console.log('🧹 Twilio audio queue cleared');
    }

    // Clear turn buffer
    turnBuffer = '';
    clearTurnTimeout();

    sttSession.setBotSpeaking(false);
  }

  // ── Process a complete turn ─────────────────────────────
  async function processTurn(text: string, lang: string) {
    if (!text.trim()) return;

    // Cancel any in-flight work from a previous turn
    if (isProcessing) {
      console.log('🛑 Cancelling previous generation for new turn');
      cancelCurrentGeneration();
    }

    const myGeneration = ++currentGeneration;
    isProcessing = true;

    console.log(`\n🎯 Turn #${myGeneration} [${lang}]: "${text}"`);

    try {
      let buffer = '';

      for await (const chunk of getStreamingResponse(text, lang)) {
        // Abort if this generation was superseded
        if (myGeneration !== currentGeneration) {
          console.log(`⏹️  Gen #${myGeneration} cancelled (superseded by #${currentGeneration})`);
          return;
        }

        buffer += chunk;

        if (/[.!?।]/.test(buffer)) {
          const sentence = buffer.trim();
          buffer = '';
          if (sentence && myGeneration === currentGeneration) {
            console.log(`🤖 AI [${lang}]: "${sentence}"`);
            sttSession.setBotSpeaking(true);
            await streamTTSToTwilio(sentence, lang, myGeneration);
            if (myGeneration !== currentGeneration) return;
            sttSession.setBotSpeaking(false);
          }
        }
      }

      // Flush trailing text
      if (buffer.trim() && myGeneration === currentGeneration) {
        console.log(`🤖 AI (flush) [${lang}]: "${buffer.trim()}"`);
        sttSession.setBotSpeaking(true);
        await streamTTSToTwilio(buffer.trim(), lang, myGeneration);
        if (myGeneration !== currentGeneration) return;
        sttSession.setBotSpeaking(false);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (myGeneration === currentGeneration) {
        console.error('❌ Pipeline error:', msg);
      }
    } finally {
      if (myGeneration === currentGeneration) {
        isProcessing = false;
        sttSession.setBotSpeaking(false);
      }
    }
  }

  // ── STT session with turn detection + barge-in ──────────
  const sttSession = createSarvamSTTSession(
    // onTranscript
    async (transcript: string, detectedLang: string) => {
      if (!transcript.trim()) return;

      // Accumulate into turn buffer
      turnBuffer = turnBuffer ? `${turnBuffer} ${transcript}` : transcript;
      turnLang = detectedLang;

      console.log(`📝 STT chunk [${detectedLang}]: "${transcript}"`);
      clearTurnTimeout();

      // Run turn detector
      const result = await detectTurn(turnBuffer);

      if (result === TurnResult.COMPLETE) {
        const fullText = turnBuffer;
        const lang = turnLang;
        turnBuffer = '';
        clearTurnTimeout();
        processTurn(fullText, lang);
      } else {
        console.log(`⏳ Waiting for more speech... (buffer: "${turnBuffer.slice(0, 50)}")`);
        turnTimeout = setTimeout(() => {
          if (turnBuffer.trim()) {
            console.log('⏰ Turn timeout — forcing completion');
            const fullText = turnBuffer;
            const lang = turnLang;
            turnBuffer = '';
            processTurn(fullText, lang);
          }
        }, TURN_HARD_TIMEOUT_MS);
      }
    },
    // onInterrupt (barge-in)
    () => {
      console.log('🗣️  BARGE-IN: User is interrupting!');
      cancelCurrentGeneration();
    }
  );

  // ── Twilio messages ─────────────────────────────────────
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
            sttSession.send(Buffer.from(msg.media.payload, 'base64'));
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
    clearTurnTimeout();
    sttSession.close();
  });

  twilioWs.on('error', (err: Error) => {
    console.error('❌ Twilio WS error:', err.message);
  });

  // ── Stream TTS to Twilio (generation-aware) ─────────────
  function streamTTSToTwilio(
    text: string,
    language: string,
    generation: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Already cancelled before we even start
      if (generation !== currentGeneration) { resolve(); return; }

      let totalBytesSent = 0;

      const handle = sarvamStreamTTS({
        text,
        language,
        onAudioChunk: (chunk) => {
          // Check generation on EVERY chunk
          if (generation !== currentGeneration) return;
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
          }
        },
        onDone: () => {
          if (generation === currentGeneration) {
            console.log(`🔊 Streamed ${totalBytesSent}B (~${(totalBytesSent / 8000).toFixed(1)}s)`);
          }
          resolve();
        },
        onError: (err) => {
          if (generation === currentGeneration) console.error('❌ TTS error:', err.message);
          resolve();
        },
      });

      // Store handle so barge-in can cancel it
      if (generation === currentGeneration) {
        currentTTSHandle = handle;
      } else {
        handle.cancel();
      }
    });
  }
}

// ── Greet caller ──────────────────────────────────────────
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

  if (twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;
  const CHUNK = 8000;
  for (let offset = 0; offset < audioToSend.length; offset += CHUNK) {
    const slice = audioToSend.subarray(offset, offset + CHUNK);
    twilioWs.send(
      JSON.stringify({ event: 'media', streamSid, media: { payload: slice.toString('base64') } }),
      (err) => { if (err) console.error('❌ ws.send error:', err.message); }
    );
  }
  console.log(`🔊 Greeting sent: ${audioToSend.length} bytes`);
}
