/**
 * AI Voice Bot — Core Module
 *
 * Self-contained module that provides everything needed to run an AI voice bot
 * over Twilio phone calls. Drop this folder into any Express + WebSocket project.
 *
 * Usage:
 *   import { handleMediaStream, incomingCallRoute, preGenerateGreeting } from './core';
 *
 *   app.use('/', incomingCallRoute);
 *   wss.on('connection', (ws) => handleMediaStream(ws));
 *   preGenerateGreeting();
 *
 * Required env vars:
 *   - SARVAM_API_KEY      (Sarvam AI STT + TTS)
 *   - GEMINI_API_KEY      (Google Gemini AI)
 *   - PUBLIC_URL           (ngrok or production URL)
 *
 * Optional env vars:
 *   - GEMINI_MODEL         (default: gemini-2.5-flash)
 *   - SARVAM_TTS_SPEAKER   (default: simran)
 */

// ── Main exports (what you need to wire up a server) ───────────────
export { default as handleMediaStream, preGenerateGreeting } from './mediaStreamHandler';
export { default as incomingCallRoute } from './twilioRoute';

// ── Individual services (for advanced usage / testing) ─────────────
export { createSarvamSTTSession } from './stt';
export type { SarvamSTTSession } from './stt';
export { sarvamStreamTTS, sarvamSynthesizeSpeech } from './tts';
export type { TTSHandle } from './tts';
export { getStreamingResponse, resetChat } from './ai';
export { detectTurn, analyzeTurn, TurnResult } from './turnDetector';
export { detectVoice, isVoice } from './vad';
