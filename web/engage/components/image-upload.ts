"use client";

import { isHeic } from "../template-options";

/* HEIC (an iPhone's default) is not something the server can decode. Where this
 * browser can (Safari, and others with a HEIC codec from the OS) the photo is drawn to a
 * canvas and uploaded as a JPEG; the server then resizes it like any other. */

export const HEIC_MESSAGE =
  "This browser can't read HEIC photos. Upload a JPG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).";

async function decode(file: File): Promise<{ draw: (c: CanvasRenderingContext2D) => void; w: number; h: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { draw: (c) => c.drawImage(bmp, 0, 0), w: bmp.width, h: bmp.height };
    } catch {
      // Fall through to an <img>, which some browsers decode HEIC with when bitmaps can't.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("undecodable"));
      el.src = url;
    });
    await img.decode().catch(() => undefined);
    return { draw: (c) => c.drawImage(img, 0, 0), w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    // Revoked after drawing would be safer for slow decoders, but onload has fired.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** The file to upload: a HEIC photo converted to JPEG, anything else as it is. Throws HEIC_MESSAGE. */
export async function prepareImage(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  try {
    const { draw, w, h } = await decode(file);
    if (!w || !h) throw new Error("empty");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    draw(ctx);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("no blob");
    return new File([blob], file.name.replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    throw new Error(HEIC_MESSAGE);
  }
}
