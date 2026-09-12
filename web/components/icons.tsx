import type { SVGProps } from "react";

/* One stroked icon set for the whole app.
 *
 * Drawn on a 24-unit grid with a 1.75 stroke so every glyph shares an optical
 * weight, and sized with `size-*` from the call site. Inline SVG rather than an
 * icon font or a dependency: these are a few hundred bytes, they inherit
 * currentColor, and they cannot arrive late and reflow a control bar mid-session.
 *
 * Every icon is aria-hidden. They are always paired with a label or an
 * aria-label on the control that owns them, so a screen reader hears the action
 * rather than "image".
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The mic capsule alone, shared with control-bar.tsx's MicLevelIcon — which
 *  clips a rising green fill to this exact outline, so the two can never draw
 *  two slightly different capsules. */
export const MIC_CAPSULE_PATH = "M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z";

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={MIC_CAPSULE_PATH} />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
    </Icon>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6.2A3 3 0 0 1 15 7v4M15 15.4A3 3 0 0 1 9 14v-3" />
      <path d="M6 11a6 6 0 0 0 9.3 5M18 11v1M12 17v3" />
      <path d="m4 3 16 18" />
    </Icon>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2.5" />
      <path d="m15.5 11.5 6-3.5v8l-6-3.5z" />
    </Icon>
  );
}

export function CameraOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 6.5H13a2.5 2.5 0 0 1 2.5 2.5v1.2M15.5 14.2V15a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 15V9a2.5 2.5 0 0 1 2-2.45" />
      <path d="m15.5 11.5 6-3.5v8l-3.2-1.9" />
      <path d="m4 3 16 18" />
    </Icon>
  );
}

export function ScreenShareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4.5" width="19" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
      <path d="M12 13V8m0 0-2.2 2.2M12 8l2.2 2.2" />
    </Icon>
  );
}

export function ScreenShareOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.5h12.5a2 2 0 0 1 2 2V15M18 16.5H4.5a2 2 0 0 1-2-2v-8" />
      <path d="M9 20h6M12 16.5V20" />
      <path d="m3 3 18 18" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.2A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z" />
      <path d="M9 10.5h8M9 14h5" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 11a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z" />
      <path d="M3 19.5a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.2a3.25 3.25 0 0 1 0 6.1M18 14.2a6.5 6.5 0 0 1 3 5.3" />
    </Icon>
  );
}

/* One person and a plus: inviting somebody, as distinct from looking at who is here.
 *
 * Deliberately not UsersIcon with a badge. Invite sits next to Participants on the bar, and two
 * buttons whose glyphs are both "a crowd" are two buttons nobody can tell apart at 20px. */
export function UserPlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M3.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M18.5 8.5v5M16 11h5" />
    </Icon>
  );
}

export function HandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6a1.5 1.5 0 0 1 3 0v6.5a8 8 0 0 1-8 8 6 6 0 0 1-6-6V11a1.5 1.5 0 0 1 3 0v1.5" />
    </Icon>
  );
}

export function SmileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.2 4.2 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.25} />
    </Icon>
  );
}

export function QuestionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3A2.5 2.5 0 0 1 14.5 10c0 1.7-2.5 2-2.5 3.6" />
      <path d="M12 17h.01" strokeWidth={2.25} />
    </Icon>
  );
}

/** Gear / cog — device and account settings. Replaces the old sun-with-rays
 *  glyph, which at control-bar size read as brightness, not settings. */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** Distinct from SettingsIcon on purpose: one opens the host's live controls, the
 *  other opens this person's own device settings, and the two must not look alike
 *  in a control bar operated under time pressure. */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </Icon>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.5}>
      <path d="M6 12h.01M12 12h.01M18 12h.01" />
    </Icon>
  );
}

export function LeaveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 4.5h2.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H15" />
      <path d="M10 8.5 6.5 12l3.5 3.5M6.5 12H15" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.25}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.5h6l-.8 6.2 3.3 3.3H6.5l3.3-3.3L9 3.5Z" />
      <path d="M12 13v7.5" />
    </Icon>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function SpeakerViewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="12" height="15" rx="1.5" />
      <rect x="17.5" y="4.5" width="3" height="4.5" rx="1" />
      <rect x="17.5" y="10.5" width="3" height="4.5" rx="1" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.2 7.3C4.2 8.7 2.8 10.6 2 12c1.6 2.9 5.2 6 10 6 1.4 0 2.7-.26 3.9-.72" />
      <path d="M9.9 5.3A9.9 9.9 0 0 1 12 6c4.8 0 8.4 3.1 10 6-.5.9-1.2 1.9-2.1 2.8" />
      <path d="M10.2 10.2a2.5 2.5 0 0 0 3.5 3.5" />
      <path d="m3.5 3 17 18" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12c1.6-2.9 5.2-6 10-6s8.4 3.1 10 6c-1.6 2.9-5.2 6-10 6s-8.4-3.1-10-6Z" />
      <circle cx="12" cy="12" r="2.75" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.6 20 4l-7.6 16-2-6.4L4 11.6Z" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M15 6V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H6" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/* Three bars of different heights: a tally. */
export function PollIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 20v-6M12 20V5M18 20v-9" />
    </Icon>
  );
}

/* A page-a-day calendar: frame, two hanger tabs, one ruled line under the header. */
export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
      <path d="M3.5 9.5h17M8 3v3M16 3v3" />
    </Icon>
  );
}

/* A picture: frame, horizon, sun. */
export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="8.75" cy="9.75" r="1.5" />
      <path d="m4 17 4.5-4.5 3.5 3.5 3-3 5 4.5" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M5 12h14" />
    </Icon>
  );
}

/* Four arrows pushing outward: fill the window, cropping the edges. */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" />
    </Icon>
  );
}

/* Four arrows pulling inward: fit the whole thing in, letterboxed. */
export function FitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 9V4.5H9M19.5 9V4.5H15M4.5 15v4.5H9M19.5 15v4.5H15" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
    </Icon>
  );
}

/* Square with an arrow out — undock a panel into a floating window. */
export function PopOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="8" width="10" height="12" rx="1.5" />
      <path d="M14 4h6v6M20 4l-7 7" />
    </Icon>
  );
}

/* Arrow into a side rail — dock a floating window back into the side panel. */
export function DockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="14" y="5" width="6" height="14" rx="1.5" />
      <path d="M11 12H4M4 12l3-3M4 12l3 3" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4v-5Z" />
      <path d="M15 9.8a3.2 3.2 0 0 1 0 4.4M17.6 7.4a6.6 6.6 0 0 1 0 9.2" />
    </Icon>
  );
}

/** A filled dot, the universal record glyph. Filled rather than stroked so it
 *  reads as "armed" next to the outline icons around it. */
export function RecordIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9" />
    </Icon>
  );
}

/* A laptop: screen, then the base beneath it as one wider stroke. */
export function DeviceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4.5" width="16" height="11" rx="1.5" />
      <path d="M2.5 19.5h19M9 19.5l1-2h4l1 2" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 5.5l11 6.5-11 6.5v-13Z" />
    </Icon>
  );
}

export function SignalIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M5 17v-2.5M10 17v-5.5M15 17v-8.5M20 17V6" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5m0 0-6 6m6-6 6 6" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
    </Icon>
  );
}

/** An indeterminate spinner. `animate-spin` is applied by the caller so a static
 *  render (a screenshot, a print) still shows a sensible glyph. */
export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props} strokeWidth={2.25}>
      <path d="M12 3a9 9 0 1 0 9 9" opacity={0.9} />
    </Icon>
  );
}
