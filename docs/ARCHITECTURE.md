# Architecture

## Stack

- **Electron** (main process + renderer windows), **TypeScript**, built with
  **electron-vite** (Vite 7).
- **React 19** UI with **IVAO Atmosphere** (`@ivao/atmosphere-react`) and
  **Tailwind v4**; Day/Night via the Atmosphere `dark` class.
- **OBS Studio** (≥ 30.2) through **obs-websocket v5** (`obs-websocket-js`).
- **uiohook-napi**: system-wide keyboard/mouse hook (press *and* release).
- **whisper.cpp** (`whisper-cli.exe`, CPU build, pinned in
  `scripts/fetch-whisper.mjs`) for offline transcription; models downloaded at
  runtime into `%APPDATA%\Training Recording System\models`.
- **ws** + **qrcode** for the Companion server.
- **electron-builder** (NSIS) + **electron-updater** from GitHub Releases.

## Processes, windows and modules

```
Main process (src/main)
 ├─ index.ts           app lifecycle, main window, quit sequence (waits for
 │                     the OBS profile restore), trs-media:// scheme
 ├─ controller.ts      owns AppState; IPC; session commands; recording flow;
 │                     markers; voice notes; review state
 ├─ recorder/          Recorder interface + ObsRecorder (own profile/scene
 │                     collection, display capture, per-app/desktop/mic
 │                     audio, hybrid MP4, clock synced with OBS, screenshots)
 ├─ sessions.ts        session folders (naming, rename after edits),
 │                     session.json (atomic writes, migrations in
 │                     loadSession), SessionStore (serialised edits, live
 │                     or on disk)
 ├─ hotkeys.ts         GlobalHotkeys (uiohook): down/up, no auto-repeat,
 │                     capture mode for binding keys
 ├─ audioWindow.ts     AudioCapture: hidden window keeping the mic open
 ├─ transcriber.ts     model downloads, whisper.cpp job queue (one at a time)
 ├─ companion.ts       CompanionServer: HTTP + WebSocket, pairing, media
 ├─ notesWindow.ts     Companion page in a window on another monitor
 ├─ statusWindow.ts    always-on-top, non-focusable status window
 ├─ media.ts           file serving with HTTP ranges (trs-media:// and /media)
 └─ settings.ts        settings.json in userData (password via safeStorage)

Renderer (src/renderer) — one bundle, several entry points
 ├─ index.html         main window (App), status window (#status),
 │                     hidden microphone window (#audio)
 └─ companion.html     Companion page (served by CompanionServer)
```

Shared renderer pieces worth knowing: `Header` (OBS status button that
reconnects with the saved settings, Companion QR dialog, Guide link),
`AppFooter` (credits + copyright on every page, also in the Companion),
`SetupSection` (collapsible Setup cards, state in localStorage),
`FirstRunChecklist`, `MarkerList` (also exports `markerColors`, `paint`,
`CategoryChips`, `CategoryStripe` used by the timeline, review, status
window and Companion).

The main process owns all state and broadcasts `AppState` on every change.
Windows and Companion clients are views: they render the state and send
commands.

### One command API for every view

`SessionCommands` (src/shared/types.ts) lists the session edits and live
actions: add marker, toggle range, start/stop note, toggle a marker category
(`toggleMarkerCategory`: a marker has `categoryIds: string[]`), set marker
times, delete marker/note, set note text, retranscribe, player commands. The
desktop windows send them over IPC (`window.api.command(name, ...args)`), the
Companion over its WebSocket; both end in `Controller.execute`. The Companion
may only send this allow-listed set (no settings, no start/stop recording).

Sessions-list actions are IPC-only (not in `SessionCommands`, so never from
the Companion): `session:updateDetails` (fix trainee VID/name, position,
session type → folders renamed), `session:delete` (Recycle Bin via
`shell.trashItem`), `session:retranscribe`, `sessions:chooseFolder`, and
`obs:reconnect` (top bar). Delete and edit are refused while the session is
recorded, reviewed or has a note being transcribed
(`Transcriber.isTranscribing`); its queued jobs are dropped with `forget` and
re-queued after a rename.

Edits address a session by **folder name** (never a path); the controller
resolves it inside the sessions folder and refuses anything else. Edits work
on the session being recorded (in memory) and on finished ones (on disk)
through `SessionStore`, which serialises writes per session.

## Recording

- `startSession`: apply capture config → create folder → `SetRecordDirectory`
  → `StartRecord` (the folder is removed if OBS refuses) → open microphone →
  status window.
