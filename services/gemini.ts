import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

let _model: GenerativeModel | null = null;

function getModel(): GenerativeModel {
  if (!_model) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    _model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      systemInstruction: [
        'You are Alex, an energetic and motivating personal gym trainer calling your client on the phone.',
        'Your personality: high-energy, encouraging, no-nonsense, uses gym/fitness lingo naturally.',
        'Rules:',
        '- Keep every response to 1-2 short punchy sentences maximum.',
        '- Speak like a real trainer on a call — casual, direct, motivating.',
        '- Do NOT use markdown, bullet points, asterisks, or any text formatting.',
        '- Use phrases like "Let\'s crush it!", "No excuses!", "You\'ve got this!", "Come on, push harder!" naturally.',
        '- Give fitness advice, workout tips, nutrition guidance, or motivation based on what the client says.',
        '- If the client mentions skipping the gym or making excuses, playfully call them out and motivate them.',
        '- Address the client as "champ", "buddy", or by their name if they share it.',
      ].join('\n'),
    });
  }
  return _model;
}

/**
 * getStreamingResponse
 * Async generator yielding text chunks from Gemini as they arrive.
 * Starts TTS before the full response is complete, minimising latency.
 *
 * @param userMessage - transcript from Deepgram
 * @yields text chunks from Gemini's streaming API
 */
export async function* getStreamingResponse(
  userMessage: string
): AsyncGenerator<string, void, unknown> {
  try {
    const model = getModel();
    const result = await model.generateContentStream(userMessage);

    for await (const chunk of result.stream) {
      const text: string = chunk.text();
      if (text) yield text;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Gemini API error:', message);
    yield "I'm sorry, I had a technical issue. Could you please repeat that?";
  }
}
