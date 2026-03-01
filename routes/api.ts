import { Router, Request, Response } from 'express';
import twilio, { Twilio } from 'twilio';

const router = Router();

interface RequestCallBody {
  phoneNumber: string;
}

interface HealthResponse {
  status: string;
  timestamp: string;
  services: Record<string, boolean>;
}

/**
 * GET /api/health
 */
router.get('/health', (_req: Request, res: Response): void => {
  const health: HealthResponse = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      twilio: !!process.env.TWILIO_ACCOUNT_SID,
      deepgram: !!process.env.DEEPGRAM_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    },
  };
  res.json(health);
});

/**
 * POST /api/request-call
 * Body: { phoneNumber: string }
 * Places an outbound Twilio call to the user's phone.
 */
router.post('/request-call', async (req: Request<{}, {}, RequestCallBody>, res: Response): Promise<void> => {
  let { phoneNumber } = req.body;

  if (!phoneNumber) {
    res.status(400).json({ error: 'phoneNumber is required' });
    return;
  }

  // Normalize: ensure E.164 format
  if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+' + phoneNumber;
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    res.status(503).json({
      error: 'Twilio credentials not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env',
    });
    return;
  }

  if (!process.env.PUBLIC_URL || process.env.PUBLIC_URL.includes('your-ngrok')) {
    res.status(503).json({
      error: 'PUBLIC_URL not configured. Start ngrok and update .env with the tunnel URL.',
    });
    return;
  }

  try {
    const client: Twilio = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const call = await client.calls.create({
      url: `${process.env.PUBLIC_URL}/incoming-call`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER ?? '',
      statusCallback: `${process.env.PUBLIC_URL}/api/call-status`,
      statusCallbackMethod: 'POST',
    });

    console.log(`📱 Outbound call initiated to ${phoneNumber} | SID: ${call.sid}`);

    res.json({
      success: true,
      callSid: call.sid,
      message: `Calling ${phoneNumber}...`,
      status: call.status,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error initiating call:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/call-status
 * Twilio status callback — logs call lifecycle events
 */
router.post('/call-status', (req: Request, res: Response): void => {
  const { CallSid, CallStatus, To, Duration } = req.body as {
    CallSid: string;
    CallStatus: string;
    To: string;
    Duration?: string;
  };
  console.log(`📊 Call status | SID: ${CallSid} | Status: ${CallStatus} | To: ${To} | Duration: ${Duration ?? 0}s`);
  res.sendStatus(200);
});

export default router;
