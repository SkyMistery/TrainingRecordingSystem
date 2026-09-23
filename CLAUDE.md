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
  full-monitor capture; per-app audio like OBS; keyboard or mouse-button
  hotkeys (no joystick); notes must **never** appear in the shareable review
  window; Companion page for notes on a second screen/tablet; offline Whisper
  transcription; range markers yes, clip export no; debrief report is only a
  proposal (docs/FUTURE.md); UI follows brand.ivao.aero + Atmosphere with
  Day/Night; IVAO logo not used until IVAO PR approves.

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
publishes). Check that only one release exists for the tag.

## Testing

- Typecheck + build after every change; format with Prettier.
- tests/e2e/*.cjs drive the real app via CDP (see tests/e2e/README.md). Run
  the relevant one after changing behaviour. `review.cjs` and `mic.cjs` use an
  isolated `--user-data-dir` and their own ports, so they don't disturb the
  trainer's running app.
- For UI screenshots, render the built renderer in an Electron window with
  mocked IPC handlers; hidden windows may not repaint after state changes, so
  use a visible off-screen window (x: -4000) or capture right after load.
- The trainer is often running the app. Before closing it, check that OBS is
  not recording (obs-websocket `GetRecordStatus`, read-only) and close it
  gracefully (`CloseMainWindow`), never kill it. Never stop a recording you
  didn't start.
- The OBS WebSocket password is never stored in the repo or in scripts: pass
  it as an argument only for the run.

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
