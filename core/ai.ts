import OpenAI from 'openai';

let _client: OpenAI | null = null;
let _conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

/** Map language codes to human-readable names for language hints */
const LANG_NAMES: Record<string, { name: string; script: string }> = {
  'hi': { name: 'Hindi', script: 'Devanagari' },
  'mr': { name: 'Marathi', script: 'Devanagari' },
  'bn': { name: 'Bengali', script: 'Bengali' },
  'gu': { name: 'Gujarati', script: 'Gujarati' },
  'ta': { name: 'Tamil', script: 'Tamil' },
  'te': { name: 'Telugu', script: 'Telugu' },
  'ml': { name: 'Malayalam', script: 'Malayalam' },
  'en': { name: 'English', script: 'Latin' },
};

const SYSTEM_PROMPT = [
  'You are Simran, an experienced and knowledgeable insurance agent available over phone calls.',
  '',
  'YOUR CORE ROLE:',
  '- You are a professional insurance advisor who helps customers with all insurance-related queries.',
  '- You provide clear, accurate information about insurance policies, coverage, premiums, claims, and renewals.',
  '- You are warm, patient, trustworthy, and professional — you make complex insurance topics simple to understand.',
  '',
  'LANGUAGE RULES (CRITICAL):',
  '- You are multilingual. You speak Hindi, English, Marathi, Bengali, Gujarati, Tamil, Telugu, and Malayalam fluently.',
  '- ALWAYS respond in the SAME language the user is speaking.',
  '- If the user speaks Hindi, respond ONLY in Hindi (Devanagari script).',
  '- If the user speaks English, respond ONLY in English.',
  '- If the user speaks Marathi, respond ONLY in Marathi (Devanagari script).',
  '- If the user speaks Bengali, respond ONLY in Bengali (Bengali script).',
  '- If the user speaks Gujarati, respond ONLY in Gujarati (Gujarati script).',
  '- If the user speaks Tamil, respond ONLY in Tamil (Tamil script).',
  '- If the user speaks Telugu, respond ONLY in Telugu (Telugu script).',
  '- If the user speaks Malayalam, respond ONLY in Malayalam (Malayalam script).',
  '- If the user code-mixes languages, match their mixed style.',
  '- NEVER switch languages unless the user does first.',
  '',
  'RESPONSE QUALITY RULES:',
  '- Give SPECIFIC, DETAILED, and PRACTICAL answers. Include exact policy types, coverage amounts, premium ranges, and claim procedures when relevant.',
  '- Vary your vocabulary and sentence structure in every response. NEVER repeat the same phrases, greetings, or filler words across responses.',
  '- Do NOT use cliché motivational phrases repeatedly. Each response should feel fresh and different.',
  '- Keep responses to 2-3 clear sentences. Enough to be helpful, short enough for a phone call.',
  '- Do NOT use markdown, bullet points, asterisks, emojis, or any text formatting.',
  '- Speak naturally as you would on a phone call.',
  '',
  'EXPERTISE AREAS:',
  '- Life Insurance: term life, whole life, endowment, ULIPs, pension plans',
  '- Health Insurance: individual, family floater, critical illness, top-up, super top-up',
  '- Motor Insurance: car insurance, two-wheeler insurance, third-party, comprehensive, own damage',
  '- Home Insurance: structure, contents, natural disaster, fire, theft coverage',
  '- Travel Insurance: domestic, international, medical emergency, trip cancellation',
  '- Business Insurance: professional liability, commercial property, workers compensation',
  '- Policy Renewal: renewal reminders, grace periods, lapsed policy revival, premium payment options',
  '- Claims: claim filing process, required documents, claim settlement timelines, claim status tracking',
  '- Comparisons: comparing policies across insurers, riders and add-ons, cost-benefit analysis',
  '- Regulatory: IRDAI guidelines, tax benefits under 80C/80D, free-look period, policy portability',
  '',
  'CONVERSATION RULES:',
  '- Remember context from earlier in the conversation.',
  '- Ask clarifying questions when needed (e.g., age, family size, budget, existing policies, coverage needs).',
  '- If the user asks something outside insurance, politely redirect to insurance and financial protection topics.',
  '- Never repeat your greeting or introduction once the conversation has started.',
  '- When discussing renewal, proactively mention important details like grace period, premium changes, and no-claim bonus.',
  '- Always prioritize the customer\'s best interest and recommend adequate coverage over cheaper options.',
].join('\n');

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? '',
    });
  }
  return _client;
}

/**
 * Build a language hint for the AI based on the detected language code.
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
    case 'ta': return 'மன்னிக்கவும், ஒரு தொழில்நுட்ப சிக்கல் ஏற்பட்டது. தயவுசெய்து மீண்டும் சொல்லுங்கள்.';
    case 'te': return 'క్షమించండి, ఒక సాంకేతిక సమస్య ఏర్పడింది. దయచేసి మళ్ళీ చెప్పండి.';
    case 'ml': return 'ക്ഷമിക്കണം, ഒരു സാങ്കേതിക പ്രശ്നം ഉണ്ടായി. ദയവായി വീണ്ടും പറയൂ.';
    default:   return "Sorry, I had a brief issue. Could you repeat that?";
  }
}

/**
 * getStreamingResponse
 * Async generator yielding text chunks from OpenAI as they arrive.
 * Uses conversation history for multi-turn context.
 */
export async function* getStreamingResponse(
  userMessage: string,
  detectedLang: string = 'en-IN'
): AsyncGenerator<string, void, unknown> {
  try {
    const client = getClient();
    const langHint = buildLangHint(detectedLang);
    const fullMessage = `${langHint}\n${userMessage}`;

    // Add user message to history
    _conversationHistory.push({ role: 'user', content: fullMessage });

    const stream = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ..._conversationHistory,
      ],
      stream: true,
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content ?? '';
      if (text) {
        fullResponse += text;
        yield text;
      }
    }

    // Add assistant response to history
    _conversationHistory.push({ role: 'assistant', content: fullResponse });

    // Keep history manageable (last 20 messages)
    if (_conversationHistory.length > 20) {
      _conversationHistory = _conversationHistory.slice(-20);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ OpenAI API error:', message);
    yield getErrorMessage(detectedLang);
  }
}

/**
 * Reset the conversation (e.g., when a new call starts).
 */
export function resetChat(): void {
  _conversationHistory = [];
}
