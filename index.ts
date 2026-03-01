import dotenv from 'dotenv';
dotenv.config({ override: true });

import express, { Application } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

import incomingCallRoute from './routes/incomingCall';
import apiRoute from './routes/api';
import handleMediaStream, { preGenerateGreeting } from './handlers/mediaStream';

const app: Application = express();

// CORS — allow React dev server
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// HTTP Routes
app.use('/', incomingCallRoute);
app.use('/api', apiRoute);

// Shared HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  console.log('📡 New WebSocket connection from:', req.socket.remoteAddress);
  handleMediaStream(ws);
});

const PORT: number = parseInt(process.env.PORT ?? '3000', 10);

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║       🤖 AI Call Bot Server (TS)       ║');
  console.log(`║       Port: ${PORT}                        ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log(`🌐 Public URL  : ${process.env.PUBLIC_URL ?? 'NOT SET – run ngrok first'}`);
  console.log(`📞 Webhook     : ${process.env.PUBLIC_URL ?? 'https://...'}/incoming-call`);
  console.log(`❤️  Health     : http://localhost:${PORT}/api/health`);
  console.log('');

  // Pre-generate greeting audio so first call plays instantly
  preGenerateGreeting();
});

export { app, server };
