"use client";

import { Track, type LocalVideoTrack } from "livekit-client";
import { useLocalParticipant } from "@livekit/components-react";
import { useEffect, type ReactNode } from "react";
import {
  retryBackground,
  useBackgroundsSupported,
  useBackgroundStatus,
  useVirtualBackground,
  VIRTUAL_BACKGROUNDS,
  type BackgroundChoice,
} from "@/lib/backgrounds";
import { Alert, Spinner } from "../controls";
import { CheckIcon, NoneIcon } from "../icons";
import { useToast } from "../providers";
import { Button } from "../ui";
import { useRoomUI } from "./context";

/* Choosing a background, and applying it.
 *
 * Separate jobs that live together because they share the choice:
 *
 *   VirtualBackground   applies the stored choice to whatever camera track is
 *                       currently published. Mounted for the whole session, renders
 *                       nothing, and re-applies when the track is replaced — stopping
 *                       and starting the camera republishes it, and without this the
 *                       background would come off along with it.
 *   BackgroundPicker    the room's settings section.
 *   BackgroundTiles     None, Blur, and a row of stills: the grid itself, shared with the
 *                       pre-join screen. It used to have a copy there, and the two had
 *                       drifted apart in size, in what "off" looked like and in whether they
 *                       said anything while a background was loading.
 *
 * The picker writes to the same persisted preference the applier reads, so there is
 * one source of truth and no message to pass between them.
 */

/** The camera track this participant is publishing, if any. */
function useCameraTrack(): LocalVideoTrack | undefined {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track as LocalVideoTrack | undefined;
}

/** Applies the stored background. Renders nothing. */
export function VirtualBackground() {
  const { prefs, updatePrefs } = useRoomUI();
  const { notify } = useToast();
  const track = useCameraTrack();

  const { error } = useVirtualBackground(track, prefs.background, prefs.lowLight, () => {
    /* The device cannot keep up. Turned off rather than left stuttering: the person
     * whose laptop is struggling cannot see the stutter, and the audience can.
     *
     * The background goes first and alone, because it is what costs — segmentation is
     * the inference, the lift is four instructions on a pixel already in a register. A
     * machine that cannot sustain both can usually sustain the lift, so taking it away
     * too would be removing the cheap thing to fix the expensive one. Only when there
     * was no background to drop does the lift go instead. */
    if (prefs.background.mode !== "none") {
      updatePrefs({ background: { mode: "none" } });
      notify(
        "Your device can't keep up with the virtual background, so it's been turned off.",
        "info",
      );
      return;
    }
    updatePrefs({ lowLight: 0 });
    notify(
      "Your device can't keep up with the low-light adjustment, so it's been turned off.",
      "info",
    );
  });

  /* The same failure the pre-join screen shows, said out loud in the room.
   *
   * There is no panel to put a sentence in here, and the consequence is the one the
   * pre-join screen has with an audience added: the background has given up and the
   * audience is seeing the camera as it is, so without this the presenter's video would
   * change for no stated reason in the middle of a webinar. Once per distinct message —
   * `notify` is memoised, so this cannot become a toast storm. The settings window says it
   * again with a button to try again; see BackgroundTiles.
   */
  useEffect(() => {
    if (error) notify(error, "error");
  }, [error, notify]);

  return null;
}

export function BackgroundPicker() {
  const { prefs, updatePrefs, permissions } = useRoomUI();
  const { isCameraEnabled } = useLocalParticipant();
  const supported = useBackgroundsSupported();

  if (!permissions.canShareCamera) return null;

  if (!supported) {
    return (
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Background
        </h3>
        <Alert tone="warn">
          This browser can&apos;t run virtual backgrounds. They need WebGL2 — Chrome,
          Edge, Firefox or Safari 17 and later.
        </Alert>
      </section>
    );
  }

  return (
    <section className="sm:max-w-[22rem]">
      <BackgroundTiles
        heading="Background"
        choice={prefs.background}
        onSelect={(next) => updatePrefs({ background: next })}
      >
        {/* Applied to the camera, so it is only visible while the camera is on. Said rather
            than left as a grid that seems to do nothing. The choice is not lost meanwhile:
            the camera comes on with it — see openCamera. */}
        {!isCameraEnabled && (
          <p className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
            Start your camera to see the change. Your choice is saved either way.
          </p>
        )}
      </BackgroundTiles>

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
        Segmentation runs on your own device — the video is never sent anywhere to
        be processed. On a slower machine it will turn itself off rather than
        publish a stuttering picture.
      </p>
    </section>
  );
}

