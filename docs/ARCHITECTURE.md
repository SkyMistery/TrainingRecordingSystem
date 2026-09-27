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
  The prompt (`transcriptHints.ts`) is written in the dictation language
  (Italian or English) with English ATC terms, the ICAO alphabet and the
  trainer's `notes.vocabulary`, in ASCII only (see the ANSI note below).
  On silence whisper tends to repeat a stretch of the prompt: a transcript of
  6+ words found in the prompt in the same order counts as no speech, and a
  note whose loudest 100 ms stays under −50 dBFS isn't transcribed at all
  (whisper makes up "Thank you"-like sentences on silence).
  whisper-cli reads its arguments in the ANSI code page, so it runs in the
  models folder with relative names (model file, temporary copy of the note):
  paths with Greek, Cyrillic… characters would not be found otherwise.
  Jobs run one at a time at below-normal priority, with a time limit that
  grows with the note's length; `GGML_*` variables are removed from their
  environment and stray DLLs from the models folder.
- **koffi** (FFI) for Win32: window list and frames, SendInput, key state,
  token elevation.
- **ws** + **qrcode** for the Companion server.
- **electron-builder** (NSIS) + **electron-updater** from GitHub Releases.

## Processes, windows and modules

```
Main process (src/main)
 ├─ index.ts           app lifecycle, single instance, navigation and
 │                     permission guards (microphone only), main window, quit
 │                     sequence (saves the session, waits for the OBS profile
 │                     restore, 60 s at most; also on Windows shutdown),
 │                     trs-media:// scheme; an uncaught error releases every
 │                     key the app holds
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
 │                     capture mode for binding keys (modifiers alone for
 │                     push-to-talk keys), hold() simulating a press through
 │                     SendInput, releases retried until they succeed
 ├─ keymap.ts          uiohook key code → Windows virtual key (generated
 │                     from libuiohook's table)
 ├─ validate.ts        checks on hotkeys, push-to-talk keys, marker settings,
 │                     models, languages and player commands from the views
 ├─ programs.ts        programs never offered as hidden windows or audio
 ├─ transcriptHints.ts whisper prompt, prompt-echo and silence checks
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
 ├─ updater.ts         electron-updater: check at startup and every 6 h;
 │                     download and install only when the trainer confirms
 │                     (no auto-download, no install on quit); "Restart to
 │                     update" runs the app's shutdown first (OBS restore),
 │                     then the silent installer
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

- `startSession`: validate the metadata and the consent → apply capture
  config → create folder → check the app's scene exists and is on program →
  `SetRecordDirectory` → `StartRecord` (the folder is removed if OBS refuses)
  → open microphone → status window. One start at a time (`starting`); quit
  waits for it. After the session the record directory goes back to the
  sessions folder (once OBS is idle), so a recording started from OBS itself
  never lands in a session folder.
- OBS events become warnings on the recording page, the status window and the
  Companion (`RecordingState.warnings`): another scene put on program (TRS
  switches back), the display source moved (put back), masks that can't be
  placed, a microphone that didn't mute. A pause in OBS shows as "Paused in
  OBS". Lost connection, OBS stopping and reconnection are notices at the top
  of the main window (`AppState.notice`).
- Markers take the time from the recorder clock (anchored on OBS
  `GetRecordStatus`), minus the pre-roll; screenshots via
  `SaveSourceScreenshot` (full-resolution PNG).
- `endSession` ends a session exactly once, whoever asks first (Stop, OBS
  stopping, lost connection, quit); markers and hotkeys are refused meanwhile.
  `finaliseSession` renames OBS's file to `recording.mp4` (`stop()` waits for
  OBS's STOPPED event, when the file is complete; `recording-2.mp4`… if one
  is already there: nothing is ever overwritten), records `endedAt`, closes an
  open range at the end, saves. If the save fails the session stays in memory
  (`unsaved`) and a notice offers **Save again**.
- No path from OBS (crash, lost connection) or a file still busy: the newest
  `.mp4` in the session folder is adopted later (`recoverRecording`, when the
  review opens and at startup once OBS is connected), unless OBS is still
  writing it. If only the connection dropped, the app reconnects (every 5 s
  for a minute) and `reattachRecording` continues the session OBS is still
  recording into — only a session that never ended and has no recording yet.
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
  relative to the recorded display ("@ x,y" in the OBS monitor name; without
  it the masks report an error rather than guess), adds a margin, the union
  of the last three positions and where the window is heading (a moving
  window stays covered despite the capture delay), and calls
  `Recorder.setMasks`. Windows owned by a hidden window (popups, menus) are
  covered too; a window that just went away stays covered 600 ms (Windows
  animates it out). Each window keeps its mask slot while on screen.
  `ObsRecorder` keeps "TRS Mask N" colour sources (locked) above the display
  (kept at the bottom of the scene with a fixed transform, locked, checked
  every 2 s and put back if moved), moves them with one
  `SetSceneItemTransform` each (stretch bounds), shows a new mask before
  hiding an old one, skips repeats and re-sends every 2 s. Previews and
  marker screenshots are taken from the scene, not the display source, so
  they show the masks. Failures are warnings on every view (and in the New
  session dialog), never a block. The native library is loaded lazily: if it
  fails, the app still starts and Setup shows the problem.
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
unmuted; a mute that fails is reported on the recording page. A dictation
ends by itself after 3 minutes, when its owner (the hotkey, the app, a
Companion device) goes away, or when its hotkey is found up
(`GetAsyncKeyState`) although the hook missed the release. A note is owned by
who started it: only the same source stops it. The audio window reports
`'tap'` or `'failed'` instead of audio when there is nothing to save; if its
renderer crashes or hangs it is recreated and the microphone reopened.

A note started from a button (app or Companion) holds the voice-note hotkey
for its whole length when `notes.holdHotkeyFromButtons` is on, so a voice
chat using that key as push-to-mute (Discord) mutes the trainer as with a
real press. Fail-closed: if the key can't be pressed, the note doesn't start.
The key is released when the note stops, fails to start, or the hotkeys stop
(quit).

Simulated keys: every key and mouse button goes through SendInput, with the
virtual key from `keymap.ts`, the scan code from `MapVirtualKeyW` and the
extended flag for E0 keys (uiohook's `keyToggle` dropped it: Discord saw AltGr
as Left Alt). Windows silently drops input sent to an elevated window from a
non-elevated app (UIPI): `hold()` checks the foreground window first and
throws. A release that fails is retried every 500 ms and reported
(`stuckKey`) until it succeeds. GlobalHotkeys ignores its own simulated
presses when they come back through the hook by comparing the event's time
with the tick count of the send (modifiers are never filtered, so a real
modifier held meanwhile still counts). Locking the screen, suspending and an
uncaught error release every key the app holds (`releaseEverything`).

The Companion's push-to-talk buttons (`holdPtt`/`releasePtt`) hold
`companion.pttKeys.voiceChat` or `.aurora` with the same `hold()`, only during
a recording or a review. The device repeats "still holding" every second: a
key is released 2.5 s after the last one (page hidden, screen locked, Wi-Fi
lost), when the device disconnects, when the recording or review ends, and
after 60 s (Aurora) or 5 minutes (voice chat); after that limit the device
must let go before pressing again. Another device can't release it; the PC
can (`companion:releasePtt`, the red bar). The state sent to the devices says
which keys are really held (`pttHolds`), so the button shows "Talking" only
then. `validPttKey` refuses Alt, editing keys, Ctrl + non-function keys and
the voice-note key. Saving push-to-talk keys doesn't restart the Companion
server (only enabled/lan/port do), so devices stay connected.

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
window does too except while it is shareable (a review open and nothing
recording: `Controller.isShareable`), since the review is meant to be shared
and every other page shows other trainees, the pairing code or notes. The
notes window avoids the recorded monitor. Voice notes can't be played in the
app while recording (they would reach the recording and the call).

The duration shown comes from the video itself (`review:duration`), with
`session.json`'s as a fallback; the review plays `recording.file` as stored
(`recording-2.mp4` after a second recording was adopted).

## Companion security

- Listens on 127.0.0.1 by default; LAN access (0.0.0.0) is opt-in.
- Pairing: the QR code holds a one-time link `/pair?code=…` (random, never
  stored, replaced after each pairing and whenever a device is removed). It
  creates a device with its own secret and returns a page that sets the cookie
  `trs_device=<id>.<secret>` (`HttpOnly; SameSite=Lax`, one year) and continues
  to `/` (camera-app links are cross-site; a redirect lost the cookie on some
  browsers). Settings keep only a SHA-256 digest of each secret
  (`companionDevices`: name from the user agent, paired and last-seen times);
  the PC shows a notice for every pairing. Devices are listed in Setup and
  removed one by one or all together: their cookies stop working and their
  connections close at once.
- The notes window pairs itself: its cookie is set through Electron's session
  with a secret valid for this run only (`localPage()`).
- Every page, file and WebSocket needs the cookie (constant-time compare of
  SHA-256 digests, so any input length is safe). The `Host` header must be
  this PC's address and port (no DNS rebinding); the WebSocket also checks
  `Origin`. Responses carry `nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `no-store` and `no-referrer`.
