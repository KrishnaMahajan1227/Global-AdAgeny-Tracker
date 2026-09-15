// Voice capture for measurement/notes fields — lets a surveyor speak a
// number instead of typing it. ADDITIVE input method only: every field
// this is attached to still has its normal keyboard/typing behaviour
// untouched regardless of whether voice works, isn't supported, or fails.
//
// Uses the browser's built-in SpeechRecognition (Web Speech API) — there
// is no separate backend/API key involved. Two honest limits worth
// knowing up front, because no amount of client-side tuning removes them:
//   - True background-noise cancellation (traffic, engines, crowd noise)
//     needs either dedicated noise-suppression hardware/DSP or sending
//     audio to a professional cloud speech API with its own noise model —
//     the standard SpeechRecognition API gives this code no access to the
//     raw audio or any noise-suppression controls; it only hands back
//     Chrome's own best-effort transcript. What *is* fully in this code's
//     control, and is what's improved below, is squeezing the most
//     reliable number out of whatever transcript comes back.
//   - The recognizer needs one language selected up front — it does not
//     auto-detect "any Indian language" on the fly mid-sentence. What we
//     can do instead: let the surveyor pick their language once (saved on
//     the phone, asked only the first time) from every major Indian
//     language, and parse numbers correctly regardless of whether that
//     language's engine hands back Arabic digits, its own native digit
//     script (Devanagari, Gujarati, Bengali, Tamil, Telugu, Kannada,
//     Gurmukhi, Malayalam...), or spoken number-words.

// Minimal ambient typing for the (non-standard, vendor-prefixed) Web
// Speech API — not present in default lib.dom.d.ts.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence?: number;
}
interface SpeechRecognitionResultLike {
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  results: { [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null || null;
}

/** True only when the API exists AND we're in a secure context — both are
 *  required for the browser to allow microphone access at all. Checking
 *  both here (not just constructor presence) means the mic button hides
 *  itself instead of rendering something that silently can't work. */
export function isVoiceInputSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext === false) return false;
  return getSpeechRecognitionCtor() !== null;
}

/** Human-readable (Hinglish) reason for a recognition failure, shown right
 *  next to the mic button so "voice isn't working" always has a visible,
 *  actionable cause instead of just doing nothing. */
export function describeVoiceError(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case 'not-supported':
      return "Ye browser/app voice support nahi karta — type kar do.";
    case 'insecure-context':
      return "Voice sirf https wali ya installed app pe chalta hai.";
    case 'not-allowed':
    case 'permission-denied':
    case 'service-not-allowed':
      return "Mic permission band hai — phone Settings me is app ko mic access do.";
    case 'no-speech':
      return "Kuch sunayi nahi diya — shor kam jagah try karo ya dubara bolo.";
    case 'network':
      return "Voice ke liye internet chahiye — signal kamzor hai, type kar do.";
    case 'audio-capture':
      return "Mic nahi mila — check karo koi aur app mic use to nahi kar raha.";
    case 'aborted':
      return null; // user themself cancelled — no need to alarm them
    default:
      return "Voice input me dikkat aayi — dubara try karo ya type kar do.";
  }
}

// ---------------------------------------------------------------------
// Language selection — remembered on this phone so it's only picked once,
// not re-selected every survey. Covers every language the recognizer
// commonly supports across India; "English (India)" stays the default
// since that's what the app shipped with, but a Hindi/Marathi/etc.
// surveyor switches once and it sticks.
// ---------------------------------------------------------------------
export const VOICE_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'हिंदी Hindi' },
  { value: 'mr-IN', label: 'मराठी Marathi' },
  { value: 'gu-IN', label: 'ગુજરાતી Gujarati' },
  { value: 'bn-IN', label: 'বাংলা Bengali' },
  { value: 'ta-IN', label: 'தமிழ் Tamil' },
  { value: 'te-IN', label: 'తెలుగు Telugu' },
  { value: 'kn-IN', label: 'ಕನ್ನಡ Kannada' },
  { value: 'pa-IN', label: 'ਪੰਜਾਬੀ Punjabi' },
  { value: 'ml-IN', label: 'മലയാളം Malayalam' },
  { value: 'ur-IN', label: 'اردو Urdu' },
];

