"use client";

/* Preparing a webinar's cover image, in the browser.
 *
 * The host picks whatever their camera roll or screenshot folder happens to hold —
 * a 5MB, 12-megapixel phone photo is a completely normal choice for a "cover image"
 * field. Uploading that as-is would be slow for the host and, worse, slow for every
 * visitor of a registration or browse page that renders it at a few hundred pixels
 * wide. So it is cropped and re-encoded here, before it ever leaves the browser —
 * the point is not to protect the upload, it is to protect the thousand downloads
 * that follow it.
 *
 * The server's cap (see maxWebinarImageBytes in api/internal/api/host.go) is a
 * backstop against a client that skipped this step, not the working limit — a
 * rejection after a five-megabyte upload on hotel wifi is a minute of somebody's
 * life for an error message that should never fire.
 */

/** What the form actually stores. Anything still above this after every trick
 *  below has been tried is refused locally, where the message can be immediate. */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/** The cover renders at a few hundred pixels wide at most, on the browse page and
 *  the registration panel. 1280×720 is generous headroom above that and matches
 *  the "recommended" size printed under the picker, so an image that already fits
 *  is not needlessly re-encoded smaller than what was asked for. */
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const ASPECT = TARGET_WIDTH / TARGET_HEIGHT; // 16:9

/** Quality steps tried at the target size before the image is shrunk further.
 *  Coarser than chat's single fixed quality, because a cover image has more
 *  headroom to spend — it is uploaded once and downloaded by everyone who visits
 *  the registration page, not read once in a chat panel. */
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

/** Scale steps tried once every quality step has failed at the current size.
 *  Each is still 16:9, just smaller — a visibly smaller cover beats an upload
 *  that never completes. */
const SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4];

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export type PreparedWebinarImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
};

export class WebinarImageError extends Error {}

export function isSupportedWebinarImage(
  file: File | null | undefined,
): file is File {
  return !!file && ACCEPTED.includes(file.type);
}

/**
 * Center-crops to 16:9, scales to fit within 1280×720, and re-encodes until the
 * result is at or under MAX_IMAGE_BYTES — trying every quality step at the target
 * size first, then falling back to smaller sizes.
 *
 * The crop is always centered. A host who wants control over which part of a wide
 * photo survives can crop it themselves before choosing it; the automatic centre
 * crop is what "or automatically crop it" in the brief asks for, and it is right
 * far more often than it is wrong — a face or a logo is rarely in a photo's corner.
 */
export async function prepareWebinarImage(
  file: File,
): Promise<PreparedWebinarImage> {
  if (!isSupportedWebinarImage(file)) {
    throw new WebinarImageError("Images must be PNG, JPEG or WebP.");
  }
  // Refused before decoding: a 200MB file should not be loaded into memory just to
  // find out it is too large. Generous relative to MAX_IMAGE_BYTES because the
  // whole point of this module is that the ORIGINAL is allowed to be much bigger
  // than the final, optimized image.
  if (file.size > MAX_IMAGE_BYTES * 40) {
    throw new WebinarImageError(
      "That image is far too large. Try a smaller photo or a screenshot.",
    );
  }

  const bitmap = await decode(file);
  try {
    const crop = centerCrop169(bitmap.width, bitmap.height);

    for (const scale of SCALE_STEPS) {
      const width = Math.max(1, Math.round(Math.min(TARGET_WIDTH, crop.width) * scale));
      const height = Math.max(1, Math.round(width / ASPECT));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new WebinarImageError("This browser couldn't process that image.");
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        bitmap,
        crop.x, crop.y, crop.width, crop.height,
        0, 0, width, height,
      );

      for (const quality of QUALITY_STEPS) {
        for (const mime of ["image/webp", "image/jpeg"]) {
          const blob = await toBlob(canvas, mime, quality);
          if (!blob) continue;
          if (blob.size <= MAX_IMAGE_BYTES) {
            return { blob, mime, width, height };
          }
        }
      }
    }

    throw new WebinarImageError(
      `That image is still over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB even at the smallest size this form will send. Try a simpler image.`,
    );
  } finally {
    bitmap.close();
  }
}

/** The centered 16:9 rectangle within a `w`×`h` source, in source pixels.
 *
 *  A source already wider than 16:9 loses width off both sides; a taller one loses
 *  height off top and bottom. A source already exactly 16:9 gets the whole image. */
function centerCrop169(w: number, h: number): { x: number; y: number; width: number; height: number } {
  const sourceAspect = w / h;
  if (sourceAspect > ASPECT) {
    const width = Math.round(h * ASPECT);
    return { x: Math.round((w - width) / 2), y: 0, width, height: h };
  }
  const height = Math.round(w / ASPECT);
  return { x: 0, y: Math.round((h - height) / 2), width: w, height };
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new WebinarImageError("That file couldn't be read as an image.");
  }
}

function toBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}
