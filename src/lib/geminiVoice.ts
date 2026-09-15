import { supabase } from './supabase';

export interface GeminiVoiceResult {
  transcript: string;
  numbers: string[];
  language: string | null;
}

/**
 * Sends a recorded voice note to the `voice-transcribe` Supabase Edge
 * Function, which forwards it to Gemini server-side (the API key never
 * touches the browser) and gets back a transcript, the numbers spoken
 * (already extracted, in order), and the auto-detected language — this
 * handles background noise and any Indian language / code-mixing far
 * more reliably than the browser's built-in speech recognizer.
 *
 * Throws on any failure (network error, function not deployed yet, no
 * GEMINI_API_KEY configured, Gemini itself erroring) — callers should
 * catch this and fall back to the browser recognizer, which is exactly
 * what VoiceMicButton/VoiceSizeButton do, so a survey never gets stuck
 * just because this hasn't been set up on a given deployment yet.
 */
export async function transcribeWithGemini(audioBlob: Blob): Promise<GeminiVoiceResult> {
  const audioBase64 = await blobToBase64(audioBlob);
  const { data, error } = await supabase.functions.invoke('voice-transcribe', {
    body: { audioBase64, mimeType: audioBlob.type || 'audio/webm' },
  });
  if (error) throw error;
  if (!data || typeof data !== 'object') throw new Error('Empty response from voice-transcribe');
  if ('error' in data && data.error) throw new Error(String(data.error));
  return {
    transcript: typeof data.transcript === 'string' ? data.transcript : '',
    numbers: Array.isArray(data.numbers) ? data.numbers.map(String) : [],
    language: typeof data.detected_language === 'string' ? data.detected_language : null,
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the "data:audio/webm;base64," prefix — Gemini's inline_data
      // wants raw base64 only.
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