- Markers take the time from the recorder clock (anchored on OBS
  `GetRecordStatus`), minus the pre-roll; screenshots via
  `SaveSourceScreenshot` (full-resolution PNG).
- `finaliseSession`: renames OBS's file to `recording.mp4`, closes an open
  range at the end, saves.
- A category hotkey toggles that category on the latest marker.
- The trainer's OBS profile/collection is stored in settings
  (`obsPreviousWorkspace`) and restored on quit, also after a crash. TRS never
  switches profile while OBS records or streams.

## Voice notes

The hidden `#audio` window keeps the microphone open for the whole session
(ScriptProcessor, 16 kHz mono, 400 ms pre-roll ring buffer, 250 ms tail) and
signals when it is ready (`audio:ready`). Push-to-talk down → capture starts,
OBS microphones marked "mute while dictating" are muted; up → WAV sent to the
main process, saved in `notes/`, queued for transcription. Taps < 300 ms are
ignored (and a marker created only for them is removed).

Microphone device ids are per origin (dev server vs packaged app) and change
with drivers: `openMicrophone` tries the saved id, then the same name, then
the Windows default, and reports problems (`microphoneError` in AppState).

## Review

`ReviewPage` plays `trs-media://sessions/<folder>/recording.mp4` (range
requests), reports the position to the main process (~2.5 Hz) and executes
player commands from other views. It never renders note text. Full-window
mode only changes classes (the video element must survive). Zoom/pan is a CSS
transform with a native non-passive wheel listener.

## Companion security

- Listens on 127.0.0.1 by default; LAN access (0.0.0.0) is opt-in.
- Pairing link `/pair?token=…` (QR code) returns a page that sets an
  `HttpOnly; SameSite=Lax` cookie and continues to `/` (camera-app links are
  cross-site; a redirect lost the cookie on some browsers).
- Every page, file and WebSocket needs the cookie (timing-safe compare); the
  WebSocket also checks `Origin`. A new token unpairs all devices.
- `/media/` serves only files inside the sessions folder.
- Detects a Public Windows network profile (firewall blocks inbound) and warns.
- Logs `/` and `/pair` requests with the user agent, and page errors reported
  by `public/report-errors.js`, to the app's console.

## Session folder

```
<sessions folder>\2026-09-24_123456_Mario-Rossi_LIRF_APP_Training\
 ├─ session.json      metadata, recording info, markers (with notes)
 ├─ recording.mp4     hybrid MP4, H.264
 ├─ 2026-09-24_123456_Mario-Rossi_LIRF_APP_Training_screen\   m-0001.png …
 └─ notes\            n-0001.wav …  (16 kHz mono)
```

- The sessions folder defaults to `Documents\IVAO TRS\Sessions` and is a
  setting (`sessionsDir`, Setup → Sessions folder).
- Folder name: `<date>_<trainee VID>_<trainee name>_<position>_<session type>`
  (`sessionFolderName`: accents stripped, other characters → `-`, empty parts
  skipped, `-2`, `-3`… when taken). The screenshots folder is the session
  name + `_screen` (`screenshotsDir`), so it can be shared on its own. Marker
  screenshot paths are stored relative to the session folder.
- "Session type" in the UI is `metadata.trainingType` in the data (Training
  or Exam; older sessions may hold other values).
- `renameSessionFolder` applies the naming again after "Edit details"; it
  also moves v1.0-style sessions (time in the name, `screenshots/`) to the new
  names and rewrites screenshot paths.
- The list is sorted by date, then `createdAt` (names carry no time of day).

`session.json` is `SessionFile` in src/shared/types.ts (`schemaVersion: 1`);
`loadSession` fills fields added by later versions and migrates old ones
(v1.0 `categoryId` → `categoryIds`).

## Build and release

- `npm run fetch:whisper` downloads whisper.cpp into `resources/whisper`
  (gitignored); `dist`/`release`/`predev` run it automatically.
- The renderer targets Chrome/Edge 111, Safari 16.4, Firefox 128 (the
  Companion runs on phones), matching Tailwind v4/Atmosphere.
- Release workflow: create a draft release with `gh`, electron-builder uploads
  into it (`releaseType: draft`), then publish — avoids duplicate releases.
  GitHub once started the v1.1.0 workflow twice (two drafts, one left behind):
  runs are now serialised with `concurrency` and a run exits early when the
  release is already published.
- The app icon is `build/icon.png` (512 px, rendered from the division
  symbol); electron-builder makes the .ico. The executable's copyright comes
  from `copyright` in electron-builder.yml.
