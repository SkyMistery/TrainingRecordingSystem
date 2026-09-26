# CLAUDE.md

Guidance for working on this repository (Training Recording System, TRS).

## Context

- Built for and with an **IVAO Italia trainer** (GitHub: SkyMistery). They
  write in **Italian — reply in Italian**. Everything in the product (UI, docs,
  code, commits) is in **English**: trainers worldwide will use it.
- Windows-only Electron app. See docs/ROADMAP.md for status, docs/ARCHITECTURE.md
  for how it works, docs/USER_GUIDE.md for behaviour as the trainer sees it.
- Product decisions already agreed (don't re-ask): OBS-based recording first
  (a native recorder may come later — keep the `Recorder` interface clean);
  full-monitor capture; private windows (Aurora COM BOX by default) covered
  by masks that follow them (Setup → Hidden windows); per-app audio like OBS;
  keyboard or mouse-button hotkeys (no joystick); notes must **never** appear in the shareable review
  window; Companion page for notes on a second screen/tablet; offline Whisper
  transcription; range markers yes, clip export no; debrief report is only a
  proposal (docs/FUTURE.md); UI follows brand.ivao.aero + Atmosphere with
  Day/Night; the app's logo is the TRS microphone logo supplied by the
  trainer (assets/trs-logo.svg, public/icon.svg, build/icon.png: headers,
  favicon, exe icon); the footer keeps the IVAO Italy division symbol, never
  the main IVAO logo; every page (app and Companion) ends with the credits footer "made by
  Carmine (704798) and the IVAO Italy Division" + "© 2026 Carmine (704798)" (AppFooter); the
  copyright holder (footer, LICENSE, exe) is Carmine alone.
- Legal: docs/TERMS.md is written by Carmine in the first person (not IVAO);
  users accept it on first start and after every TERMS_VERSION bump
  (src/shared/terms.ts). Every session needs the consent checkbox ("The trainee
  and the other participants in the voice call have agreed to be recorded…",
  IVAO Rule 2.1.12), stored in session.json. Recordings, voice notes and
  transcriptions are never to be published; screenshots only to the trainee
  and training staff. Retention is the trainer's decision. Not legal advice:
  the trainer may still have the text reviewed.

## Commands

```bash
npm run dev         # development (Vite dev server; Companion unbundled)
npm run typecheck
npm run format      # Prettier (semi: false, singleQuote, printWidth 120)
npm run build       # production bundle → run with: npx electron .
npm run dist        # installer
```

Release: bump package.json version, commit, `git push`, then `git tag vX.Y.Z`
and `git push origin vX.Y.Z` (the workflow creates a draft release, uploads,
publishes). Also update the ROADMAP status table and the README status
line. Afterwards check that only one release exists for the tag (drafts
included: `gh api repos/SkyMistery/TrainingRecordingSystem/releases`) and that
its latest.yml sha512 matches the uploaded .exe. Deleting a duplicate draft
needs the trainer's OK. The workflow itself refuses a tag that doesn't match
package.json and publishes only after checking the assets and latest.yml; if
a check stops it, the release stays a draft: verify it by hand and publish it
through the API (`-F draft=false -f make_latest=true`) — never move a pushed
tag. Installed apps show the update in the top bar ("Restart to update",
v1.2.1+); users accept the terms again only when TERMS_VERSION changes.

## Testing

- Typecheck + build after every change; format with Prettier.
- tests/e2e/*.cjs drive the real app via CDP (see tests/e2e/README.md). Run
  the relevant one after changing behaviour. `review.cjs`, `sessions.cjs`,
  `transcribe.cjs`, `mic.cjs` and `ptt.cjs` use an isolated `--user-data-dir` and their own
  ports, so they don't disturb the trainer's running app. The app is single
  instance per user-data folder: an isolated instance runs beside the
  trainer's, one on the default folder only focuses it.
- For UI screenshots, render the built renderer (out/renderer) in an Electron
  window with a mocked preload. Use `webPreferences: { offscreen: true }` +
  `capturePage()` (a visible window at x: -4000 gave blank pages or
  UnknownVizError here). The mock must expose a **plain object** of functions
  via contextBridge (a Proxy can't be cloned), including `getTheme`; wait
  ~1 s after load before clicking, since state arrives asynchronously. Always
  put an `app.exit` timeout in such scripts so they can't hang.
- Don't wrap e2e scripts in a short `timeout`: review.cjs removes its session
  copy at the end, and a killed run leaves "E2E test" folders behind.
- sessions.cjs covers the sessions list (counts, retranscribe, categories,
  delete, edit details) in an isolated instance with a sessions folder in
  %TEMP% — run it after touching sessions.ts or the list actions.
  transcribe.cjs runs whisper through non-ASCII paths — run it after touching
  transcriber.ts.
- The packaged app has Electron fuses (no ELECTRON_RUN_AS_NODE, asar
  integrity): test packaged behaviour with `dist/win-unpacked` and an
  isolated `--user-data-dir` (never the default one: it would use the
  trainer's settings and OBS).
- The trainer is often running the app. Before closing it, check that OBS is
  not recording (obs-websocket `GetRecordStatus`, read-only) and close it
  gracefully (`CloseMainWindow`), never kill it. Never stop a recording you
  didn't start.
- The OBS WebSocket password is never stored in the repo or in scripts: pass
  it as an argument only for the run.
- OBS tests (markers, notes, obs-recovery, masks: real settings, app closed;
  mic: isolated) switch the trainer's OBS to "IVAO TRS" and back. Afterwards
  check with a read-only status script that OBS is idle and back on the
  trainer's profile (the OBS window title shows it), and remove the "E2E test"
  session folders they leave. masks.cjs checks hidden windows with a magenta
  test window: run it after touching windowMasks.ts, windows.ts or the masks
  in ObsRecorder.
- Test fixtures: `startSession(metadata, true)` (the consent confirmation), and
  isolated settings that click the UI need `termsAccepted` (the terms dialog
  covers the page otherwise).

## Gotchas learned the hard way

- **Don't edit files with PowerShell Get-Content/Set-Content** (Windows
  PowerShell 5.1 re-encodes UTF-8 and adds BOMs → mojibake). Use the editor
  tools or Node scripts. In PowerShell, `$S` and `$s` are the same variable.
- Shell-escaping regexes/backslashes inside `node -e` strings is fragile:
  write a script file instead.
- Browser microphone device ids differ between `npm run dev` and the packaged
  app: always go through `openMicrophone` (id → name → default).
- The Companion served by `npm run dev` doesn't work on phones (unbundled
  modules); test phones with the production build.
- Phones on the LAN need the Windows network profile **Private** and a
  firewall rule for the app on private networks; a page that "loads forever"
  (blank/black) means the connection is blocked.
- Session commands take the session **folder name**, never a path.
- Full-window/theatre mode must not remount the `<video>`.
- React StrictMode runs effects twice in dev: sockets and listeners must be
  guarded against the old instance's callbacks.
- OBS: never switch profile/scene collection while OBS records or streams;
  probe inputs need unique names; the simple-output encoder only changes after
  a profile reload.
- Closing the main window must quit the app (the hidden microphone window
  keeps it alive otherwise), and quitting waits for the OBS profile restore.
- Session folder names come from the metadata (see ARCHITECTURE "Session
  folder"); anything that changes metadata must go through
  `renameSessionFolder` so folders and screenshot paths stay consistent.
- Never connect a test instance to the trainer's OBS: connecting switches
  OBS to the "IVAO TRS" profile. Isolated tests use `obs.port: 1`.
- In shell heredocs, long JS with nested quotes/backticks breaks: write edit
  scripts to the scratchpad with the Write tool and run them with node.
- Prettier covers src, tests, scripts and .github only: never run it on docs/
  or README (their tables aren't Prettier-formatted).
- OBS reports a recording STOPPED a moment before its output is idle: wait
  for idle before switching profiles (see `waitUntilIdle`).
- whisper-cli reads its arguments in the ANSI code page: it runs in the models
  folder with relative names (non-ASCII user or sessions paths otherwise fail).
- electron-updater's `quitAndInstall` starts the installer at once: run the
  app's shutdown (OBS restore) before calling it.
- Atmosphere's `Dialog` always has a close button: a dialog that must not be
  dismissed uses the `AlertDialog*` primitives.
- Simulated keys (`GlobalHotkeys.hold`): uiohook's `keyToggle` drops the
  extended flag (AltGr reached Discord as Left Alt), so E0 keys go through
  SendInput. Test scripts that hook the keyboard while the trainer may be
  typing must record only their own test keys, never everything typed; and
  never hold Right Ctrl or AltGr in tests (the trainer's Aurora and Discord
  push-to-talk: it would transmit).
