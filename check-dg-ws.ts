import dotenv from 'dotenv';
dotenv.config();
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

const apiKey = process.env.DEEPGRAM_API_KEY;
console.log(`Testing WS with key: ${apiKey?.slice(0, 8)}...`);

const deepgram = createClient(apiKey as string);

const connection = deepgram.listen.live({
  model: 'nova-2',
  language: 'en-US',
  encoding: 'linear16',
  sample_rate: 16000,
});

connection.on(LiveTranscriptionEvents.Open, () => {
  console.log('✅ Deepgram WebSocket opened successfully!');
  connection.finish();
});

connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
  console.error('❌ Deepgram WebSocket Error:', err);
});

connection.on(LiveTranscriptionEvents.Close, (event: unknown) => {
  console.log('🔌 Deepgram WebSocket Closed:', event);
});
