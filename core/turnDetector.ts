import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Semantic Turn Detector
 *
 * Analyzes a transcript to determine if the user has finished their thought
 * or is mid-sentence. Uses fast heuristic rules first, falls back to
 * Gemini Flash for uncertain cases.
 *
 * Flow:
 *   transcript → heuristics (instant) → COMPLETE / INCOMPLETE
 *                                      → UNCERTAIN → Gemini Flash (~200ms) → COMPLETE / INCOMPLETE
 */

export enum TurnResult {
  COMPLETE = 'COMPLETE',
  INCOMPLETE = 'INCOMPLETE',
}

// ── Trailing conjunctions / connectors per language ──────────────

const EN_TRAILING = new Set([
  'and', 'but', 'or', 'because', 'since', 'so', 'that', 'which', 'who',
  'whom', 'whose', 'where', 'when', 'while', 'if', 'unless', 'although',
  'though', 'however', 'also', 'then', 'like', 'with', 'for', 'to',
  'the', 'a', 'an', 'my', 'your', 'in', 'on', 'at', 'is', 'are', 'was',
  'i', 'we', 'they', 'he', 'she', 'it', 'can', 'should', 'will', 'would',
  'could', 'do', 'does', 'did', 'have', 'has', 'had', 'not',
]);

// Hindi / Marathi (Devanagari)
const HI_MR_TRAILING = new Set([
  'और', 'लेकिन', 'या', 'क्योंकि', 'इसलिए', 'कि', 'जो', 'जिसे',
  'तो', 'भी', 'पर', 'मगर', 'ताकि', 'जब', 'अगर', 'हालांकि',
  'मैं', 'हम', 'वो', 'यह', 'वह', 'मेरा', 'मेरी', 'का', 'की', 'के',
  'में', 'पे', 'से', 'को', 'है', 'हैं', 'था', 'थी', 'करो', 'करना',
  // Marathi additions
  'आणि', 'पण', 'किंवा', 'कारण', 'म्हणून', 'जर', 'तर', 'मी', 'आम्ही',
]);

// Bengali
const BN_TRAILING = new Set([
  'এবং', 'কিন্তু', 'বা', 'কারণ', 'তাই', 'যে', 'যা', 'যদি', 'তাহলে',
  'আমি', 'আমরা', 'তুমি', 'সে', 'এটা', 'ওটা', 'আর', 'তবে', 'যখন',
]);

// Gujarati
const GU_TRAILING = new Set([
  'અને', 'પણ', 'અથવા', 'કારણ', 'એટલે', 'જે', 'જો', 'તો', 'કે',
  'હું', 'અમે', 'તમે', 'તે', 'આ', 'એ', 'માં', 'પર', 'ને', 'છે',
]);

// ── Sentence-ending punctuation ─────────────────────────────────

const SENTENCE_END = /[.!?।॥\u0964\u0965]$/;

// ── Question words (indicates a complete question if enough context) ─

const QUESTION_WORDS = new Set([
  // English
  'what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom',
  'can', 'could', 'should', 'would', 'will', 'do', 'does', 'is', 'are',
  // Hindi/Marathi
  'क्या', 'कैसे', 'क्यों', 'कब', 'कहाँ', 'कहां', 'कौन', 'किसे', 'कितना', 'कितने',
  // Bengali
  'কি', 'কেন', 'কখন', 'কোথায়', 'কে', 'কত',
  // Gujarati
  'શું', 'કેવી', 'કેમ', 'ક્યારે', 'ક્યાં', 'કોણ', 'કેટલું',
]);

// ── Detect script ───────────────────────────────────────────────

function detectScript(text: string): 'en' | 'hi' | 'bn' | 'gu' {
  if (/[\u0980-\u09FF]/.test(text)) return 'bn';       // Bengali script
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu';       // Gujarati script
  if (/[\u0900-\u097F]/.test(text)) return 'hi';       // Devanagari (Hindi/Marathi)
  return 'en';
}

function getTrailingSet(script: 'en' | 'hi' | 'bn' | 'gu'): Set<string> {
  switch (script) {
    case 'bn': return BN_TRAILING;
    case 'gu': return GU_TRAILING;
    case 'hi': return HI_MR_TRAILING;
    default:   return EN_TRAILING;
  }
}

// ── Main heuristic analysis ─────────────────────────────────────

