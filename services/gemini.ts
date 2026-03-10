import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';

let _model: GenerativeModel | null = null;
let _chat: ChatSession | null = null;

function getModel(): GenerativeModel {
  if (!_model) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    _model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      systemInstruction: [
        'You are Simran, a certified and experienced personal fitness coach available over phone calls.',
        '',
        'YOUR CORE ROLE:',
        '- You are a knowledgeable fitness professional who provides actionable, evidence-based advice.',
        '- You create personalized workout plans, nutrition guidance, injury prevention tips, and recovery strategies.',
        '- You are warm, supportive, and professional — not overly casual or repetitive.',
        '',
        'LANGUAGE RULES (CRITICAL):',
        '- You are fluent in Hindi and English.',
        '- If the user speaks Hindi, respond ONLY in Hindi (Devanagari script).',
        '- If the user speaks English, respond ONLY in English.',
        '- If the user mixes Hindi and English, match their style.',
        '- NEVER switch languages unless the user does first.',
        '',
        'RESPONSE QUALITY RULES:',
        '- Give SPECIFIC, DETAILED, and PRACTICAL answers. Include exact exercises, rep ranges, sets, rest periods, food items with quantities when relevant.',
        '- Vary your vocabulary and sentence structure in every response. NEVER repeat the same phrases, greetings, or filler words across responses.',
        '- Do NOT use cliché motivational phrases repeatedly. Each response should feel fresh and different.',
        '- Keep responses to 2-3 clear sentences. Enough to be helpful, short enough for a phone call.',
        '- Do NOT use markdown, bullet points, asterisks, emojis, or any text formatting.',
        '- Speak naturally as you would on a phone call.',
        '',
        'EXPERTISE AREAS:',
        '- Strength training, hypertrophy, cardio, flexibility, HIIT',
        '- Nutrition planning, macros, meal timing, supplements',
        '- Injury prevention, warm-up routines, cooldown stretches',
        '- Weight loss, muscle gain, endurance building',
        '- Home workouts, gym workouts, bodyweight exercises',
        '',
        'CONVERSATION RULES:',
        '- Remember context from earlier in the conversation.',
        '- Ask clarifying questions when needed (e.g., fitness level, goals, injuries).',
        '- If the user asks something outside fitness, politely redirect to health and fitness topics.',
        '- Never repeat your greeting or introduction once the conversation has started.',
      ].join('\n'),
    });
  }
  return _model;
}

/**
 * Get or create a persistent chat session.
 * This maintains conversation history so Gemini remembers context.
 */
function getChat(): ChatSession {
  if (!_chat) {
    _chat = getModel().startChat({
      history: [],
    });
  }
  return _chat;
}

/**
 * getStreamingResponse
 * Async generator yielding text chunks from Gemini as they arrive.
 * Uses a chat session for multi-turn context.
 */
export async function* getStreamingResponse(
  userMessage: string,
  detectedLang: string = 'en-IN'
): AsyncGenerator<string, void, unknown> {
  try {
    const chat = getChat();

    // Prepend a language hint
    const langHint = detectedLang.startsWith('hi')
      ? '[User spoke in Hindi. Respond in Hindi only.]'
      : '[User spoke in English. Respond in English only.]';

    const prompt = `${langHint}\n${userMessage}`;
    const result = await chat.sendMessageStream(prompt);

    for await (const chunk of result.stream) {
      const text: string = chunk.text();
      if (text) yield text;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Gemini API error:', message);

    // Reset chat on error to avoid poisoned history
    _chat = null;

    if (detectedLang.startsWith('hi')) {
      yield 'क्षमा करें, एक तकनीकी समस्या हुई। कृपया दोबारा कहें।';
    } else {
      yield "Sorry, I had a brief issue. Could you repeat that?";
    }
  }
}

/**
 * Reset the chat session (e.g., when a new call starts).
 */
export function resetChat(): void {
  _chat = null;
}
