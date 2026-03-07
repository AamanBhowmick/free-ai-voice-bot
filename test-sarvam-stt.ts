// Test Sarvam STT WebSocket auth with different endpoint paths
import dotenv from 'dotenv';
dotenv.config({ override: true });
import WebSocket from 'ws';

const apiKey = process.env.SARVAM_API_KEY ?? '';
console.log(`Testing STT WS with key: ${apiKey.slice(0, 12)}...`);

const endpoints = [
  'wss://api.sarvam.ai/speech-to-text-translate/ws',
  'wss://api.sarvam.ai/speech-to-text/transcribe/ws',
];

for (const base of endpoints) {
  const url = new URL(base);
  url.searchParams.set('model', 'saaras:v3');
  url.searchParams.set('mode', 'transcribe');
  url.searchParams.set('language_code', 'en-IN');

  console.log(`\n--- Testing: ${base} ---`);

  const ws = new WebSocket(url.toString(), {
    headers: { 'api-subscription-key': apiKey },
  });

  ws.on('open', () => {
    console.log(`  ✅ OPENED: ${base}`);
    ws.close();
  });
  ws.on('error', (err: Error) => {
    console.log(`  ❌ ERROR: ${err.message}`);
  });
  ws.on('close', (code: number) => {
    console.log(`  🔌 CLOSED: code ${code}`);
  });
}

// Keep alive for 5 seconds
setTimeout(() => process.exit(0), 5000);
