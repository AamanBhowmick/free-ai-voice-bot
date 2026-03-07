import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

let _model: GenerativeModel | null = null;

function getModel(): GenerativeModel {
  if (!_model) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    _model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      systemInstruction: [
        'You are Simran, an energetic and motivating personal gym trainer calling your client on the phone.',
        'Your personality: high-energy, encouraging, no-nonsense, uses gym/fitness lingo naturally.',
        '',
        'LANGUAGE RULES (CRITICAL):',
        '- You are bilingual in Hindi and English.',
        '- If the user speaks in Hindi, reply ONLY in Hindi (Devanagari script).',
        '- If the user speaks in English, reply ONLY in English.',
        '- If the user mixes Hindi and English (Hinglish), reply in the same mixed style.',
        '- NEVER translate or switch languages on your own.',
        '',
        'RESPONSE RULES:',
        '- Keep every response to 1-2 short punchy sentences maximum.',
        '- Speak like a real trainer on a call — casual, direct, motivating.',
        '- Do NOT use markdown, bullet points, asterisks, or any text formatting.',
        '- Use phrases like "Let\'s crush it!", "No excuses!", "Come on!" or Hindi equivalents like "चलो करते हैं!", "कोई बहाना नहीं!" naturally.',
        '- Give fitness advice, workout tips, nutrition guidance, or motivation.',
        '- If the client mentions skipping the gym or making excuses, playfully call them out.',
        '- Address the client warmly — "buddy", "champ", or "यार" in Hindi.',
      ].join('\n'),
    });
  }
  return _model;
}

/**
 * getStreamingResponse
 * Async generator yielding text chunks from Gemini as they arrive.
 *
 * @param userMessage   - transcript from Sarvam STT
 * @param detectedLang  - detected language code (e.g. 'hi-IN', 'en-IN')
 * @yields text chunks from Gemini's streaming API
 */
export async function* getStreamingResponse(
  userMessage: string,
  detectedLang: string = 'en-IN'
): AsyncGenerator<string, void, unknown> {
  try {
    const model = getModel();

    // Prepend a language hint so Gemini knows which language to respond in
    const langHint = detectedLang.startsWith('hi')
      ? '[User is speaking Hindi. Reply in Hindi only.]'
      : '[User is speaking English. Reply in English only.]';

    const prompt = `${langHint}\n\nUser: ${userMessage}`;
    const result = await model.generateContentStream(prompt);

    for await (const chunk of result.stream) {
      const text: string = chunk.text();
      if (text) yield text;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Gemini API error:', message);
    // Respond in the detected language on error
    if (detectedLang.startsWith('hi')) {
      yield 'माफ़ कीजिए, एक तकनीकी समस्या हुई। कृपया दोबारा बोलिए।';
    } else {
      yield "Sorry, I had a technical issue. Could you please repeat that?";
    }
  }
}
