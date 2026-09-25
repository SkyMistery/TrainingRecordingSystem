# Architecture

## Stack

- **Electron** (main process + renderer windows), **TypeScript**, built with
  **electron-vite** (Vite 7).
- **React 19** UI with **IVAO Atmosphere** (`@ivao/atmosphere-react`) and
  **Tailwind v4**; Day/Night via the Atmosphere `dark` class.
- **OBS Studio** (≥ 30.2) through **obs-websocket v5** (`obs-websocket-js`).
- **uiohook-napi**: system-wide keyboard/mouse hook (press *and* release).
- **whisper.cpp** (`whisper-cli.exe`, CPU build, pinned with its sha256 in
  `scripts/fetch-whisper.mjs`) for offline transcription; models downloaded at
  runtime into `%APPDATA%\Training Recording System\models` from a pinned
  Hugging Face revision, checked against size and sha256 (`MODEL_FILES`).
  On silence whisper tends to repeat the vocabulary prompt: a transcript made
  only of prompt words (3 or more) counts as no speech.
  whisper-cli reads its arguments in the ANSI code page, so it runs in the
  models folder with relative names (model file, temporary copy of the note):
  paths with Greek, Cyrillic… characters would not be found otherwise.
- **ws** + **qrcode** for the Companion server.
- **electron-builder** (NSIS) + **electron-updater** from GitHub Releases.

## Processes, windows and modules

```
Main process (src/main)
 ├─ index.ts           app lifecycle, single instance, navigation and
 │                     permission guards, main window, quit sequence (waits
 │                     for the OBS profile restore, 20 s at most),
 │                     trs-media:// scheme
 ├─ appPages.ts        loads the renderer; isAppPage (IPC, permissions and
 │                     navigation are allowed for the app's own pages only);
 │                     the dev-server URL is ignored when packaged
 ├─ controller.ts      owns AppState; IPC; session commands; recording flow;
 │                     markers; voice notes; review state
 ├─ recorder/          Recorder interface + ObsRecorder (own profile/scene
 │                     collection, display capture, per-app/desktop/mic
 │                     audio, hybrid MP4, clock synced with OBS, screenshots)
 ├─ sessions.ts        session folders (naming, rename after edits),
 │                     session.json (atomic writes + .bak, migrations in
 │                     loadSession), SessionStore (serialised edits, live
 │                     or on disk), recording recovery (findRecordingFile)
 ├─ files.ts           writeJsonAtomic (temp file, fsync, rename retried
 │                     while Windows holds the file), renameWithRetry
 ├─ hotkeys.ts         GlobalHotkeys (uiohook): down/up, no auto-repeat,
 │                     capture mode for binding keys
 ├─ audioWindow.ts     AudioCapture: hidden window keeping the mic open
 ├─ transcriber.ts     model downloads, whisper.cpp job queue (one at a time)
 ├─ companion.ts       CompanionServer: HTTP + WebSocket, pairing, media
 ├─ notesWindow.ts     Companion page in a window on another monitor
 ├─ statusWindow.ts    always-on-top, non-focusable status window
 ├─ displays.ts        which Electron display OBS records
 ├─ windowMasks.ts     WindowMasks: follows the hidden windows (every 50 ms)
 │                     and moves the recorder's masks over them
 ├─ windows.ts         Win32 through koffi (FFI): visible top-level windows
 │                     with program, title and frame (physical pixels)
 ├─ media.ts           file serving with HTTP ranges (trs-media:// and /media)
 ├─ updater.ts         electron-updater: check at startup and every 6 h,
 │                     background download, state in AppState.update;
 │                     "Restart to update" runs the app's shutdown first
 │                     (OBS restore), then the silent installer
 └─ settings.ts        settings.json in userData (password via safeStorage;
                       writes queued, .bak used if the file is damaged)

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
resolves it inside the sessions folder and refuses anything else
(`sessionFilePath` uses `path.relative`, so a drive root such as `E:\` works).
Settings are saved as patches (`usePatchSaver` in the renderer, merged in the
main process), so two quick edits don't undo each other. Edits work
on the session being recorded (in memory) and on finished ones (on disk)
through `SessionStore`, which serialises writes per session.

## Recording

- `startSession`: apply capture config → create folder → `SetRecordDirectory`
  → `StartRecord` (the folder is removed if OBS refuses) → open microphone →
  status window.
- Markers take the time from the recorder clock (anchored on OBS
  `GetRecordStatus`), minus the pre-roll; screenshots via
  `SaveSourceScreenshot` (full-resolution PNG).
- `endSession` ends a session exactly once, whoever asks first (Stop, OBS
  stopping, lost connection, quit); markers and hotkeys are refused meanwhile.
  `finaliseSession` renames OBS's file to `recording.mp4` (`stop()` waits for
  OBS's STOPPED event, when the file is complete), closes an open range at the
  end, saves.
- No path from OBS (crash, lost connection) or a file still busy: the newest
  `.mp4` in the session folder is adopted later (`recoverRecording`, when the
  review opens and at startup). If only the connection dropped, the app
  reconnects (every 5 s for a minute) and `reattachRecording` continues the
  session OBS is still recording into.
- OBS sends STOPPED a moment before its output is really idle: `stop()`
  and the profile restore wait (up to 5 s) until nothing is active, or
  "Stop recording and quit" would leave OBS on the app's profile.
- Every obs-websocket request has a time limit (10 s; 30 s for profile
  switches and StopRecord). Setup changes run one at a time; `configure`
  re-enters the app's profile/collection first if the trainer switched OBS
  away. Pauses in OBS freeze the marker clock.
- Hidden windows (privacy): `WindowMasks` reads the frames of the windows
  matching `capture.hiddenWindows` (program + exact title, or every window of
  the program) with `DwmGetWindowAttribute(EXTENDED_FRAME_BOUNDS)`, makes them
  relative to the recorded display ("@ x,y" in the OBS monitor name), adds a
  margin and the union of the last three positions (a moving window stays
  covered despite the capture delay), and calls `Recorder.setMasks`.
  `ObsRecorder` keeps "TRS Mask N" colour sources above the display (which is
  moved to the bottom of the scene), moves them with one
  `SetSceneItemTransform` each (stretch bounds), hides the unused ones,
  skips repeats and re-sends every 2 s. Previews and marker screenshots are
  taken from the scene, not the display source, so they show the masks. The
  native library is loaded lazily: if it fails, the app still starts and
  Setup shows the problem.
- Marker numbers and note file numbers are never reused within a session;
  note audio is written with `wx`, so no file is ever overwritten.
- A category hotkey toggles that category on the latest marker.
- The trainer's OBS profile/collection is stored in settings
  (`obsPreviousWorkspace`, each half on its own) and restored on quit, also
  after a crash. TRS never switches profile while OBS records, streams or runs
  the virtual camera or replay buffer.

## Voice notes

The hidden `#audio` window keeps the microphone open for the whole session
(ScriptProcessor, 16 kHz mono, 400 ms pre-roll ring buffer, 250 ms tail) and
signals when it is ready (`audio:ready`). Push-to-talk down → capture starts,
OBS microphones marked "mute while dictating" are muted; up → WAV sent to the
main process, saved in `notes/`, queued for transcription. Taps < 300 ms are
ignored (and a marker created only for them is removed). The release waits
for the start to finish (`Dictation.started`), so muted OBS sources are always
unmuted; a dictation ends by itself after 3 minutes, and a Companion
push-to-talk ends when that device disconnects (ping heartbeat).

