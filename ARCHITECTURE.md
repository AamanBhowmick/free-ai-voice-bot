# 🤖 AI Voice Bot — Architecture & Implementation

## Overview

A real-time AI voice assistant powered by **Sarvam AI** (STT + TTS) and **Google Gemini**, delivered over phone calls via **Twilio Media Streams**. The bot acts as "Simran," a multilingual personal fitness coach supporting **Hindi, English, Marathi, Bengali, and Gujarati**.

## Pipeline

```
Phone Call → Twilio → WebSocket → Sarvam STT → Gemini AI → Sarvam TTS → WebSocket → Twilio → Phone Call
```

```
┌──────────┐     ┌──────────┐     ┌───────────┐     ┌──────────┐     ┌───────────┐
│  Caller  │◄──► │  Twilio  │◄──► │  Node.js  │────►│  Sarvam  │────►│  Gemini   │
│ (Phone)  │     │ Media WS │     │  Server   │◄────│ STT/TTS  │◄────│   2.5     │
└──────────┘     └──────────┘     └───────────┘     └──────────┘     └───────────┘
```

## Tech Stack

| Component | Service | Model/Version |
|-----------|---------|---------------|
| **STT** | Sarvam AI REST | `saaras:v3` |
| **TTS** | Sarvam AI WebSocket Streaming | `bulbul:v3` (Simran voice) |
| **AI** | Google Gemini | `gemini-2.5-flash` |
| **Telephony** | Twilio Media Streams | WebSocket bi-directional |
| **Runtime** | Node.js + TypeScript | `ts-node` + `nodemon` |
| **Tunnel** | ngrok | HTTP → HTTPS |

## File Structure

```
new-call-bot/
├── index.ts                    # Express + WebSocket server setup
├── routes/
│   └── incomingCall.ts         # Twilio webhook → TwiML response
├── handlers/
│   └── mediaStream.ts          # Pipeline orchestration + barge-in + turn detection
├── services/
│   ├── sarvamSTT.ts            # Sarvam REST STT with Silero VAD pre-filter
│   ├── sarvamTTS.ts            # Sarvam WebSocket streaming TTS
│   ├── sileroVAD.ts            # Neural net Voice Activity Detection
│   ├── gemini.ts               # Gemini chat session (multi-turn)
│   └── turnDetector.ts         # Semantic turn detection (heuristic + AI)
├── client/                     # React frontend (Vite)
├── .env                        # API keys and config
└── package.json
```

## Detailed Component Breakdown

### 1. Sarvam STT (`services/sarvamSTT.ts`)

**Approach:** Chunked REST API (not WebSocket streaming)

The STT uses **voice activity detection (VAD)** to accumulate audio and detect speech boundaries:

- **Audio Input:** µ-law 8kHz from Twilio → decoded to PCM Int16LE
- **Fast Buffering:** RMS amplitude > 300 to start accumulating audio
- **Noise Rejection (Silero VAD):** Before sending to the STT API, the accumulated buffer is analyzed by the **Silero VAD ONNX model**. If it's just background noise (TV, typing, fan), it's immediately dropped.
- **Silence Detection:** 4 consecutive silent frames (~0.5s) triggers flush — VAD + turn detector decides what to do
- **API Call:** Accumulated PCM → WAV file → Sarvam REST STT (`saaras:v3`)
- **Language Detection:** `language_code: 'unknown'` enables auto detection of Hindi, English, Marathi, Bengali, Gujarati, and other Indian languages

**Barge-In Support:**
- `setBotSpeaking(true)` — monitors for loud speech (RMS > 250) during TTS playback
- If 3 consecutive loud frames detected (~0.4s), fires `onInterrupt` callback
- Higher threshold prevents false triggers from audio bleed

**Key Constants:**
```
SILENCE_THRESHOLD    = 150   (RMS for speech detection)
SILENCE_FRAMES       = 8     (~1s pause to end speech)
BARGE_IN_THRESHOLD   = 250   (louder for interrupt detection)
BARGE_IN_FRAMES      = 3     (~0.4s to confirm interrupt)
```

### 2. Sarvam TTS (`services/sarvamTTS.ts`)

