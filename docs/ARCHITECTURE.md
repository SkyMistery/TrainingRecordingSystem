# Architecture

## Stack

- **Electron** + **TypeScript**, built with **electron-vite**.
- **React** for the UI (desktop windows and the Companion web page share the
  same components and theme).
- **electron-builder** for the Windows (NSIS) installer, **electron-updater**
  for auto-update from GitHub Releases.

## Processes and modules

```
Main process (Node)
 ├─ recorder/        Recorder interface + ObsRecorder (obs-websocket-js v5)
 ├─ session/         Session store: session.json, markers, notes (atomic writes)
 ├─ hotkeys/         Global keyboard/mouse hook (key down AND key up, for PTT)
 ├─ transcription/   whisper.cpp runner + job queue, model download
 ├─ companion/       Local HTTP + WebSocket server serving the Companion page
 └─ ipc/             Typed bridge to the renderer windows

Renderer windows (React)
 ├─ Main window      Setup, session list, review player (no notes: shareable)
 ├─ Status window    Compact always-on-top window while recording
 └─ Notes window     Notes panel for a second monitor (same view as Companion)

Companion (React, served by the main process)
 └─ Notes, transcriptions and remote control from another PC or a tablet
```

The main process owns all state. Windows and Companion clients are views that
receive state updates and send commands; this keeps desktop windows and the
Companion always in sync.

## Recorder

```ts
interface Recorder {
  connect(): Promise<void>
  listDisplays(): Promise<Display[]>
  listAudioSources(): Promise<AudioSourceOption[]>
  configure(scene: CaptureConfig): Promise<void>
  setMuted(sourceId: string, muted: boolean): Promise<void>
  start(outputDir: string): Promise<void>
  stop(): Promise<RecordingResult>
  currentTimeMs(): number
  screenshot(filePath: string): Promise<void>
}
```

`ObsRecorder` uses a dedicated OBS profile and scene collection created by the
app, a `monitor_capture` input for the display, `wasapi_process_output_capture`
for per-application audio, `wasapi_output_capture` for desktop audio and
`wasapi_input_capture` for the microphone. Recording format is hybrid MP4 with
H.264 so the file is crash-safe and playable in Chromium.

The recording time of a marker is taken from the recorder clock (anchored on
OBS `RecordStateChanged` and re-synchronised with `GetRecordStatus`).

## Voice notes

Push-to-talk is detected by the global hook (key down / key up). The renderer
records the microphone with an AudioWorklet and writes 16 kHz mono WAV, which
is what whisper.cpp expects. While PTT is held the OBS microphone input is
muted. Finished notes are queued for transcription.

## Session folder

```
<Documents>/IVAO TRS/Sessions/2026-09-23_1930_123456_LIRF_APP/
 ├─ session.json      metadata, markers, ranges, categories, notes
 ├─ recording.mp4
 ├─ screenshots/      m-0001.png …
 └─ notes/            n-0001.wav …
```

`session.json` is written atomically on every change.

## Companion security

The Companion server listens on `localhost` by default. LAN access (tablet) is
opt-in; clients pair by scanning a QR code that carries a random token, and
every request and WebSocket connection must present it.
