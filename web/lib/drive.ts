"use client";

/* Picking a video out of Google Drive.
 *
 * Two Google scripts, both loaded ON DEMAND — when the host chooses the Drive
 * source, not when the room loads. A presenter who never touches this pays
 * nothing, and the room page makes no third-party request at all in the common
 * case. That matters more here than in most places: this page is a live video
 * session, and a blocking script from another origin is a stall the audience sees.
 *
 * The flow Google requires, and why it is in this order:
 *
 *   1. Identity Services hands out an access token for drive.readonly. Scoped to
 *      reading, because that is all this does; asking for more would be asking the
 *      host to grant a webinar app write access to their Drive.
 *   2. The Picker renders Google's own file browser. Deliberately Google's rather
 *      than a list we fetch: it means we never enumerate the host's Drive, and the
 *      only file we learn about is the one they chose.
 *   3. The chosen file is downloaded with that token, because a Drive URL cannot
 *      be handed to a <video> element — the request needs an Authorization header
 *      and a media element cannot send one.
 *
 * Step 3 is the honest weak point: the file arrives as a Blob, so it is held in
 * memory in full. A recorded webinar can be hundreds of megabytes, hence the cap
 * below. Streaming it properly means proxying through our API with range support,
 * which is the upgrade path and is written up in ARCHITECTURE.md.
 */

/** The one scope this needs. Read-only, and only files the user picks. */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/* How large a Drive file may be.
 *
 * A limit of the Blob approach rather than a policy: 1.5 GB of video in a tab
 * that is also encoding and publishing it is where Chrome starts refusing
 * allocations. A local file has no such limit — it is not copied anywhere — which
 * is why the picker says so. */
export const DRIVE_MAX_BYTES = 1_500_000_000;

// ------------------------------------------------------------ script loading

const loaded = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = loaded.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Dropped from the cache so a retry is possible: the usual cause is an
      // extension or a corporate proxy blocking Google, and the host may well fix
      // it and try again.
      loaded.delete(src);
      reject(new Error("Couldn't reach Google. Check the network and try again."));
    };
    document.head.appendChild(el);
  });
  loaded.set(src, promise);
  return promise;
}

// --------------------------------------------------------------------- types

/* Narrow declarations for the two globals, rather than pulling in @types/gapi.
 *
 * Only the handful of members used below, so a mistake here is a compile error
 * instead of an `any` that silently accepts anything. */

type TokenResponse = { access_token?: string; error?: string };

type TokenClient = { requestAccessToken: (overrides?: { prompt?: string }) => void };

type PickerDoc = { id: string; name?: string; sizeBytes?: string; mimeType?: string };

type PickerResponse = { action: string; docs?: PickerDoc[] };

type PickerBuilder = {
  addView: (view: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setCallback: (cb: (r: PickerResponse) => void) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

type GoogleGlobal = {
  accounts?: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
      }) => TokenClient;
    };
  };
  picker?: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => {
      setIncludeFolders: (v: boolean) => unknown;
      setSelectFolderEnabled: (v: boolean) => unknown;
      setMimeTypes: (types: string) => unknown;
    };
    ViewId: { DOCS_VIDEOS: unknown };
    Action: { PICKED: string };
  };
};

type GapiGlobal = { load: (name: string, cb: () => void) => void };

function google(): GoogleGlobal | undefined {
  return (window as unknown as { google?: GoogleGlobal }).google;
}

function gapi(): GapiGlobal | undefined {
  return (window as unknown as { gapi?: GapiGlobal }).gapi;
}

// ---------------------------------------------------------------------- flow

export type DriveConfig = { clientId: string; apiKey: string };

export type DrivePick = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
};

/** Asks Google for a read-only token. Resolves null if the host declines, which
 *  is a normal outcome and not an error to report as one. */
async function accessToken(clientId: string): Promise<string | null> {
  await loadScript("https://accounts.google.com/gsi/client");
  const accounts = google()?.accounts;
  if (!accounts) throw new Error("Google sign-in didn't load.");

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const client = accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (response) => {
        if (settled) return;
        settled = true;
        if (response.error) {
          // access_denied is the host closing the consent window. Everything else
          // is a real failure worth surfacing.
          if (response.error === "access_denied") resolve(null);
          else reject(new Error(`Google sign-in failed: ${response.error}`));
          return;
        }
        resolve(response.access_token ?? null);
      },
    });
    // A popup with no response at all — blocked, or closed before the callback —
    // must not leave the picker spinning forever.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 120_000);
    try {
      client.requestAccessToken();
    } catch (err) {
      settled = true;
      reject(err instanceof Error ? err : new Error("Google sign-in failed."));
    }
  });
}

/** Opens Google's own file browser, filtered to videos. Resolves null if the host
 *  closes it without choosing. */
async function pick(config: DriveConfig, token: string): Promise<DrivePick | null> {
  await loadScript("https://apis.google.com/js/api.js");
  const g = gapi();
  if (!g) throw new Error("The Google Picker didn't load.");

  await new Promise<void>((resolve) => g.load("picker", resolve));
  const picker = google()?.picker;
  if (!picker) throw new Error("The Google Picker didn't load.");

  return new Promise<DrivePick | null>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS_VIDEOS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(false);

    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setTitle("Choose a video to share")
      .setCallback((response) => {
        if (response.action !== picker.Action.PICKED) {
          // CANCEL, or the dialog being dismissed. Not an error.
          if (response.action === "cancel") resolve(null);
          return;
        }
        const doc = response.docs?.[0];
        if (!doc) {
          resolve(null);
          return;
        }
        resolve({
          id: doc.id,
          name: doc.name ?? "Drive video",
          size: Number(doc.sizeBytes ?? 0),
          mimeType: doc.mimeType ?? "video/mp4",
        });
      })
      .build()
      .setVisible(true);
  });
}

/** Downloads the picked file, reporting progress. Streamed into chunks rather
 *  than awaited as one blob so the progress bar is real — a host waiting on 800MB
 *  with no feedback assumes it has hung. */
async function download(
  file: DrivePick,
  token: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "Google refused that download. The file may be restricted by its owner."
        : `Couldn't download from Drive (${res.status}).`,
    );
  }

  const total = Number(res.headers.get("content-length") ?? file.size ?? 0);
  const body = res.body;
  if (!body) return res.blob();

  const reader = body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as unknown as BlobPart);
      received += value.byteLength;
      if (total > 0) onProgress(Math.min(1, received / total));
    }
  }
  onProgress(1);
  return new Blob(chunks, { type: file.mimeType });
}

/**
 * The whole flow: consent, pick, download.
 *
 * Returns null when the host backs out at any step, so a cancel is not reported
 * as a failure. The object URL is the caller's to release.
 */
export async function pickFromDrive(
  config: DriveConfig,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<{ name: string; url: string; size: number } | null> {
  const token = await accessToken(config.clientId);
  if (!token) return null;

  const file = await pick(config, token);
  if (!file) return null;

  if (file.size > DRIVE_MAX_BYTES) {
    throw new Error(
      `That file is ${Math.round(file.size / 1e9)} GB. Drive files have to be copied into this tab first, so ` +
        `anything over ${Math.round(DRIVE_MAX_BYTES / 1e9)} GB has to come from your disk instead.`,
    );
  }

  const blob = await download(file, token, onProgress, signal);
  return { name: file.name, url: URL.createObjectURL(blob), size: blob.size };
}

/** Whether the Drive source can be offered at all. */
export function driveConfigured(config: Partial<DriveConfig>): config is DriveConfig {
  return !!config.clientId && !!config.apiKey;
}