const VOICE_LANG_STORAGE_KEY = 'mahadhan_voice_lang';

export function getSavedVoiceLanguage(): string {
  try {
    return localStorage.getItem(VOICE_LANG_STORAGE_KEY) || 'en-IN';
  } catch {
    return 'en-IN';
  }
}

export function saveVoiceLanguage(lang: string): void {
  try { localStorage.setItem(VOICE_LANG_STORAGE_KEY, lang); } catch { /* private mode etc — non-fatal */ }
}

// ---------------------------------------------------------------------
// Number extraction — the part that actually determines how "accurate"
// this feels. Two layers: (1) normalize every major Indian script's
// native digit characters down to plain 0-9 so it doesn't matter which
// digit script the selected language's engine used, then (2) fall back to
// spoken number-WORDS (English, and Hindi/Marathi in both Devanagari and
// common Roman spellings — the two languages most of this crew speaks) if
// no digit characters were present at all.
// ---------------------------------------------------------------------

// Start codepoint of each script's '0' — every major Indian digit block
// maps the same way: codepoint - start = the digit 0-9.
const INDIC_DIGIT_BLOCKS: number[] = [
  0x0966, // Devanagari (Hindi, Marathi)
  0x09E6, // Bengali
  0x0A66, // Gurmukhi (Punjabi)
  0x0AE6, // Gujarati
  0x0B66, // Oriya
  0x0BE6, // Tamil
  0x0C66, // Telugu
  0x0CE6, // Kannada
  0x0D66, // Malayalam
  0x0660, // Arabic-Indic (Urdu)
];

/** Converts any Indian-script digit characters in the text to plain 0-9,
 *  leaving everything else (including already-plain digits) untouched.
 *  This is what makes number extraction work "regardless of language" for
 *  the common case where the recognizer transcribes a spoken number using
 *  that language's own digit glyphs instead of Arabic numerals. */
export function normalizeIndicDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    let replaced: string | null = null;
    for (const blockStart of INDIC_DIGIT_BLOCKS) {
      const offset = code - blockStart;
      if (offset >= 0 && offset <= 9) { replaced = String(offset); break; }
    }
    out += replaced ?? ch;
  }
  return out;
}

// English number-words, plus common Roman-spelled Hindi/Marathi number
// words (how field staff's Hindi often comes through when the recognizer
// romanizes it, or when it's run in en-IN mode but the surveyor spoke
// Hindi anyway) and the same words in Devanagari script.
const WORD_NUMBERS: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5, quarter: 0.25,
  // Hindi/Marathi — common Roman spellings (varies a lot; covers the
  // most frequent forms for 1-20 plus round tens, which is the range
  // almost every board measurement in feet actually falls in).
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
  chhe: 6, che: 6, saat: 7, aath: 8, aat: 8, nau: 9, das: 10, dus: 10,
  gyarah: 11, gyara: 11, barah: 12, bara: 12, terah: 13, tera: 13,
  chaudah: 14, chauda: 14, pandrah: 15, pandra: 15, solah: 16, sola: 16,
  satrah: 17, satra: 17, atharah: 18, athhara: 18, unnees: 19, unees: 19,
  bees: 20, bis: 20, tees: 30, tis: 30, chalis: 40, chaalis: 40,
  pachas: 50, pachaas: 50, sattar: 70, assi: 80, assee: 80,
  nabbe: 90, sau: 100, dedh: 1.5, sava: 1.25,
  // Hindi/Marathi — Devanagari script (matched as whole "words" since the
  // transcript is split on whitespace the same way as the Roman branch).
  '\u0936\u0942\u0928\u094D\u092F': 0, '\u090F\u0915': 1, '\u0926\u094B': 2,
  '\u0924\u0940\u0928': 3, '\u091A\u093E\u0930': 4, '\u092A\u093E\u0902\u091A': 5,
  '\u091B\u0939': 6, '\u0938\u093E\u0924': 7, '\u0906\u0920': 8, '\u0928\u094C': 9,
  '\u0926\u0938': 10, '\u0917\u094D\u092F\u093E\u0930\u0939': 11, '\u092C\u093E\u0930\u0939': 12,
  '\u0924\u0947\u0930\u0939': 13, '\u091A\u094C\u0926\u0939': 14, '\u092A\u0902\u0926\u094D\u0930\u0939': 15,
  '\u0938\u094B\u0932\u0939': 16, '\u0938\u0924\u094D\u0930\u0939': 17, '\u0905\u0920\u093E\u0930\u0939': 18,
  '\u0909\u0928\u094D\u0928\u0940\u0938': 19, '\u092C\u0940\u0938': 20, '\u0924\u0940\u0938': 30,
  '\u091A\u093E\u0932\u0940\u0938': 40, '\u092A\u091A\u093E\u0938': 50, '\u0938\u093E\u0920': 60,
  '\u0938\u0924\u094D\u0924\u0930': 70, '\u0905\u0938\u094D\u0938\u0940': 80, '\u0928\u092C\u094D\u092C\u0947': 90,
  '\u0938\u094C': 100,
};

