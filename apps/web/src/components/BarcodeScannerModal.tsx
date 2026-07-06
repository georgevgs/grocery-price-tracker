import { useEffect, useRef, useState } from 'react';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onDetected: (ean: string) => void;
  onClose: () => void;
}

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
}

const SCAN_INTERVAL_MS = 300;
const EAN_FORMATS = ['ean_13', 'ean_8'];

/**
 * Camera-based EAN scanner. Uses the native BarcodeDetector API where
 * available (Chromium, Android); falls back to @zxing/browser elsewhere
 * (iOS Safari has no BarcodeDetector).
 */
export const BarcodeScannerModal = ({ isOpen, onDetected, onClose }: BarcodeScannerModalProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    if (false === isOpen) {
      return;
    }

    const controller = new AbortController();

    startScanning(videoRef.current, controller.signal, onDetected, setScanError);

    return () => {
      controller.abort();
    };
  }, [isOpen, onDetected]);

  if (false === isOpen) {
    return null;
  }

  let errorMessage = null;

  if (null !== scanError) {
    errorMessage = <p className="mt-2 text-sm text-danger">{scanError}</p>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border-2 border-ink bg-paper p-4 shadow-hard">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-xs font-bold tracking-wide">ΣΑΡΩΣΗ BARCODE</h2>
          <button
            type="button"
            className="rounded-full border-2 border-ink px-2.5 py-1 font-mono text-[11px] font-bold tracking-wide hover:bg-accent"
            onClick={onClose}
          >
            ΚΛΕΙΣΙΜΟ
          </button>
        </div>
        <video
          ref={videoRef}
          className="mt-3 aspect-[4/3] w-full rounded-xl border-2 border-ink bg-black object-cover"
          muted
          playsInline
        />
        {errorMessage}
        <p className="mt-2 font-mono text-[11px] text-muted">
          Στόχευσε την κάμερα στο barcode (EAN) της συσκευασίας.
        </p>
      </div>
    </div>
  );
};

const startScanning = async (
  video: HTMLVideoElement | null,
  signal: AbortSignal,
  onDetected: (ean: string) => void,
  onError: (message: string) => void,
): Promise<void> => {
  if (null === video) {
    return;
  }

  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
  } catch {
    onError('Η πρόσβαση στην κάμερα απορρίφθηκε ή δεν είναι διαθέσιμη.');
    return;
  }

  if (true === signal.aborted) {
    stopStream(stream);
    return;
  }

  video.srcObject = stream;
  await video.play();

  signal.addEventListener('abort', () => {
    stopStream(stream);
  });

  const nativeDetector = createNativeDetector();

  if (null !== nativeDetector) {
    scanWithNativeDetector(video, nativeDetector, signal, onDetected);
    return;
  }

  scanWithZxing(video, signal, onDetected, onError);
};

const createNativeDetector = (): BarcodeDetectorLike | null => {
  const detectorConstructor = (
    globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;

  if (undefined === detectorConstructor) {
    return null;
  }

  return new detectorConstructor({ formats: EAN_FORMATS });
};

const scanWithNativeDetector = (
  video: HTMLVideoElement,
  detector: BarcodeDetectorLike,
  signal: AbortSignal,
  onDetected: (ean: string) => void,
): void => {
  const tick = async () => {
    if (true === signal.aborted) {
      return;
    }

    try {
      const barcodes = await detector.detect(video);
      const first = barcodes[0];

      if (undefined !== first && 0 < first.rawValue.length) {
        onDetected(first.rawValue);
        return;
      }
    } catch {
      // Frame not ready yet — keep polling.
    }

    setTimeout(tick, SCAN_INTERVAL_MS);
  };

  setTimeout(tick, SCAN_INTERVAL_MS);
};

const scanWithZxing = async (
  video: HTMLVideoElement,
  signal: AbortSignal,
  onDetected: (ean: string) => void,
  onError: (message: string) => void,
): Promise<void> => {
  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const reader = new BrowserMultiFormatReader();

    const controls = await reader.decodeFromVideoElement(video, (result) => {
      if (undefined !== result) {
        onDetected(result.getText());
        controls.stop();
      }
    });

    signal.addEventListener('abort', () => {
      controls.stop();
    });
  } catch {
    onError('Η σάρωση barcode δεν υποστηρίζεται σε αυτόν τον browser.');
  }
};

const stopStream = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
};
