# Tests

## Unit tests

`npm test` runs `tests/unit/*.test.ts` with Node's test runner (bundled with
esbuild by `scripts/unit-tests.mjs`): transcript hints and cleaning, session
file reading (paths confined to the session, damaged files, recordings never
overwritten), hotkey matching and push-to-talk key validation. No app, OBS or
Electron needed; CI runs them.

## End-to-end tests

These scripts drive the **real** app (production build), OBS and microphone
through the Chrome DevTools Protocol (`window.api`) and synthetic keys (F13–F16,
keys no application uses). They print `PASS`/`FAIL` lines. Every script runs
in an **isolated app instance** (own settings and sessions folder in `%TEMP%`,
own ports; `lib.cjs` builds them): the trainer's settings are at most read
(recorded monitor, audio sources, microphone).

Build first: `npm run build`. Tests that need OBS take its WebSocket password
from the `TRS_OBS_PASSWORD` environment variable, for that run only: it is not
stored anywhere. They connect to the trainer's OBS, which switches it to the
"IVAO TRS" profile: **close the app first** (one app per OBS) and leave OBS
idle; afterwards check that OBS is idle and back on your own profile (its
window title shows it).

| Script             | Needs                                                                                       | What it checks                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review.cjs`       | `TRS_REVIEW_SESSION=<folder name>` of a session with a recording, a range and notes; no OBS | Companion security (pairing, cookie, Origin, path escapes, allow-listed commands, malformed requests), HTTP ranges, Review via the real button, no notes in the review window, player commands and position sync, edits from the Companion, notes window buttons, reconnection, zoom, full window, speed. Works on a copy of the session       |
| `sessions.cjs`     | nothing (no OBS)                                                                            | Note counts in the list, transcribe a session again (edited text kept), several categories per marker (v1.0 sessions converted), delete a session (Recycle Bin), path escapes refused, edit details (folders and screenshot paths renamed, change of capitals in place), damaged session.json read from the backup, unrelated files ignored            |
| `transcribe.cjs`   | the "base" model downloaded once by the app                                                 | Transcription with non-ASCII paths (Greek user data and sessions folders); no temporary copies left                                                                                                                                                                                                                                                    |
| `ptt.cjs`          | nothing (no OBS)                                                                            | One-time pairing links, a secret per device, removing a device; push-to-talk only during a review, held while the device keeps asking, released when it stops, disconnects or the review closes, never by another device; malformed or flooding messages; which files and sessions a device may reach, a foreign Host refused                                                 |
| `mic.cjs`          | OBS                                                                                         | Voice notes with a stale microphone id (found by name) and with an unknown microphone (Windows default + warning), from the hotkey and the button; a button note holds the voice-note key only with "holdHotkeyFromButtons"                                                                                                                            |
| `notes.cjs`        | OBS                                                                                         | Model download, push-to-talk, OBS mic muted while dictating, attach/new marker, tap ignored, a hotkey with another modifier held, transcription of `fixtures/note-en.wav`                                                                                                                                                                              |
| `markers.cjs`      | OBS                                                                                         | Markers with pre-roll and screenshots, category hotkey, ranges, auto-repeat, media protocol                                                                                                                                                                                                                                                            |
| `masks.cjs`        | OBS                                                                                         | Hidden windows: a magenta test window is recorded without a rule, covered with one (also after it moves, after the monitor's position changed and after the display source was moved in OBS), recorded again when the rule is off; the app's own windows aren't offered                                                                              |
| `obs-recovery.cjs` | OBS, idle on your own profile                                                               | Profile switched by hand before Start (your profile's settings unchanged), pause in OBS vs marker times, another scene chosen during the recording switched back, app killed while recording → restarted app continues the session and adopts the recording, a recording started from OBS never lands in a session, OBS back on your profile after quitting |

```bash
TRS_REVIEW_SESSION=2026-09-24_123456_Mario-Rossi_LIRF_APP_Training node tests/e2e/review.cjs
```

```bash
TRS_OBS_PASSWORD=<obs-websocket-password> node tests/e2e/mic.cjs
```

Tests without OBS can run while the app is open. OBS tests create sessions
named "E2E test" in their own folder in `%TEMP%` and stop their recording in a
`finally` block; if a run is killed, check that OBS isn't left recording.
