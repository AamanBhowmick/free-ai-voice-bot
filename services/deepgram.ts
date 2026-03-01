import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import type { LiveClient } from '@deepgram/sdk';

type TranscriptCallback = (transcript: string) => void;

/**
 * createDeepgramSession
 * Opens a Deepgram live transcription WebSocket configured for
 * Twilio's µ-law 8kHz phone audio format.
 *
 * @param onTranscript - called with each final, confident transcript
 * @returns LiveClient with .send() and .finish() methods
 */
export function createDeepgramSession(onTranscript: TranscriptCallback): LiveClient {
  const apiKey = process.env.DEEPGRAM_API_KEY ?? '';

  // ── Guard: catch missing/unfilled key early ──────────────────
  if (!apiKey || apiKey === 'your_deepgram_api_key') {
    console.error('❌ DEEPGRAM_API_KEY is missing or not set in .env!');
    console.error('   Get your key at: https://console.deepgram.com → API Keys');
  } else {
    console.log(`🔑 Deepgram key loaded: ${apiKey.slice(0, 8)}...`);
  }

  const deepgram = createClient(apiKey);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en-US',
    smart_format: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    endpointing: 500, // Sends is_final:true after 500ms of silence
  });

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('🎙️  Deepgram STT session opened successfully');
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0] as
      | { transcript?: string; confidence?: number }
      | undefined;

    const transcript = alt?.transcript?.trim() ?? '';
    const isFinal: boolean = data?.is_final ?? false;
    const confidence: number = alt?.confidence ?? 0;

    if (transcript && isFinal && confidence > 0.4) {
      onTranscript(transcript);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const msg = e['message'] ?? e['reason'] ?? e['type'] ?? 'unknown';
      console.error(`❌ Deepgram STT error [${msg}]`);
      console.error('   → Most likely cause: Invalid DEEPGRAM_API_KEY in .env');
      console.error('   → Check: https://console.deepgram.com → API Keys');
    } else {
      console.error('❌ Deepgram STT error:', err);
    }
  });

  connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
    const e = event as Record<string, unknown> | undefined;
    const code = e?.['code'];
    const reason = e?.['reason'];

    // Known Deepgram auth failure codes
    if (code === 1008 || code === 4010 || code === 4011) {
      console.error(`❌ Deepgram closed with code ${code}: INVALID API KEY`);
      console.error('   → Double-check DEEPGRAM_API_KEY in your .env file');
    } else {
      console.log(`🎙️  Deepgram session closed (code: ${code ?? 'n/a'}, reason: ${reason ?? 'n/a'})`);
    }
  });

  return connection;
}