/**
 * The choice itself: None, Blur, and the stills, with what is happening to it.
 *
 * Three things a presenter needs from this and did not reliably get:
 *
 * Which one is on. A ring and a tick in the corner, with the picture left alone — the
 * selected still used to be washed over in the brand colour, which made the one
 * background somebody had chosen the one they could not see properly.
 *
 * That a click was received. The model takes a moment to arrive the first time, and a
 * still takes one to decode; until then the preview is blurred rather than showing the
 * room, and "Applying…" and the spinning tick say why.
 *
 * What to do when it failed. A sentence they can act on and a button to try again — the
 * raw error went to the console, where it is useful, and used to go here as well, where
 * it pushed the page sideways.
 */
export function BackgroundTiles({
  heading,
  choice,
  onSelect,
  disabledReason,
  children,
}: {
  heading: string;
  choice: BackgroundChoice;
  onSelect: (next: BackgroundChoice) => void;
  /** Why the tiles cannot be used just now, e.g. the camera is off. Unset when they can. */
  disabledReason?: string;
  /** Anything to say between the heading and the tiles. */
  children?: ReactNode;
}) {
  const status = useBackgroundStatus();
  const disabled = disabledReason !== undefined;
  // Only for a background. The lift on its own is ready within a frame or two, and a
  // spinner on "None" would read as the absence of a background still loading.
  const applying = !disabled && choice.mode !== "none" && status.phase === "preparing";
  /* Only what a retry could fix. A browser that cannot run this at all is said where the
   * control is — in place of the tiles, and on the low-light control — and a Retry button
   * next to it would be a promise the button cannot keep. */
  const failure =
    !disabled && status.phase === "failed" && status.retryable ? status.error : null;

  const isActive = (next: BackgroundChoice) =>
    choice.mode === next.mode &&
    ("id" in choice ? "id" in next && choice.id === next.id : true);

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex min-h-4 items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          {heading}
        </h3>
        {/* The camera being off explains everything else, so it wins. */}
        {disabled ? (
          <span className="text-[11px] text-ink-3">{disabledReason}</span>
        ) : applying ? (
          <span role="status" className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Spinner className="size-3" />
            Applying…
          </span>
        ) : null}
      </div>

      {children}

      <div className={`grid grid-cols-4 gap-2 ${disabled ? "opacity-50" : ""}`}>
        <Tile
          label="None"
          active={isActive({ mode: "none" })}
          disabled={disabled}
          onClick={() => onSelect({ mode: "none" })}
        >
          <span className="flex size-full flex-col items-center justify-center gap-0.5 bg-surface-2 text-ink-2">
            <NoneIcon className="size-4" />
            <span className="text-[10.5px] font-medium">None</span>
          </span>
        </Tile>

        <Tile
          label="Blur"
          active={isActive({ mode: "blur" })}
          busy={applying}
          disabled={disabled}
          onClick={() => onSelect({ mode: "blur" })}
        >
          {/* A real room, really blurred, rather than a grey box with a dot: the tile shows
              what the option does. Scaled up so the blur does not fade out at the edges. */}
          <span className="relative block size-full overflow-hidden bg-stage-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/backgrounds/library.jpg"
              alt=""
              decoding="async"
              draggable={false}
              className="size-full scale-125 object-cover blur-[3px]"
            />
            <span className="absolute inset-0 grid place-items-center bg-black/25 text-[10.5px] font-semibold text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">
              Blur
            </span>
          </span>
        </Tile>

        {VIRTUAL_BACKGROUNDS.map((bg) => (
          <Tile
            key={bg.id}
            label={bg.label}
            active={isActive({ mode: "image", id: bg.id })}
            busy={applying}
            disabled={disabled}
            onClick={() => onSelect({ mode: "image", id: bg.id })}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={bg.src}
              alt=""
              decoding="async"
              draggable={false}
              className="size-full object-cover"
            />
          </Tile>
        ))}
      </div>

      {failure && (
        <div
          role="alert"
          className="mt-2 flex items-center gap-3 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed break-words text-ink-2">
            {failure}
          </p>
          <Button variant="secondary" size="sm" onClick={retryBackground} className="shrink-0">
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  active,
  busy = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  /** Chosen and still on its way. Only meaningful on the active tile. */
  busy?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      /* An outline rather than a border: it sits outside the picture, so the chosen tile is
         not the one that shrinks, and its offset gap is whatever is behind the grid — the
         pre-join page and the settings window are different colours. */
      className={`relative aspect-video min-w-0 cursor-pointer overflow-hidden rounded-md outline-2 outline-offset-2 transition-[outline-color] focus-visible:ring-2 focus-visible:ring-brand/50 disabled:cursor-default ${
        active ? "outline-brand" : "outline-transparent hover:outline-line-2"
      }`}
    >
      {children}
      {/* A hairline over the picture, so a pale still does not dissolve into a white page. */}
      <span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-black/10 ring-inset" />
      {active && (
        <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-brand text-white shadow-sm">
          {busy ? <Spinner className="size-2.5" /> : <CheckIcon className="size-2.5" />}
        </span>
      )}
    </button>
  );
}
