# Zoom Webinar UI reference

Screenshots of Zoom's **web client** in a live webinar (meeting 94550156225), captured
2026-09-14 as a feature reference for planning Webinar Liv.

Note the session was a Zoom **Webinar**, not a Meeting — so the role model on show is
host / panelist / attendee, which maps onto ours.

**Everything below is the ATTENDEE view.** The host offered a panelist promotion
(see `05`) but it was not accepted during the session, so no panelist or host-only
surface was captured. Those are still to do — see "Not yet captured".

## Join flow

| File | What it shows |
|---|---|
| `00-zoom-join-dialog.png` | Zoom's generic "Join Meeting" entry form (meeting ID + name) |
| `01-join-interstitial.png` | The `zoom.us/j/...` interstitial offering the desktop app vs "Join from your browser" |
| `02-prejoin-name-email.png` | Web-client pre-join asking for name and email |
| `03-prejoin-filled.png` | Same form completed, showing the Join button state |

## Attendee in-webinar UI

| File | What it shows |
|---|---|
| `04-attendee-main-view.png` | Main stage on join |
| `06-meeting-with-participant.png` | Stage with an active speaker present |
| `07-panelist-toolbar.png` | The full attendee toolbar: Audio Setting, Q&A, Chat, Show Captions, Raise Hand, React, Settings, Leave. Note there is **no mic, camera or share button** — attendees cannot publish |

The filename says "panelist" because that was the intent at capture time; the contents
are the attendee toolbar.

## Panels

| File | What it shows |
|---|---|
| `08-chat-panel.png` | Chat panel, attendee side |
| `09-qa-panel.png` | Q&A panel: "Questions you ask the host and panelists will show up here", a question composer, and a "Who can see your questions?" disclosure |
| `12-reactions-menu.png` | Reactions picker |
| `13-audio-menu.png` | Audio Setting menu (device selection) |

## Settings

| File | What it shows |
|---|---|
| `10-settings-general.png` | Settings dialog, General tab |
| `11-settings-audio.png` | Settings dialog, Audio tab |

## Role promotion

| File | What it shows |
|---|---|
| `05-panelist-promotion-dialog.png` | "The host would like to promote you to be a panelist" — explains that a panelist can unmute and start video, carries the recording/transcription/AI consent notice, and offers **Stay as Attendee** vs **Join as Panelist** |

This one is worth studying for our own promotion flow: Zoom makes the capability change
explicit ("you can unmute and start video, which means you will be visible to others"),
obtains consent in the same dialog, and lets the person decline.

## Not yet captured

Requires accepting a panelist promotion, or joining as host:

- Panelist toolbar with mic / camera / screen share
- Participants panel with per-person host controls (mute, promote/demote, rename, remove)
- Mute All / Unmute All and the panel's More options
- Security menu
- Polls / Quizzes authoring and launch UI
- Q&A **host** view (answer live, answer by text, dismiss)
- Recording options (local vs cloud)
- Captions / live transcript host controls
- Breakout rooms configuration
- Waiting room admit UI
- Spotlight / pin on a tile's overflow menu
- Host Leave menu ("End Webinar for All" vs "Leave", host reassignment)
- Layout / View selector, remaining Settings tabs (Video, Background, Statistics)
- Share screen picker dialog
