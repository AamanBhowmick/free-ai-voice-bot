import { Router, Request, Response } from 'express';

const router = Router();

/**
 * POST /incoming-call
 * Twilio calls this when an outbound call is answered.
 * Responds with TwiML to open a bi-directional Media Stream WebSocket.
 */
router.post('/incoming-call', (req: Request, res: Response): void => {
  const publicUrl: string = process.env.PUBLIC_URL ?? '';

  // Convert https:// → wss:// for WebSocket URL
  const wsUrl: string = publicUrl.replace(/^https?:\/\//, (match) =>
    match.startsWith('https') ? 'wss://' : 'ws://'
  );

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/media-stream" />
  </Connect>
</Response>`;

  console.log(`📞 Incoming call webhook → streaming to ${wsUrl}/media-stream`);
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

export default router;
