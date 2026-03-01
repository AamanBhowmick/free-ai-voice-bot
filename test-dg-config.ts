import dotenv from 'dotenv';
dotenv.config({ override: true });
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const apiKey = process.env.DEEPGRAM_API_KEY ?? '';
console.log(`Testing full config with key: ${apiKey.slice(0, 8)}...`);

const deepgram = createClient(apiKey);

const connection = deepgram.listen.live({
  model: 'nova-2',
  language: 'en-US',
  smart_format: true,
  interim_results: false,
  utterance_end_ms: 1000,
  vad_events: true,
  encoding: 'mulaw',
  sample_rate: 8000,
  channels: 1,
});

connection.on(LiveTranscriptionEvents.Open, () => {
  console.log('✅ Deepgram WebSocket opened with full config!');
  connection.finish();
});

connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
  console.error('❌ Error with full config:', err);
});

connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
  console.log('🔌 Closed:', event);
});