function wordsToNumber(text: string): number | null {
  // Keep any-script letters (\p{L}, needs the 'u' flag) alongside digits —
  // stripping to [a-z] only would erase every Hindi/Marathi word before
  // it's even looked up.
  const words = text.toLowerCase().replace(/[^\p{L}\s.]/gu, '').split(/\s+/).filter(Boolean);
  let whole = 0;
  let found = false;
  let decimalPart: number | null = null;
  let inDecimal = false;
  for (const word of words) {
    if (word === 'point' || word === '.') { inDecimal = true; continue; }
    const n = WORD_NUMBERS[word];
    if (n === undefined) continue;
    found = true;
    if (inDecimal) {
      decimalPart = (decimalPart ?? 0) * 10 + (n < 10 ? n : 0);
    } else if (n === 100) {
      whole = (whole || 1) * 100;
    } else {
      whole += n;
    }
  }
  if (!found) return null;
  return decimalPart != null ? whole + decimalPart / Math.pow(10, String(decimalPart).length) : whole;
}

/**
 * Pulls the first usable number out of a spoken transcript. Normalizes
 * Indic-script digits to plain 0-9 first, tries plain digits, then falls
 * back to word-numbers (English or Hindi/Marathi, Roman or Devanagari).
 * Returns null (not "0") when nothing numeric could be found, so the
 * caller can leave the field untouched rather than silently zeroing it.
 */
export function extractFirstNumber(transcript: string): string | null {
  const cleaned = normalizeIndicDigits(transcript.trim()).replace(/,/g, '');
  const digitMatch = cleaned.match(/\d+(\.\d+)?/);
  if (digitMatch) return digitMatch[0];
  const n = wordsToNumber(cleaned);
  return n != null ? String(n) : null;
}

/**
 * Pulls every number out of a transcript, in the order spoken — used for
 * "speak both dimensions at once" ("10 by 15", "das baai pandra", "10 15").
 * Same digit-normalization + word fallback as extractFirstNumber, but
 * collects every number found instead of stopping at the first.
 */
export function extractAllNumbers(transcript: string): string[] {
  const cleaned = normalizeIndicDigits(transcript.trim()).replace(/,/g, '');
  const digitMatches = cleaned.match(/\d+(\.\d+)?/g);
  if (digitMatches && digitMatches.length > 0) return digitMatches;

  const CONNECTOR = /\b(by|into|cross|x|baai|bai|guna)\b/iu;
  const sides = cleaned.split(CONNECTOR).filter((s) => s.trim() && !CONNECTOR.test(s));
  const nums: string[] = [];
  for (const side of sides) {
    const n = wordsToNumber(side);
    if (n != null) nums.push(String(n));
  }
  if (nums.length > 0) return nums;

  // Last resort: one single number-word in the whole sentence.
  const single = wordsToNumber(cleaned);
  return single != null ? [String(single)] : [];
}