- Requests must arrive through 127.0.0.1 or a real network adapter (VPN and
  VM adapters are refused). Malformed requests are answered with 4xx and can
  never throw in the main process; media streams use `pipeline`, so an
  aborted download closes the file (an open file blocks renaming the folder).
- WebSocket limits: 10 clients, 256 KiB per message, 20 messages/s (bursts of
  60), 4 MB of unsent data; every message is validated, and errors sent back
  carry no paths.
- What a device can reach: the state of the session being recorded or
  reviewed only, and from `/media/` only that session's `.png` and `.wav`
  files (`isSessionMedia`: extension and real path inside the sessions
  folder). Commands are the allow-listed `SessionCommands`, for that session
  only; markers from the Companion are rate-limited.
- Push-to-talk (see Voice notes) only during a recording or a review.
- The QR code and link are hidden while a review is open (the main window may
  be shared) until the trainer asks for them.
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
record without it); since v1.6 also the terms version accepted
(`consent.termsVersion`). The terms of use (docs/TERMS.md) are bundled into
the renderer and shown by `TermsDialog` until the accepted version in settings
(`termsAccepted`) equals `TERMS_VERSION` (src/shared/terms.ts): bump it when
the terms change in substance. OBS, the hotkeys and the Companion start only
after the terms are accepted (`startServices`).

