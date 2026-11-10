/** Escaneo de códigos de barras con la API nativa BarcodeDetector (Chrome en Android). Sin ella: ingreso manual. */
import { normalizeBarcode } from '../../../src/services/openFoodFacts/barcode';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | ImageBitmap): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

const FORMATS = ['ean_13', 'ean_8', 'upc_a'];

function detectorCtor(): BarcodeDetectorCtor | null {
  const c = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return c ?? null;
}

export function scannerSupported(): boolean {
  return detectorCtor() !== null;
}
export function cameraSupported(): boolean {
  return scannerSupported() && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function firstValid(list: readonly DetectedBarcode[]): string | null {
  for (const d of list) {
    const n = normalizeBarcode(d.rawValue);
    if (n) return n.code;
  }
  return null;
}

/** Lee un código desde una foto (input file). Devuelve el código normalizado o null si no encontró uno válido. */
export async function scanImageFile(file: File): Promise<string | null> {
  const Ctor = detectorCtor();
  if (!Ctor) throw new Error('Este navegador no puede leer códigos de barras. Escribe el número.');
  const bmp = await createImageBitmap(file);
  try {
    return firstValid(await new Ctor({ formats: FORMATS }).detect(bmp));
  } finally {
    bmp.close();
  }
}

export interface LiveScan {
  stop(): void;
}

/** Cámara en vivo sobre un <video>. Llama onCode una vez con el primer código válido y se detiene sola. */
export async function startLiveScan(video: HTMLVideoElement, onCode: (code: string) => void, onError: (msg: string) => void): Promise<LiveScan> {
  const Ctor = detectorCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) throw new Error('Cámara o lector de códigos no disponible en este navegador.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();
  const det = new Ctor({ formats: FORMATS });
  let alive = true;
  const stop = (): void => {
    alive = false;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const tick = async (): Promise<void> => {
    if (!alive) return;
    try {
      if (video.readyState >= 2) {
        const code = firstValid(await det.detect(video));
        if (code) {
          stop();
          onCode(code);
          return;
        }
      }
    } catch (e) {
      stop();
      onError(e instanceof Error ? e.message : String(e));
      return;
    }
    setTimeout(() => void tick(), 180);
  };
  void tick();
  return { stop };
}
