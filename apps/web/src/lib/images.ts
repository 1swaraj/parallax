import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  sniffImageType,
  type ImageType,
} from '@lens-monad/protocol';

/** An image ready to post: re-encoded bytes, their size in pixels, and a local URL to preview them. */
export type PreparedImage = {
  bytes: Uint8Array;
  type: ImageType;
  width: number;
  height: number;
  previewUrl: string;
};

const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];
/** Each attempt at fitting MAX_IMAGE_BYTES scales the image down by this much more. */
const SHRINK = 0.8;
const MAX_ATTEMPTS = 6;

let webpSupport: boolean | null = null;

/** Safari can't encode WebP from a canvas: it gives back a PNG instead. */
function canEncodeWebp() {
  if (webpSupport === null) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpSupport;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Re-encodes a picked image for posting: at most MAX_IMAGE_DIMENSION pixels on its longest side, WebP (JPEG where
 * the browser can't encode WebP), at the best quality that fits in MAX_IMAGE_BYTES, scaling down further if none
 * does. Every byte is paid for on-chain. Re-encoding also drops the file's metadata, e.g. a photo's location, which
 * would otherwise be public for good. Animated images keep their first frame.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("This image can't be read. Try a JPEG, PNG or WebP.");
  }
  try {
    const type = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++, scale *= SHRINK) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d')!;
      if (type === 'image/jpeg') {
        // JPEG has no transparency, which would come out black.
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const blob = await toBlob(canvas, type, quality);
        if (blob && blob.size <= MAX_IMAGE_BYTES) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const encoded = sniffImageType(bytes);
          if (!encoded) {
            break;
          }
          return {
            bytes,
            type: encoded,
            width: canvas.width,
            height: canvas.height,
            previewUrl: URL.createObjectURL(blob),
          };
        }
      }
    }
    throw new Error("This image can't be made small enough to post. Try another one.");
  } finally {
    bitmap.close();
  }
}
