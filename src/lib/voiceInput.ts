// Voice capture for measurement/notes fields — lets a surveyor speak a
// number ("das", "ten", "10") instead of typing it. This is an ADDITIVE
// input method only: every field this is attached to still has its normal
// keyboard/typing behaviour untouched, so if voice isn't supported on a
// device/browser, or recognition fails, or the surveyor simply prefers to
// type, nothing about the existing flow changes or breaks.
//
// Uses the browser's built-in SpeechRecognition (Web Speech API) — no new
// backend/API dependency, works fully offline-tolerant in the sense that
// it just doesn't render the mic button when unsupported (feature-detected
// once, not per-render).

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
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null || null;
}

export const isVoiceInputSupported = (): boolean => getSpeechRecognitionCtor() !== null;

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

/**
 * Pulls the first usable number out of a spoken transcript. Tries a plain
 * digit first (handles "10", "10.5", "साढ़े 10 फ़ीट" style mixed input where
 * the number itself is already numeric), then falls back to matching a
 * simple word-number combination like "ten point five" or "twenty two".
 * Returns null (not "0") when nothing numeric could be found, so the
 * caller can leave the field untouched rather than silently zeroing it.
 */
export function extractFirstNumber(transcript: string): string | null {
  const cleaned = transcript.trim();

  // Plain digits, optionally with a decimal point — covers the vast
  // majority of real recognizer output for measurements.
  const digitMatch = cleaned.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (digitMatch) return digitMatch[0];

  // Word-number fallback: "ten", "twenty five", "ten point five".
  const words = cleaned.toLowerCase().replace(/[^a-z\s.]/g, '').split(/\s+/).filter(Boolean);
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
  const result = decimalPart != null ? whole + decimalPart / Math.pow(10, String(decimalPart).length) : whole;
  return String(result);
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

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) onResult(transcript);
    };
    recognition.onerror = (event) => {
      setError(event.error || 'error');
      setListening(false);
    };
    recognition.onend = () => setListening(false);

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

  return { supported, listening, error, start, stop };
}
