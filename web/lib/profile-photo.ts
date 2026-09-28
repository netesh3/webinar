/* Preparing a profile photo before upload.
 *
 * Same idea as a webinar cover (lib/webinar-image.ts): the original can be a
 * multi-megabyte camera photo, and what we store is a small square. The server
 * still sniffs the bytes and refuses anything that is not JPEG, PNG or WebP,
 * and anything over 2MB.
 */

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const TARGET = 512;
const MAX_BYTES = 512 * 1024;
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45];

export type PreparedProfilePhoto = {
  blob: Blob;
  mime: string;
};

export class ProfilePhotoError extends Error {}

export function isSupportedProfilePhoto(file: File | null | undefined): file is File {
  return !!file && ACCEPTED.includes(file.type);
}

/** Center-crops to a square, scales to 512px, and re-encodes under 512KB. */
export async function prepareProfilePhoto(file: File): Promise<PreparedProfilePhoto> {
  if (!isSupportedProfilePhoto(file)) {
    throw new ProfilePhotoError("Images must be PNG, JPEG or WebP.");
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    throw new ProfilePhotoError("That image is far too large. Try a smaller photo.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ProfilePhotoError("That file couldn't be read as an image.");
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = Math.round((bitmap.width - side) / 2);
    const sy = Math.round((bitmap.height - side) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = TARGET;
    canvas.height = TARGET;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new ProfilePhotoError("This browser couldn't process that image.");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET, TARGET);

    for (const quality of QUALITY_STEPS) {
      for (const mime of ["image/webp", "image/jpeg"]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, mime, quality),
        );
        if (blob && blob.size <= MAX_BYTES) {
          return { blob, mime };
        }
      }
    }
    throw new ProfilePhotoError("That image is still too large. Try a simpler photo.");
  } finally {
    bitmap.close();
  }
}
