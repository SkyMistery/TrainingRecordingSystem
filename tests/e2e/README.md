# End-to-end tests

These scripts drive the **real** app (production build), OBS and microphone
through the Chrome DevTools Protocol (`window.api`) and synthetic keys
(uiohook: F13–F16, keys no application uses). They print `PASS`/`FAIL` lines.

Build first: `npm run build`. OBS must be running and **idle** (not
recording). Tests that need OBS take its WebSocket password as an argument —
it is not stored anywhere.

| Script | Needs | What it checks |
|---|---|---|
| `review.cjs` | `TRS_REVIEW_SESSION=<folder name>` of a session with a recording, a range and notes; no OBS | Companion security (pairing, cookie, Origin, path escapes, allow-listed commands), HTTP ranges, Review via the real button, no notes in the review window, player commands and position sync, edits from the Companion, notes window buttons, reconnection, zoom, full window, speed |
| `sessions.cjs` | nothing (own sessions folder in `%TEMP%`) | Note counts in the list, transcribe a session again (edited text kept), delete a session (Recycle Bin), path escapes refused |
| `mic.cjs` | OBS password | Voice notes with a stale microphone id (found by name) and with an unknown microphone (Windows default + warning), from the hotkey and the button |
| `notes.cjs` | OBS password; **close the app first** | Model download, push-to-talk, OBS mic muted while dictating, attach/new marker, tap ignored, transcription of `fixtures/note-en.wav` |
| `markers.cjs` | OBS password; **close the app first** | Markers with pre-roll and screenshots, category hotkey, ranges, auto-repeat, media protocol |

```bash
TRS_REVIEW_SESSION=2026-09-24_0046_00000_LIRF_APP node tests/e2e/review.cjs
node tests/e2e/mic.cjs <obs-websocket-password>
```

`review.cjs`, `sessions.cjs` and `mic.cjs` run in an isolated app instance (own settings folder
in `%TEMP%`, other ports), so they can run while the app is open.
`notes.cjs` and `markers.cjs` use the real settings (restored at the end);
they create test sessions named "E2E test" — remove those folders afterwards.
Every script stops its recording in a `finally` block; if a run is killed,
check that OBS isn't left recording.
