require('dotenv').config();
const https = require('https');

const apiKey = process.env.DEEPGRAM_API_KEY;

if (!apiKey) {
  console.error("❌ No API key found in .env");
  process.exit(1);
}

console.log(`Testing Deepgram API Key: ${apiKey.slice(0, 8)}...`);

const options = {
  hostname: 'api.deepgram.com',
  path: '/v1/projects',
  method: 'GET',
  headers: {
    'Authorization': `Token ${apiKey}`,
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`\nHTTP Status: ${res.statusCode}`);
    
    if (res.statusCode === 200) {
      console.log('✅ API Key is VALID.');
      try {
        const json = JSON.parse(data);
        console.log('Projects:', json.projects.map(p => p.name));
      } catch(e) {}
    } else if (res.statusCode === 401 || res.statusCode === 403) {
      console.log('❌ API Key is INVALID or EXPIRED.');
      console.log(data);
    } else {
      console.log('⚠️ Unknown status:');
      console.log(data);
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ Network Error: ${e.message}`);
});

req.end();