`session.json` is `SessionFile` in src/shared/types.ts (`schemaVersion: 1`);
`loadSession` strips a byte order mark, fills fields added by later versions,
migrates old ones (v1.0 `categoryId` → `categoryIds`) and makes a hand-edited
file safe: every stored path must stay inside the session (`sessionPath`),
malformed markers and notes are dropped. A damaged file is copied to
`session.damaged.json` and the `.bak` is read instead. A file written by a
newer version (`schemaVersion` > 1) is shown but never rewritten.

The sessions folder gets a warning (Setup) when it is synchronised with
OneDrive or outside the user's folders (`sessionsDirWarning`).

## Build and release

- `npm run fetch:whisper` downloads whisper.cpp into `resources/whisper`
  (gitignored); `dist` and `predev` run it automatically.
- Native modules (koffi, uiohook-napi) ship their prebuilt binaries:
  `npmRebuild: false`, and uiohook's local build leftovers are excluded.
- The renderer targets Chrome/Edge 111, Safari 16.4, Firefox 128 (the
  Companion runs on phones), matching Tailwind v4/Atmosphere.
- CI (`ci.yml`): typecheck, unit tests (`npm test`), build.
- Release workflow (`release.yml`), two jobs. **build** (Windows, read-only
  token, no credentials kept by checkout) checks that the tag matches
  package.json's version, runs `npm run dist` with `--publish never` and
  uploads the installer, blockmap and latest.yml as an artifact. **publish**
  (Ubuntu, the only job with write access) checks that the tagged commit is
  on main, creates or reuses
  the draft release, uploads the files (`gh release upload --clobber`), checks
  that latest.yml's sha512 matches the uploaded installer (downloaded back)
  and publishes. GitHub once started the v1.1.0 workflow twice (two drafts,
  one left behind): runs are serialised with `concurrency` and a run exits
  early when the release is already published. Actions are pinned by commit.
- Electron fuses (electron-builder.yml): no run-as-Node, no NODE_OPTIONS or
  inspector arguments, app.asar only and with integrity validation.
- The app icon is `build/icon.png` (512 px, rendered from the TRS logo,
  `src/renderer/src/assets/trs-logo.svg`, also the favicon and the header
  logo); electron-builder makes the .ico. The credits footer uses the IVAO
  Italy division symbol. The executable's copyright comes
  from `copyright` in electron-builder.yml.
