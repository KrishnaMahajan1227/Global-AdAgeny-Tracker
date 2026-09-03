import { useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { useVoiceCapture, extractFirstNumber } from '@/lib/voiceInput';

interface VoiceMicButtonProps {
  /** 'number' extracts the first number spoken (for Width/Height/Quantity
   *  fields) and hands back a plain numeric string. 'text' hands back the
   *  raw transcript untouched (for free-text fields like Notes). */
  mode: 'number' | 'text';
  onValue: (value: string) => void;
  lang?: string;
  /** Used for the accessible label only, e.g. "Width" → "Speak Width". */
  fieldLabel?: string;
}

// Renders nothing at all when the browser doesn't support speech
// recognition — so on unsupported devices the field looks and behaves
// exactly like it always did, with no broken/dead button left behind.
export function VoiceMicButton({ mode, onValue, lang, fieldLabel }: VoiceMicButtonProps) {
  const { supported, listening, start } = useVoiceCapture({ lang });
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

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={fieldLabel ? `Speak ${fieldLabel}` : 'Speak to fill this field'}
      title="Tap and speak"
      className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center border transition ${
        listening
          ? 'bg-red-500 border-red-500 text-white'
          : couldNotHear
          ? 'bg-amber-50 border-amber-300 text-amber-600'
          : 'bg-blue-50 border-blue-200 text-blue-600 active:bg-blue-100'
      }`}
    >
      {listening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
    </button>
  );
}
