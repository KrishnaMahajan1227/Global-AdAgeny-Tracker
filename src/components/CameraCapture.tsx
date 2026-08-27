import { useEffect, useRef, useState } from 'react';
import { Camera, X, RotateCcw, Check, Loader2 } from 'lucide-react';

// A real, live camera preview (not just a native file-picker intent).
// `input capture="environment"` sometimes opens the photo gallery instead
// of the camera depending on browser/PWA, so this opens an actual video
// stream via getUserMedia with a proper "Take Photo" shutter button, and
// only falls back to the OS picker if the camera API truly isn't available
// (e.g. desktop browser with no webcam, or permission denied).

interface CameraCaptureProps {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string, fileName: string) => void;
  title?: string;
}

export function CameraCapture({ open, onClose, onCapture, title }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<'opening' | 'live' | 'error'>('opening');
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setShot(null);
    setStatus('opening');

    let cancelled = false;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('error');
      }
    }
    start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  function takeShot() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    // Phones commonly report the raw camera stream in landscape pixel
    // dimensions (videoWidth > videoHeight) even while the video element
    // is visibly being displayed upright in portrait on screen — capturing
    // straight off those raw dimensions saves a sideways photo. When the
    // displayed size (clientWidth/clientHeight, which follows real CSS
    // layout) disagrees with the raw stream's orientation, rotate 90°
    // while drawing so the saved photo actually comes out portrait,
    // matching what was seen live in the viewfinder.
    const streamIsLandscape = video.videoWidth > video.videoHeight;
    const displayIsPortrait = video.clientHeight >= video.clientWidth;
    if (streamIsLandscape && displayIsPortrait) {
      canvas.width = video.videoHeight;
      canvas.height = video.videoWidth;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
    } else {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    setShot(canvas.toDataURL('image/jpeg', 0.85));
  }

  function confirm() {
    if (!shot) return;
    onCapture(shot, `photo-${Date.now()}.jpg`);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onClose();
  }

  function retake() {
    setShot(null);
  }

  function fallbackToNativePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onCapture(reader.result as string, file.name);
      reader.readAsDataURL(file);
      onClose();
    };
    input.click();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="font-medium text-sm">{title || 'Take Photo'}</span>
        <button onClick={() => { streamRef.current?.getTracks().forEach((t) => t.stop()); onClose(); }} className="p-1.5">
          <X className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
        {status === 'opening' && (
          <div className="text-white flex flex-col items-center gap-2">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-sm">Opening camera…</p>
          </div>
        )}

        {status === 'error' && (
          <div className="text-white flex flex-col items-center gap-3 px-6 text-center">
            <Camera className="w-10 h-10 text-slate-400" />
            <p className="text-sm text-slate-300">Couldn't access the camera directly (permission denied or unavailable).</p>
            <button onClick={fallbackToNativePicker} className="bg-blue-600 text-white font-medium px-4 py-2.5 rounded-lg text-sm">
              Open Camera App Instead
            </button>
          </div>
        )}

        {!shot && (
          <video ref={videoRef} playsInline muted className={`w-full h-full object-cover ${status === 'live' ? 'block' : 'hidden'}`} />
        )}
        {shot && <img src={shot} alt="Captured" className="w-full h-full object-contain" />}
      </div>

      <div className="p-6 flex items-center justify-center gap-8 bg-black">
        {!shot ? (
          status === 'live' && (
            <button
              onClick={takeShot}
              className="w-16 h-16 rounded-full bg-white border-4 border-slate-300 active:scale-95 transition flex items-center justify-center"
              aria-label="Take photo"
            />
          )
        ) : (
          <>
            <button onClick={retake} className="flex flex-col items-center gap-1 text-white">
              <div className="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center">
                <RotateCcw className="w-5 h-5" />
              </div>
              <span className="text-xs">Retake</span>
            </button>
            <button onClick={confirm} className="flex flex-col items-center gap-1 text-white">
              <div className="w-14 h-14 rounded-full bg-green-600 flex items-center justify-center">
                <Check className="w-6 h-6" />
              </div>
              <span className="text-xs">Use Photo</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