**Approach:** WebSocket streaming for low-latency progressive audio

**Protocol:**
1. Connect to `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3`
2. Send `config` message (speaker, language, codec=mulaw)
3. Send `text` message with the sentence
4. Send `flush` to trigger generation
5. Receive audio chunks progressively → forward to Twilio immediately

**Audio Format:**
- Sarvam outputs mulaw at **24kHz** (bulbul:v3 default)
- Downsampled to **8kHz** by taking every 3rd sample (24000/8000 = 3)
- Result is Twilio-native µ-law — zero additional conversion needed

**Barge-In Support:**
- `sarvamStreamTTS()` returns a `TTSHandle` with `cancel()` method
- Calling `cancel()` closes the WebSocket and stops all audio callbacks

### 3. Gemini AI (`services/gemini.ts`)

**Features:**
- **Multi-turn chat:** Uses `ChatSession` so Simran remembers conversation context
- **Language matching:** Dynamic `buildLangHint()` maps detected language codes to Gemini hints
- **5 languages supported:** Hindi (Devanagari), English (Latin), Marathi (Devanagari), Bengali (Bengali script), Gujarati (Gujarati script)
- **Localized errors:** `getErrorMessage()` returns error messages in the user's detected language
- **Chat reset:** `resetChat()` called on each new call to prevent context bleed

**Persona — Simran (Fitness Coach):**
- Certified, knowledgeable, professional
- Gives specific advice (exercises, rep ranges, nutrition with quantities)
- Varies vocabulary — never repeats phrases
- Responds in 2-3 sentences (phone-call appropriate)

### 4. Handler (`handlers/mediaStream.ts`)

**Orchestrates the full pipeline with barge-in:**

```
Twilio Media Event
    ├── 'start'  → Send pre-cached greeting
    ├── 'media'  → Forward audio to STT
    └── 'stop'   → Clean up
```

**Barge-In Flow:**
```
1. Bot is speaking (setBotSpeaking=true)
2. User starts talking loudly
3. STT detects barge-in (3 frames of RMS > 250)
4. onInterrupt fires:
   ├── Cancel TTS WebSocket (handle.cancel())
   ├── Clear Twilio audio queue ({ event: 'clear', streamSid })
   ├── Set interrupted=true (breaks Gemini loop)
   └── setBotSpeaking(false) → resume normal listening
5. User's new speech is accumulated and processed normally
```

**Greeting:**
- Pre-generated at server start via `preGenerateGreeting()`
- Cached as a mulaw buffer for instant playback
- STT is hard-muted during greeting to prevent echo

## Environment Variables

```env
SARVAM_API_KEY=sk_...           # Sarvam AI subscription key
SARVAM_TTS_SPEAKER=simran       # TTS voice (lowercase)
SARVAM_TTS_LANGUAGE=en-IN       # Default TTS language
GEMINI_API_KEY=AIza...          # Google Gemini API key
GEMINI_MODEL=gemini-2.5-flash   # Gemini model
TWILIO_ACCOUNT_SID=AC...        # Twilio credentials
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...       # Twilio phone number
PUBLIC_URL=https://...ngrok...  # ngrok public URL
PORT=3000
```

## Running Locally

```bash
# 1. Start ngrok tunnel
ngrok http 3000

# 2. Update .env with the ngrok URL
PUBLIC_URL=https://your-ngrok-url.ngrok-free.dev

# 3. Start backend
npm run dev

# 4. Start frontend (optional)
cd client && npm run dev

# 5. Update Twilio webhook URL
# Set voice webhook to: https://your-ngrok-url.ngrok-free.dev/incoming-call
```

## Audio Format Reference

| Stage | Format | Rate | Notes |
|-------|--------|------|-------|
| Twilio inbound | µ-law | 8kHz | Raw telephony audio |
| STT input | PCM Int16LE WAV | 8kHz | Decoded from µ-law |
| TTS output (Sarvam WS) | µ-law | 24kHz | Native mulaw codec |
| TTS after downsample | µ-law | 8kHz | Every 3rd sample |
| Twilio outbound | µ-law | 8kHz | Base64 in JSON |