Open/close of the microphone carry a generation number: a stream that opens
after the session ended is closed at once. An unplugged microphone
(`ended`) is reported and reopened (same name, else the Windows default).

Microphone device ids are per origin (dev server vs packaged app) and change
with drivers: `openMicrophone` tries the saved id, then the same name, then
the Windows default, and reports problems (`microphoneError` in AppState).

## Review

`ReviewPage` plays `trs-media://sessions/<folder>/recording.mp4` (range
requests), reports the position to the main process (~2.5 Hz) and executes
player commands from other views. It never renders note text. Full-window
mode only changes classes (the video element must survive). Zoom/pan is a CSS
transform with a native non-passive wheel listener.

Privacy of notes on screen: the notes window and the status window use
`setContentProtection` (excluded from OBS and Discord capture); the main
window does too while recording only, since the review is meant to be
shared. The notes window avoids the recorded monitor.

## Companion security

- Listens on 127.0.0.1 by default; LAN access (0.0.0.0) is opt-in.
- Pairing link `/pair?token=…` (QR code) returns a page that sets an
  `HttpOnly; SameSite=Lax` cookie and continues to `/` (camera-app links are
  cross-site; a redirect lost the cookie on some browsers).
- Every page, file and WebSocket needs the cookie (constant-time compare of
  SHA-256 digests, so any input length is safe); the WebSocket also checks
  `Origin`. A new token unpairs all devices.
- Requests must arrive through 127.0.0.1 or a real network adapter (VPN and
  VM adapters are refused). Malformed requests are answered with 4xx and can
  never throw in the main process; media streams use `pipeline`, so an
  aborted download closes the file (an open file blocks renaming the folder).
- The QR code and link are hidden while a review is open (the main window may
  be shared) until the trainer asks for them.
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
  names and rewrites screenshot paths. It saves after each step, so
  session.json always matches the folders even if a step fails; a change of
  capitals only renames in place. Names are capped at 80 characters.
- The list is sorted by date, then `createdAt` (names carry no time of day).

Since v1.3 `session.json` also holds `consent`: the statement the trainer
confirmed in the New session dialog and when (`startSession` refuses to
record without it). The terms of use (docs/TERMS.md) are bundled into the
renderer and shown by `TermsDialog` until the accepted version in settings
(`termsAccepted`) equals `TERMS_VERSION` (src/shared/terms.ts): bump it when
the terms change in substance.

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
  release is already published. The run fails if the tag doesn't match
  package.json's version, reuses the draft of a failed run, and publishes only
  after checking that latest.yml, the installer and the blockmap were uploaded
  and that latest.yml's sha512 matches the installer. Actions are pinned by
  commit; the token is given only to the steps that need it.
- Electron fuses (electron-builder.yml): no run-as-Node, no NODE_OPTIONS or
  inspector arguments, app.asar only and with integrity validation.
- The app icon is `build/icon.png` (512 px, rendered from the TRS logo,
  `src/renderer/src/assets/trs-logo.svg`, also the favicon and the header
  logo); electron-builder makes the .ico. The credits footer uses the IVAO
  Italy division symbol. The executable's copyright comes
  from `copyright` in electron-builder.yml.
