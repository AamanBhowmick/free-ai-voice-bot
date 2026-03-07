// Quick test: What format does Sarvam TTS actually return?
import dotenv from 'dotenv';
dotenv.config({ override: true });
import axios from 'axios';

async function testTTS() {
  const apiKey = process.env.SARVAM_API_KEY ?? '';
  console.log('Testing Sarvam TTS...');

  const res = await axios({
    method: 'POST',
    url: 'https://api.sarvam.ai/text-to-speech',
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json',
    },
    data: {
      inputs: ['Hello, how are you?'],
      target_language_code: 'en-IN',
      speaker: 'simran',
      model: 'bulbul:v3',
      pace: 1.0,
      sample_rate: 8000,
    },
  });

  const audios = res.data?.audios;
  if (!audios || !audios[0]) {
    console.log('No audio returned');
    return;
  }

  const raw = Buffer.from(audios[0], 'base64');
  console.log(`\nAudio size: ${raw.length} bytes`);
  console.log(`First 50 bytes (hex): ${raw.subarray(0, 50).toString('hex')}`);
  console.log(`First 4 bytes (ascii): "${raw.subarray(0, 4).toString('ascii')}"`);

  // Check if it's a WAV file
  if (raw.subarray(0, 4).toString('ascii') === 'RIFF') {
    console.log('\n✅ Format: WAV file detected!');
    // Parse WAV header
    const channels = raw.readUInt16LE(22);
    const sampleRate = raw.readUInt32LE(24);
    const bitsPerSample = raw.readUInt16LE(34);
    const audioFormat = raw.readUInt16LE(20);
    console.log(`  Audio Format: ${audioFormat} (1=PCM, 7=mulaw, 6=alaw)`);
    console.log(`  Channels: ${channels}`);
    console.log(`  Sample Rate: ${sampleRate}`);
    console.log(`  Bits Per Sample: ${bitsPerSample}`);
    console.log(`  Data offset: 44 bytes`);
    console.log(`  Audio data: ${raw.length - 44} bytes`);
    console.log(`  Duration: ~${((raw.length - 44) / (sampleRate * channels * (bitsPerSample / 8))).toFixed(2)}s`);
  } else {
    console.log('\n⚠️ Not a WAV — raw PCM or other format');
    console.log(`  If PCM16 at 8kHz: ~${(raw.length / (8000 * 2)).toFixed(2)}s`);
    console.log(`  If mulaw at 8kHz: ~${(raw.length / 8000).toFixed(2)}s`);
  }
}

testTTS().catch(e => console.error('Error:', e.message));