/** Scores a transcript by how "useful" it looks for a measurement field —
 *  used to pick the best of several recognizer alternatives when
 *  background noise makes the top-ranked guess garbled. More numbers
 *  found, and a shorter/cleaner transcript (fewer stray noise-words
 *  around the number), both count as better. */
function scoreTranscriptForNumbers(transcript: string): number {
  const numbers = extractAllNumbers(transcript);
  if (numbers.length === 0) return -1;
  return numbers.length * 100 - transcript.length;
}

/** Picks the best alternative transcript out of everything the recognizer
 *  offered for one utterance. Chrome (and most engines) return several
 *  ranked guesses per result when maxAlternatives > 1 — normally only the
 *  top one is used, but background noise sometimes garbles specifically
 *  the top guess while a lower-ranked alternative still has the number
 *  intact. Falls back to the top-ranked transcript when none of the
 *  alternatives contain a usable number, so free-text dictation (Notes)
 *  and ordinary results are unaffected. */
function pickBestAlternative(result: SpeechRecognitionResultLike): string {
  const alternatives: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const alt = result[i]?.transcript;
    if (alt) alternatives.push(alt);
  }
  if (alternatives.length === 0) return '';
  if (alternatives.length === 1) return alternatives[0];

  let best = alternatives[0];
  let bestScore = scoreTranscriptForNumbers(alternatives[0]);
  for (let i = 1; i < alternatives.length; i++) {
    const score = scoreTranscriptForNumbers(alternatives[i]);
    if (score > bestScore) { best = alternatives[i]; bestScore = score; }
  }
  return best;
}

interface UseVoiceCaptureOptions {
  /** BCP-47 language tag. If omitted, uses the surveyor's saved language
   *  preference (see VOICE_LANGUAGE_OPTIONS / getSavedVoiceLanguage),
   *  which defaults to Indian English until they change it. */
  lang?: string;
}

export interface VoiceCaptureHandle {
  supported: boolean;
  listening: boolean;
  error: string | null;
  errorMessage: string | null;
  start: (onResult: (transcript: string) => void) => void;
  stop: () => void;
}

import { useCallback, useRef, useState } from 'react';

export function useVoiceCapture(options: UseVoiceCaptureOptions = {}): VoiceCaptureHandle {
  const lang = options.lang || getSavedVoiceLanguage();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = isVoiceInputSupported();

  const start = useCallback((onResult: (transcript: string) => void) => {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setError('insecure-context');
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) { setError('not-supported'); return; }

    // Guard against a stray double-tap starting a second recognizer while
    // one is already listening — stop the old one first.
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* already stopped */ }
    }

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = false;
    // Ask for several ranked guesses, not just the top one — this is what
    // lets pickBestAlternative recover a number that background noise
    // garbled in the recognizer's #1 guess but left intact further down
    // its ranked list.
    recognition.maxAlternatives = 5;

    let gotResult = false;

    recognition.onresult = (event) => {
      const result = event.results?.[0];
      if (!result) return;
      const transcript = pickBestAlternative(result);
      if (transcript) {
        gotResult = true;
        onResult(transcript);
      }
    };
    recognition.onerror = (event) => {
      setError(event.error || 'error');
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      // Recognizer ended cleanly but produced nothing (e.g. it heard
      // silence/noise it couldn't transcribe at all) — surface that too,
      // instead of the button just going quiet with no result and no
      // visible error, which is exactly what read as "not working".
      if (!gotResult) setError((prev) => prev ?? 'no-speech');
    };

    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    try {
      recognition.start();
    } catch {
      // Some browsers throw if start() is called in an already-listening
      // state; fail quietly and let the surveyor tap the mic again.
      setListening(false);
      setError('start-failed');
    }
  }, [lang]);

  const stop = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* no-op */ }
    setListening(false);
  }, []);

  return { supported, listening, error, errorMessage: describeVoiceError(error), start, stop };
}
