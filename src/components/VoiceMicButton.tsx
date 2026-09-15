import { Mic, Loader2, AlertCircle, Languages } from 'lucide-react';
import { useSmartVoice } from '@/lib/useSmartVoice';
import { extractFirstNumber, extractAllNumbers } from '@/lib/voiceInput';

interface VoiceMicButtonProps {
  /** 'number' extracts the first number spoken (for Quantity) and hands
   *  back a plain numeric string. 'text' hands back the raw transcript
   *  untouched (for free-text fields like Notes). */
  mode: 'number' | 'text';
  onValue: (value: string) => void;
  fieldLabel?: string;
}

function statusIcon(status: string) {
  if (status === 'recording' || status === 'listening') return <Mic className="w-4 h-4" />;
  if (status === 'processing') return <Loader2 className="w-4 h-4 animate-spin" />;
  return <Mic className="w-4 h-4" />;
}

// Renders nothing when NEITHER the Gemini path nor the browser fallback
// can possibly work on this device — so on a genuinely unsupported
// browser the field looks and behaves exactly like it always did.
export function VoiceMicButton({ mode, onValue, fieldLabel }: VoiceMicButtonProps) {
  const { status, message, usedFallback, supported, tap } = useSmartVoice();

  if (!supported) return null;

  function handleClick() {
    tap((result) => {
      if (mode === 'number') {
        const num = result.numbers[0] || extractFirstNumber(result.transcript);
        if (num) onValue(num);
      } else {
        onValue(result.transcript);
      }
    });
  }

  const active = status === 'recording' || status === 'listening';

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={handleClick}
        aria-label={fieldLabel ? `Speak ${fieldLabel}` : 'Speak to fill this field'}
        title={active ? 'Tap to stop' : 'Tap and speak'}
        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center border transition ${
          active
            ? 'bg-red-500 border-red-500 text-white animate-pulse'
            : message
            ? 'bg-amber-50 border-amber-300 text-amber-600'
            : 'bg-blue-50 border-blue-200 text-blue-600 active:bg-blue-100'
        }`}
      >
        {statusIcon(status)}
      </button>
      {message && (
        <p className="absolute top-full right-0 mt-1 w-40 text-[10px] leading-tight text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 z-10 text-left">
          {message}
        </p>
      )}
      {usedFallback && !message && (
        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-400 rounded-full border border-white" title="Basic voice mode" />
      )}
    </div>
  );
}

interface VoiceSizeButtonProps {
  /** Called with the numbers heard, in spoken order — width first, then
   *  height if a second number was caught. */
  onValues: (values: string[]) => void;
}

// One-tap-to-record, one-tap-to-stop capture for BOTH dimensions together
// ("10 by 15", "das baai pandra", or in Marathi/Gujarati/Tamil/etc. — the
// language is auto-detected, nothing to configure). Tries Gemini first
// for noise-robust, any-language transcription; falls back to the
// phone's basic recognizer automatically if that path isn't available.
// Manual typing and the unit dropdowns are completely unaffected either way.
export function VoiceSizeButton({ onValues }: VoiceSizeButtonProps) {
  const { status, message, usedFallback, supported, tap } = useSmartVoice();

  if (!supported) return null;

  function handleClick() {
    tap((result) => {
      const numbers = result.numbers.length > 0 ? result.numbers : extractAllNumbers(result.transcript);
      if (numbers.length > 0) onValues(numbers);
    });
  }

  const label =
    status === 'recording' ? 'Recording... bolo phir tap karke roko'
    : status === 'listening' ? 'Sun raha hoon...'
    : status === 'processing' ? 'Samajh raha hoon...'
    : 'Speak Size (Width × Height) — kisi bhi bhasha me';

  const active = status === 'recording' || status === 'listening';

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={status === 'processing'}
        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border transition ${
          active ? 'bg-red-500 border-red-500 text-white animate-pulse' : 'bg-blue-50 border-blue-200 text-blue-700 active:bg-blue-100'
        } disabled:opacity-70`}
      >
        {statusIcon(status)}
        {label}
      </button>
      {status === 'recording' && (
        <p className="text-[11px] text-slate-500 text-center mt-1">Bolne ke baad button dubara tap karo bhejne ke liye</p>
      )}
      {message && (
        <p className="flex items-start gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {message}
        </p>
      )}
      {usedFallback && !message && (
        <p className="flex items-center gap-1 text-[10px] text-amber-600 mt-1">
          <Languages className="w-3 h-3" /> Basic voice mode use ho raha hai (kam accurate ho sakta hai) — check karke confirm kar lo.
        </p>
      )}
    </div>
  );
}