/**
 * analyzeTurn — Fast heuristic turn detection (instant, no API call)
 *
 * Returns COMPLETE if the user is likely done speaking,
 * INCOMPLETE if they seem to be mid-sentence.
 *
 * For uncertain cases, returns null → caller should use analyzeTurnWithAI.
 */
export function analyzeTurn(transcript: string): TurnResult | null {
  const text = transcript.trim();
  if (!text) return TurnResult.INCOMPLETE;

  const script = detectScript(text);
  const words = text.split(/\s+/);
  const wordCount = words.length;
  const lastWord = words[words.length - 1].toLowerCase();
  const trailingSet = getTrailingSet(script);

  // Rule 1: Ends with sentence punctuation → COMPLETE
  if (SENTENCE_END.test(text)) {
    return TurnResult.COMPLETE;
  }

  // Rule 2: Very short (1 word) → likely incomplete unless it's a greeting
  if (wordCount === 1) {
    const greetings = new Set(['hello', 'hi', 'hey', 'haan', 'namaskar', 'namaste',
      'हाँ', 'नहीं', 'হ্যাঁ', 'না', 'हो', 'नमस्ते', 'হ্যালো', 'હા', 'ના']);
    if (greetings.has(lastWord)) return TurnResult.COMPLETE;
    return TurnResult.INCOMPLETE;
  }

  // Rule 3: Ends with conjunction/connector → INCOMPLETE
  if (trailingSet.has(lastWord)) {
    return TurnResult.INCOMPLETE;
  }

  // Rule 4: Contains a question word AND has 3+ words → likely COMPLETE
  const hasQuestion = words.some(w => QUESTION_WORDS.has(w.toLowerCase()));
  if (hasQuestion && wordCount >= 3) {
    return TurnResult.COMPLETE;
  }

  // Rule 5: Long enough (5+ words, no trailing connector) → likely COMPLETE
  if (wordCount >= 5) {
    return TurnResult.COMPLETE;
  }

  // Rule 6: 2-4 words without punctuation or question word → UNCERTAIN
  return null;
}

// ── Gemini Flash fallback for uncertain cases ───────────────────

let _turnModel: any = null;

function getTurnModel() {
  if (!_turnModel) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    _turnModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction:
        'You are a turn-detection classifier for a voice call. ' +
        'Given a transcript snippet, respond with EXACTLY one word: ' +
        '"COMPLETE" if the user has finished their thought, ' +
        '"INCOMPLETE" if they are mid-sentence. ' +
        'Consider Hindi, English, Marathi, Bengali, and Gujarati. ' +
        'Respond with ONLY "COMPLETE" or "INCOMPLETE".',
    });
  }
  return _turnModel;
}

/**
 * analyzeTurnWithAI — Gemini Flash fallback (~200ms)
 * Used only when heuristics return null (uncertain).
 */
export async function analyzeTurnWithAI(transcript: string): Promise<TurnResult> {
  try {
    const model = getTurnModel();
    const result = await model.generateContent(transcript);
    const response = result.response.text().trim().toUpperCase();

    if (response.includes('COMPLETE')) return TurnResult.COMPLETE;
    if (response.includes('INCOMPLETE')) return TurnResult.INCOMPLETE;

    console.log(`⚡ Turn AI: uncertain response "${response}", defaulting to COMPLETE`);
    return TurnResult.COMPLETE;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Turn detector AI error:', msg);
    return TurnResult.COMPLETE;
  }
}

/**
 * detectTurn — Full turn detection pipeline
 * Heuristics first (instant), Gemini Flash fallback for uncertain cases.
 */
export async function detectTurn(transcript: string): Promise<TurnResult> {
  const heuristic = analyzeTurn(transcript);

  if (heuristic !== null) {
    const label = heuristic === TurnResult.COMPLETE ? '✅' : '⏳';
    console.log(`${label} Turn [heuristic]: ${heuristic} — "${transcript.slice(0, 60)}"`);
    return heuristic;
  }

  // Uncertain → ask Gemini Flash
  console.log(`🤔 Turn [uncertain]: asking AI — "${transcript.slice(0, 60)}"`);
  const aiResult = await analyzeTurnWithAI(transcript);
  const label = aiResult === TurnResult.COMPLETE ? '✅' : '⏳';
  console.log(`${label} Turn [AI]: ${aiResult}`);
  return aiResult;
}
