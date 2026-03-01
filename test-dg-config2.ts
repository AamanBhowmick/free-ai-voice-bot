import dotenv from 'dotenv';
dotenv.config({ override: true });
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const apiKey = process.env.DEEPGRAM_API_KEY ?? '';

const deepgram = createClient(apiKey);

const connection = deepgram.listen.live({
  model: 'nova-2',
  language: 'en-US',
  smart_format: true,
  encoding: 'mulaw',
  sample_rate: 8000,
  channels: 1,
  endpointing: 500,
});

connection.on(LiveTranscriptionEvents.Open, () => {
  console.log('✅ Deepgram WebSocket opened with SAFE config!');
  connection.finish();
});

connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
  console.error('❌ Error with SAFE config:', err);
});
