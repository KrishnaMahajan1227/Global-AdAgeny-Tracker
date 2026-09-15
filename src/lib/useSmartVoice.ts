import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioRecorder } from './useAudioRecorder';
import { useVoiceCapture } from './voiceInput';
import { transcribeWithGemini } from './geminiVoice';

// Combines two capture paths behind one simple tap-to-record button:
//
//   1. PRIMARY — record a clip → send to Gemini via the voice-transcribe
//      edge function. Handles background noise and auto-detects whichever
//      Indian language (or English, or a mix) was spoken. Requires the
//      edge function to be deployed with a GEMINI_API_KEY secret (see
//      supabase/functions/voice-transcribe).
//   2. FALLBACK — if step 1 fails for ANY reason (function not deployed,
//      no network, mic permission issue, Gemini didn't catch anything),
//      automatically retries using the phone's built-in browser speech
//      recognizer (the original implementation) — so voice input never
//      just stops working outright, it degrades to the older, less
//      noise-tolerant path instead, with a visible note about why.
//
// This is intentionally ONE hook shared by both the per-field mic button
// and the combined Width+Height "Speak Size" button, so both get the same
// robustness and the same fallback behaviour.

export type SmartVoiceStatus = 'idle' | 'recording' | 'processing' | 'listening';

export interface SmartVoiceResult {
  transcript: string;
  numbers: string[];
  language: string | null;
}

export interface SmartVoiceHandle {
  status: SmartVoiceStatus;
  /** Info/warning to show the user right now — set on fallback, on
   *  failure, or cleared once a result comes back cleanly. */
  message: string | null;
  /** True once this attempt has dropped back to the basic browser
   *  recognizer — lets the UI show a lighter-weight hint about why
   *  results might be less accurate for this attempt. */
  usedFallback: boolean;
  /** Nothing is recorded until the surveyor taps at all — no mic
   *  permission prompt on page load. */
  supported: boolean;
  /** Tap handler: first tap starts recording (or, if the mic-recording
   *  path isn't supported at all, goes straight to the browser
   *  recognizer); second tap stops and sends for transcription. */
  tap: (onResult: (result: SmartVoiceResult) => void) => void;
}

export function useSmartVoice(): SmartVoiceHandle {
  const recorder = useAudioRecorder();
  const browserVoice = useVoiceCapture({ lang: 'en-IN' });
  const [status, setStatus] = useState<SmartVoiceStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const resultCbRef = useRef<((r: SmartVoiceResult) => void) | null>(null);

  const runBrowserFallback = useCallback((reason?: string) => {
    if (!browserVoice.supported) {
      setMessage(reason ? `${reason} Basic voice bhi is phone/browser me nahi chalta — type kar do.` : 'Voice yahan support nahi hai — type kar do.');
      setStatus('idle');
      return;
    }
    setUsedFallback(true);
    setMessage(reason ? `${reason} Basic version try kar raha hoon...` : null);
    setStatus('listening');
    browserVoice.start((transcript) => {
      resultCbRef.current?.({ transcript, numbers: [], language: null });
      setStatus('idle');
    });
  }, [browserVoice]);

  // If the browser fallback ends without ever producing a result (denied
  // permission, no network, genuine silence), surface exactly why instead
  // of just going quiet — this was the original "not working" complaint,
  // and it applies equally to the fallback path.
  useEffect(() => {
    if (status === 'listening' && !browserVoice.listening && browserVoice.errorMessage) {
      setMessage(browserVoice.errorMessage);
      setStatus('idle');
    }
  }, [status, browserVoice.listening, browserVoice.errorMessage]);

  const supported = recorder.supported || browserVoice.supported;

  const tap = useCallback((onResult: (result: SmartVoiceResult) => void) => {
    resultCbRef.current = onResult;

    if (status === 'recording') {
      // Second tap — stop recording and send the clip to Gemini.
      setStatus('processing');
      setMessage(null);
      recorder.stop().then(async (blob) => {
        if (!blob) {
          runBrowserFallback('Recording khali aayi.');
          return;
        }
        try {
          const result = await transcribeWithGemini(blob);
          if (result.numbers.length === 0 && !result.transcript.trim()) {
            runBrowserFallback('Kuch samajh nahi aaya.');
            return;
          }
          setUsedFallback(false);
          setMessage(null);
          onResult(result);
          setStatus('idle');
        } catch (err) {
          console.warn('[useSmartVoice] Gemini path failed, falling back to browser recognizer:', err);
          runBrowserFallback('Advanced voice abhi available nahi hai.');
        }
      });
      return;
    }

    if (status === 'listening') {
      browserVoice.stop();
      setStatus('idle');
      return;
    }

    if (status !== 'idle') return; // mid-processing — ignore extra taps

    setMessage(null);
    if (recorder.supported) {
      setStatus('recording');
      recorder.start().catch((err: Error) => {
        const friendly = err.message === 'not-allowed'
          ? 'Mic permission nahi mili — phone Settings me is app ko mic access do.'
          : 'Mic start nahi ho paya.';
        runBrowserFallback(friendly);
      });
    } else {
      runBrowserFallback();
    }
  }, [status, recorder, browserVoice, runBrowserFallback]);

  return { status, message, usedFallback, supported, tap };
}
