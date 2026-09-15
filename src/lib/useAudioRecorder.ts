import { useCallback, useRef, useState } from 'react';

// Records a short voice note via the phone's mic (MediaRecorder API) so it
// can be sent to Gemini for transcription. This is deliberately a
// tap-to-start / tap-to-stop recording (not the browser's silence-based
// auto-stop) — the surveyor controls exactly how much gets sent, which
// matters when there's ongoing background noise (traffic, etc.) that a
// silence-detector would never "hear the end of".
//
// MediaRecorder + getUserMedia is supported far more broadly across
// Android/iOS browsers than SpeechRecognition, so this is the primary
// path; the old browser SpeechRecognition flow (see voiceInput.ts) is
// kept as an automatic fallback if this isn't supported or fails.

export type RecorderStatus = 'idle' | 'recording' | 'processing' | 'error';

export interface AudioRecorderHandle {
  supported: boolean;
  status: RecorderStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
}

export function useAudioRecorder(): AudioRecorderHandle {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const start = useCallback(async () => {
    if (!supported) { setError('not-supported'); setStatus('error'); throw new Error('not-supported'); }
    try {
      setError(null);
      // Noise suppression + echo cancellation + auto gain — the phone's
      // own mic pipeline already does a first pass at cleaning up
      // traffic/wind noise before Gemini even sees the audio.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setStatus('recording');
    } catch (err: any) {
      const code = err?.name === 'NotAllowedError' ? 'not-allowed' : 'mic-error';
      setError(code);
      setStatus('error');
      throw new Error(code);
    }
  }, [supported]);

  const stop = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') { setStatus('idle'); resolve(null); return; }
      setStatus('processing');
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = chunksRef.current.length > 0
          ? new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          : null;
        chunksRef.current = [];
        resolve(blob && blob.size > 0 ? blob : null);
      };
      recorder.stop();
    });
  }, []);

  return { supported, status, error, start, stop };
}
