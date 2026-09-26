# Training Recording System

A desktop app for IVAO trainers: record a training session, mark significant
moments while it happens, attach voice notes that are transcribed
automatically, and review everything during the debriefing — sharing the
recording on Discord while your notes stay on another screen or a tablet.

> Status: v1.5 — recording, markers, voice notes, review and Companion are
> released. See the [roadmap](docs/ROADMAP.md) and [future ideas](docs/FUTURE.md).

## Features

- Full-screen recording of the monitor where Aurora runs (insets included),
  with separate, mutable audio sources (single applications, desktop audio,
  microphone) — powered by OBS Studio, using its own profile and scenes.
- Private windows (such as Aurora's COM BOX) covered in the recording and
  screenshots, wherever you move them.
- Global hotkeys that work while Aurora has focus: point markers with a
  full-resolution screenshot, range markers, optional colour-coded categories,
  configurable pre-roll.
- Push-to-talk voice notes, transcribed offline with Whisper; your microphone
  is muted in the recording while you dictate.
- Review player with a timeline of markers and ranges, zoom, speed up to 10×,
  5 and 10-second jumps and keyboard shortcuts — safe to share: it never shows
  your notes.
- Companion page for your notes and remote control: a window on a second
  monitor, or a phone/tablet paired with a QR code.
- Sessions list with review, delete (to the Recycle Bin) and transcribe
  again; configurable sessions folder; first-run checklist.
- Day and Night themes following the IVAO brand and the Atmosphere design
  system. English UI.

## Requirements

- Windows 10 (2004) or later.
- [OBS Studio](https://obsproject.com/) 30.2 or later with the WebSocket
  server enabled (Tools → WebSocket Server Settings).

## Install

Download the latest `TrainingRecordingSystem-Setup-x.y.z.exe` from
[Releases](https://github.com/SkyMistery/TrainingRecordingSystem/releases).
The installer is not code-signed, so Windows SmartScreen may warn: choose
**More info → Run anyway**. The app updates itself from GitHub Releases.

Then follow the [user guide](docs/USER_GUIDE.md). On first start the app asks
you to accept the [terms of use](docs/TERMS.md): record only with the consent
of everyone in the voice call, and never publish the recordings.

## Development

```bash
npm install
npm run dev          # app with hot reload (downloads whisper.cpp on first run)
npm run typecheck
npm run format       # Prettier
npm run build        # production bundle in out/; run it with: npx electron .
npm run dist         # Windows installer in dist/
```

End-to-end tests drive the real app, OBS and microphone: see
[tests/e2e/README.md](tests/e2e/README.md).

Releasing: bump `version` in `package.json`, commit, push, then push a
matching tag (`git tag v0.5.0 && git push origin v0.5.0`). GitHub Actions builds
the installer and publishes one release with the auto-update files.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [Terms of use](docs/TERMS.md)
- [Roadmap and status](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Future proposals](docs/FUTURE.md)

## Design

The UI follows the [IVAO brand guidelines](https://brand.ivao.aero) and is
built with [Atmosphere](https://github.com/ivaoaero/atmosphere), IVAO's design
system (LGPL-3.0). Fonts (Poppins, Nunito Sans, IBM Plex Mono) are bundled via
Fontsource under the SIL Open Font License. Transcription uses
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and Whisper
models.

## Credits

Made by Carmine (704798) and the IVAO Italy Division. The credits footer
shows the IVAO Italy division symbol.

## Licence

[MIT](LICENSE). Third-party components keep their own licences. Using the
app also means accepting its [terms of use](docs/TERMS.md).
