// Voice capture for measurement/notes fields — lets a surveyor speak a
// number ("das", "ten", "10") instead of typing it. This is an ADDITIVE
// input method only: every field this is attached to still has its normal
// keyboard/typing behaviour untouched, so if voice isn't supported on a
// device/browser, or recognition fails, or the surveyor simply prefers to
// type, nothing about the existing flow changes or breaks.
//
// Uses the browser's built-in SpeechRecognition (Web Speech API) — no new
// backend/API dependency. IMPORTANT real-world gotchas this file handles
// explicitly (silent failure was the #1 complaint — every failure path
// below now returns a reason instead of just doing nothing):
//   1. SpeechRecognition needs a secure context (https:// or localhost).
//      Testing over a plain http:// LAN address (common when previewing
//      on a real phone during development) will silently fail otherwise.
//   2. Chrome's recognizer sends audio to Google's servers — it needs an
//      actual internet connection, separate from the app's own offline
//      support. Weak/no signal on-site → 'network' error, not a hang.
//   3. Mic permission can be denied/blocked at the OS or browser level.
//   4. Some in-app browsers / webviews don't implement the API at all.

// Minimal ambient typing for the (non-standard, vendor-prefixed) Web
// Speech API — not present in default lib.dom.d.ts.
interface SpeechRecognitionResultLike {
  [index: number]: { transcript: string };
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
      return "Kuch sunayi nahi diya — dubara mic dabao aur bolo.";
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

// Spoken-word numbers the recognizer sometimes returns as words instead of
// digits (varies by browser/OS/language pack) — covers the common range a
// field measurement realistically falls in. Anything already spoken as a
// digit ("10", "10.5") is matched directly and doesn't need this table.
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5, quarter: 0.25,
};

function wordsToNumber(text: string): number | null {
  const words = text.toLowerCase().replace(/[^a-z\s.]/g, '').split(/\s+/).filter(Boolean);
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
 * Pulls the first usable number out of a spoken transcript. Tries plain
 * digits first, then falls back to word-numbers ("ten point five").
 * Returns null (not "0") when nothing numeric could be found, so the
 * caller can leave the field untouched rather than silently zeroing it.
 */
export function extractFirstNumber(transcript: string): string | null {
  const cleaned = transcript.trim().replace(/,/g, '');
  const digitMatch = cleaned.match(/\d+(\.\d+)?/);
  if (digitMatch) return digitMatch[0];
  const n = wordsToNumber(cleaned);
  return n != null ? String(n) : null;
}

/**
 * Pulls every number out of a transcript, in the order spoken — used for
 * "speak both dimensions at once" ("10 by 15", "das baai pandra", "10 15").
 * Tries digits globally first (handles almost every real recognizer
 * result); if the recognizer returned pure words instead, falls back to
 * splitting on the connector word ("by"/"into"/"x"/"baai") and reading a
 * number out of each side.
 */
export function extractAllNumbers(transcript: string): string[] {
  const cleaned = transcript.trim().replace(/,/g, '');
  const digitMatches = cleaned.match(/\d+(\.\d+)?/g);
  if (digitMatches && digitMatches.length > 0) return digitMatches;

  const CONNECTOR = /\b(by|into|cross|x|baai|bai)\b/i;
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

interface UseVoiceCaptureOptions {
  /** BCP-47 language tag. Defaults to Indian English, which the phone's
   *  speech engine generally handles well for both English and
   *  Hindi-accented number words; callers can pass 'hi-IN' explicitly for
   *  a Hindi-first crew. */
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
  const { lang = 'en-IN' } = options;
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
    recognition.maxAlternatives = 1;

    let gotResult = false;

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
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
