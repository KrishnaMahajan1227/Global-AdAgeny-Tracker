import { useState } from 'react';
import { Mic, Loader2, AlertCircle } from 'lucide-react';
import { useVoiceCapture, extractFirstNumber, extractAllNumbers } from '@/lib/voiceInput';

interface VoiceMicButtonProps {
  /** 'number' extracts the first number spoken (for Quantity) and hands
   *  back a plain numeric string. 'text' hands back the raw transcript
   *  untouched (for free-text fields like Notes). */
  mode: 'number' | 'text';
  onValue: (value: string) => void;
  lang?: string;
  /** Used for the accessible label only, e.g. "Quantity" → "Speak Quantity". */
  fieldLabel?: string;
}

// Renders nothing at all when the browser doesn't support speech
// recognition — so on unsupported devices the field looks and behaves
// exactly like it always did, with no broken/dead button left behind.
// When recognition IS supported but a particular attempt fails (no mic
// permission, no network, didn't catch anything, etc.), that reason is
// shown right under the button instead of just doing nothing — that
// silence was the reason "voice isn't working" was hard to diagnose.
export function VoiceMicButton({ mode, onValue, lang, fieldLabel }: VoiceMicButtonProps) {
  const { supported, listening, errorMessage, start } = useVoiceCapture({ lang });
  const [couldNotHear, setCouldNotHear] = useState(false);

  if (!supported) return null;

  function handleClick() {
    setCouldNotHear(false);
    start((transcript) => {
      if (mode === 'number') {
        const num = extractFirstNumber(transcript);
        if (num) onValue(num);
        else setCouldNotHear(true);
      } else {
        onValue(transcript);
      }
    });
  }

  const message = errorMessage || (couldNotHear ? "Number samajh nahi aaya — dubara bolo ya type kar do." : null);

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={handleClick}
        aria-label={fieldLabel ? `Speak ${fieldLabel}` : 'Speak to fill this field'}
        title="Tap and speak"
        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center border transition ${
          listening
            ? 'bg-red-500 border-red-500 text-white'
            : message
            ? 'bg-amber-50 border-amber-300 text-amber-600'
            : 'bg-blue-50 border-blue-200 text-blue-600 active:bg-blue-100'
        }`}
      >
        {listening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
      </button>
      {message && (
        <p className="absolute top-full right-0 mt-1 w-40 text-[10px] leading-tight text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 z-10 text-left">
          {message}
        </p>
      )}
    </div>
  );
}

interface VoiceSizeButtonProps {
  /** Called with the numbers heard, in spoken order — width first, then
   *  height if a second number was caught. Caller decides what to do if
   *  only one number came through (e.g. fill width, leave height for a
   *  retry or manual entry). */
  onValues: (values: string[]) => void;
  lang?: string;
}

// One-tap capture for BOTH dimensions together ("10 by 15", "das baai
// pandra", or just "10 15") — replaces having to open the mic twice, once
// per field, which is what made the per-field version feel clunky in
// practice. Falls back gracefully: if only one number is heard, the
// caller still gets it (for width) and the surveyor can retry or type the
// second. Manual typing and the unit dropdowns are completely untouched
// either way.
export function VoiceSizeButton({ onValues, lang }: VoiceSizeButtonProps) {
  const { supported, listening, errorMessage, start } = useVoiceCapture({ lang });
  const [heard, setHeard] = useState<{ transcript: string; numbers: string[] } | null>(null);

  if (!supported) return null;

  function handleClick() {
    setHeard(null);
    start((transcript) => {
      const numbers = extractAllNumbers(transcript);
      setHeard({ transcript, numbers });
      if (numbers.length > 0) onValues(numbers);
    });
  }

  const noNumbersHeard = heard && heard.numbers.length === 0;
  const onlyOneHeard = heard && heard.numbers.length === 1;

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border transition ${
          listening ? 'bg-red-500 border-red-500 text-white' : 'bg-blue-50 border-blue-200 text-blue-700 active:bg-blue-100'
        }`}
      >
        {listening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
        {listening ? 'Sun raha hoon... bolo "10 by 15"' : 'Speak Size (Width × Height)'}
      </button>

      {errorMessage && (
        <p className="flex items-start gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {errorMessage}
        </p>
      )}
      {!errorMessage && noNumbersHeard && (
        <p className="flex items-start gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> Number samajh nahi aaya ("{heard.transcript}" suna) — dubara bolo ya neeche type kar do.
        </p>
      )}
      {!errorMessage && onlyOneHeard && (
        <p className="flex items-start gap-1 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-2 py-1.5 mt-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> Sirf ek number ({heard!.numbers[0]}) mila, Width me bhar diya — Height khud type kar do ya dubara bolo "10 by 15".
        </p>
      )}
    </div>
  );
}
