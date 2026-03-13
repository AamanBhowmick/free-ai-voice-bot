import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';

let _model: GenerativeModel | null = null;
let _chat: ChatSession | null = null;

/** Map language codes to human-readable names for Gemini hints */
const LANG_NAMES: Record<string, { name: string; script: string }> = {
  'hi': { name: 'Hindi', script: 'Devanagari' },
  'mr': { name: 'Marathi', script: 'Devanagari' },
  'bn': { name: 'Bengali', script: 'Bengali' },
  'gu': { name: 'Gujarati', script: 'Gujarati' },
  'en': { name: 'English', script: 'Latin' },
};

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
        '- You are multilingual. You speak Hindi, English, Marathi, Bengali, and Gujarati fluently.',
        '- ALWAYS respond in the SAME language the user is speaking.',
        '- If the user speaks Hindi, respond ONLY in Hindi (Devanagari script).',
        '- If the user speaks English, respond ONLY in English.',
        '- If the user speaks Marathi, respond ONLY in Marathi (Devanagari script).',
        '- If the user speaks Bengali, respond ONLY in Bengali (Bengali script).',
        '- If the user speaks Gujarati, respond ONLY in Gujarati (Gujarati script).',
        '- If the user code-mixes languages, match their mixed style.',
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
 */
function getChat(): ChatSession {
  if (!_chat) {
    _chat = getModel().startChat({ history: [] });
  }
  return _chat;
}

/**
 * Build a language hint for Gemini based on the detected language code.
 */
function buildLangHint(detectedLang: string): string {
  const prefix = detectedLang.split('-')[0].toLowerCase();
  const info = LANG_NAMES[prefix];

  if (info) {
    return `[User spoke in ${info.name}. Respond ONLY in ${info.name} using ${info.script} script.]`;
  }
  return '[User spoke in English. Respond in English only.]';
}

/**
 * Build a localized error message for the detected language.
 */
function getErrorMessage(detectedLang: string): string {
  const prefix = detectedLang.split('-')[0].toLowerCase();
  switch (prefix) {
    case 'hi': return 'क्षमा करें, एक तकनीकी समस्या हुई। कृपया दोबारा कहें।';
    case 'mr': return 'क्षमा करा, एक तांत्रिक समस्या आली. कृपया पुन्हा सांगा.';
    case 'bn': return 'দুঃখিত, একটি প্রযুক্তিগত সমস্যা হয়েছে। অনুগ্রহ করে আবার বলুন।';
    case 'gu': return 'માફ કરશો, એક ટેકનિકલ સમસ્યા આવી. કૃપા કરીને ફરીથી કહો.';
    default:   return "Sorry, I had a brief issue. Could you repeat that?";
  }
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
    const langHint = buildLangHint(detectedLang);
    const prompt = `${langHint}\n${userMessage}`;
    const result = await chat.sendMessageStream(prompt);

    for await (const chunk of result.stream) {
      const text: string = chunk.text();
      if (text) yield text;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Gemini API error:', message);
    _chat = null;
    yield getErrorMessage(detectedLang);
  }
}

/**
 * Reset the chat session (e.g., when a new call starts).
 */
export function resetChat(): void {
  _chat = null;
}
