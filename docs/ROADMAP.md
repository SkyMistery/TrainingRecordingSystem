# Roadmap

Training Recording System (TRS) helps IVAO trainers record a training session,
mark significant moments while it happens, take voice notes on them, and review
everything quickly during the debriefing.

## Goals

- Record the whole screen where Aurora runs (insets included) plus separate,
  individually mutable audio sources (single applications, desktop, microphone).
- Mark significant moments with a global hotkey, even while Aurora has focus.
- Attach voice notes (push-to-talk) to moments, automatically transcribed.
- Review the recording with a timeline of markers and ranges, share it on
  Discord, while keeping the trainer's notes private on a second screen or a
  tablet.
- English UI, Day and Night themes, following the IVAO brand guidelines and the
  Atmosphere design system.
- Distributed as a Windows installer through GitHub Releases, with auto-update.

## Milestones

Status (2026-09-24):

| Milestone | State |
|---|---|
| M0 Foundations | done — v0.1.0 |
| M1 OBS and session setup | done — v0.2.0 |
| M2 Markers | done — v0.3.0 |
| M3 Voice notes | done — v0.4.0 |
| M4 Review and Companion | done — v0.5.0 |
| M5 v1.0 | done — v1.0.0 |
| v1.1 feedback | done — v1.1.0: several categories per marker, folder names with trainee and session type, Training/Exam session type |
| v1.2 feedback | done — v1.2.0: connect to OBS from the top bar, edit a recorded session's details (folders renamed), plus a full robustness and security review (recording recovery, safer saves, OBS profile protection, privacy of notes on screen) |

Next: collect feedback from other trainers on v1.1/v1.2, then possibly the
native recorder without OBS (see [FUTURE.md](FUTURE.md)).

### M0 — Foundations
- Repository, MIT licence, documentation.
- Electron + TypeScript skeleton with Day/Night theming (Atmosphere tokens).
- GitHub Actions: build check on every push, installer published to a GitHub
  Release on every `v*` tag. Auto-update from GitHub Releases.

### M1 — OBS connection and session setup
- Connect to OBS Studio (>= 30.2) through obs-websocket v5 (built into OBS).
- Guided setup: the app creates its **own OBS profile and scene** so the
  trainer's existing OBS setup is never touched.
- Monitor selection (full display capture, so Aurora insets are recorded).
- Audio mixer: add/remove sources (application audio capture, desktop audio,
  microphone), mute and volume — executed by OBS.
- Recording format: hybrid MP4 + H.264, playable in-app and crash-safe.
- Session metadata: trainee VID and name, position (e.g. `LIRF_APP`), training
  type, date, trainer VID. Start/stop recording.

### M2 — Markers
- Global hotkeys (keyboard keys or mouse buttons) working while Aurora has focus.
- **Point marker**: full-resolution screenshot taken by OBS + recording time.
  The marker time is shifted back by a configurable **pre-roll** (default 10 s)
  because mistakes are usually noticed after they happen.
- **Range marker**: press once to open, press again to close. Ranges can be
  adjusted later; a point marker can be converted into a range.
- **Categories** (optional, configurable, coloured): assign them live with
  shortcuts or later during review. Includes a "Positive" category.
- Compact always-on-top status window: recording state, elapsed time, last
  marker, voice note indicator, transcription queue.
- Session data saved on every change (no data loss on crash).

### M3 — Voice notes
- Push-to-talk (hold) on keyboard key or mouse button.
- The note attaches to the latest marker, or creates a new one.
- While PTT is held the trainer's microphone is **muted in OBS**, so notes never
  end up in the recording.
- Local transcription with whisper.cpp (offline, free, automatic language
  detection). The model is downloaded on first use to keep the installer small.

### M4 — Review and Companion
- Review window: video player, timeline with coloured markers and ranges,
  previous/next marker, ±5 s / ±30 s, playback speed. **No notes are shown in
  this window**, so it can be shared on Discord safely.
- **Companion** — a local web page opened on another monitor, a PC or a tablet
  (pairing via QR code + token). It shows the notes and transcriptions and
  controls the app: during recording (marker, range, category, status) and
  during review (play/pause, seek, jump to marker, edit notes and categories).
- Edit markers, ranges, categories and transcriptions.
- Done, plus: zoom/pan on the video, full-window mode, playback speed in the
  Companion, phone-friendly layout, Public-network and firewall guidance,
  microphone lookup by name when its id changes.

### M5 — v1.0
- Done: sessions folder setting; delete a session (to the Recycle Bin);
  transcribe a session's notes again from the sessions list; transcription
  queue in the status window; Guide link in the top bar; first-run checklist.
  Also collapsible Setup sections and the Companion QR code in the top bar.
- Done: app icon and header logo from the IVAO Italy division symbol;
  credits and copyright footer on every page.
- Done: the executable is described as "Training Recording System" (the name
  the firewall prompt shows). Code signing is not planned (SmartScreen warning
  documented).
- Done: user guide reviewed (install section added), v1.0.0 release.

### Known issues / notes
- Development mode (`npm run dev`) serves the Companion unbundled: phones may
  show a blank page; test phones with the production build (`npm run build`
  then `electron .`).
- The Windows Firewall rule created in development is for `electron.exe`;
  the installed app asks again under its own name.

## Later

See [FUTURE.md](FUTURE.md) for proposals not scheduled yet (debriefing report,
recording without OBS, Google Drive, more UI languages).
