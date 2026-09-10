"use client";

/* Preparing an image for chat, in the browser.
 *
 * A phone camera produces eight megapixels and four megabytes; a screenshot of a 5K
 * display is larger still. Sending either as-is means a slow upload on the sender's
 * connection and a slow download on five hundred others', for a picture that will be
 * rendered three hundred pixels wide. So it is re-encoded before it leaves.
 *
 * Compressing here rather than on the server is the whole point. The server's five
 * megabyte cap is a backstop against a client that skipped this step, not the working
 * limit — a rejection after a four-megabyte upload on hotel wifi is a minute of
 * somebody's life for an error message.
 */

/** The server's cap. Anything still above it after compression is refused locally,
 *  where the message can be immediate. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Long edge, after scaling. Generous enough that a screenshot of code is still
 *  readable when opened full size, small enough that a chat panel is not downloading
 *  wallpaper. */
const MAX_EDGE = 1600;

/** WebP at this quality is visually lossless for screenshots and roughly a third the
 *  size of the equivalent JPEG. */
const QUALITY = 0.82;

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export type PreparedImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
};

export class ImageError extends Error {}

/** Whether a paste or a drop contains something worth uploading. */
export function isSupportedImage(file: File | null | undefined): file is File {
  return !!file && ACCEPTED.includes(file.type);
}

/** Pulls an image out of a paste. Screenshots arrive as a file on the clipboard with
 *  no name, which is why the items are inspected rather than the files list alone. */
export function imageFromPaste(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (isSupportedImage(file)) return file;
  }
  return null;
}

/**
 * Scales and re-encodes an image, and refuses the ones that cannot be helped.
 *
 * WebP is attempted first and JPEG is the fallback: every browser that can run this app
 * can encode WebP, but `toBlob` returning null for an unsupported type is a silent
 * failure rather than a thrown one, so the result is checked rather than assumed.
 *
 * Transparency is the one case where re-encoding loses something a user would notice —
 * a PNG screenshot with a transparent border becomes a black one in JPEG. WebP keeps
 * the alpha channel, which is why it is the first choice rather than a size
 * optimisation.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isSupportedImage(file)) {
    throw new ImageError("Images must be PNG, JPEG or WebP.");
  }
  // Checked before decoding: a 200MB file should be refused, not loaded into memory to
  // find out how big it is.
  if (file.size > MAX_IMAGE_BYTES * 6) {
    throw new ImageError("That image is far too large. Try a screenshot instead.");
  }

  const bitmap = await decode(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageError("This browser couldn't process that image.");
    // Downscaling a screenshot with the default filter produces aliased text; high
    // quality is the difference between readable code and a smear.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);

    for (const mime of ["image/webp", "image/jpeg"]) {
      const blob = await toBlob(canvas, mime);
      if (!blob) continue;
      // Re-encoding can make a small PNG bigger. When it does, the original is smaller
      // and already an accepted type, so it wins.
      if (blob.size > file.size && scale === 1) {
        return { blob: file, mime: file.type, width, height };
      }
      if (blob.size <= MAX_IMAGE_BYTES) {
        return { blob, mime, width, height };
      }
    }
    throw new ImageError(
      `That image is still over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB after compression.`,
    );
  } finally {
    bitmap.close();
  }
}

/** createImageBitmap, with a message rather than a DOMException for a file that is not
 *  really an image whatever its type says. */
async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new ImageError("That file couldn't be read as an image.");
  }
}

function toBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, QUALITY));
}
