# Training Recording System

A desktop app for IVAO trainers: record a training session, mark significant
moments while it happens, attach voice notes that are transcribed
automatically, and review everything quickly during the debriefing.

> Status: early development. Recording through OBS (M1), markers with global
> hotkeys (M2) and transcribed voice notes (M3) work; the review player comes
> next. See the [roadmap](docs/ROADMAP.md).

## Features (planned for v1.0)

- Full-screen recording of the monitor where Aurora runs, with separate,
  mutable audio sources (single applications, desktop audio, microphone),
  powered by OBS Studio.
- Global hotkeys that work while Aurora has focus: point markers with an
  instant screenshot, range markers, optional colour-coded categories.
- Configurable pre-roll: markers are placed a few seconds before the key press.
- Push-to-talk voice notes, transcribed offline with Whisper. Your microphone
  is muted in the recording while you dictate.
- Review player with a timeline of markers, safe to share on Discord: notes are
  shown only on your second screen or on the Companion page (PC or tablet).
- Day and Night themes.

## Requirements

- Windows 10 (2004) or later.
- [OBS Studio](https://obsproject.com/) 30.2 or later, with the WebSocket
  server enabled (Tools → WebSocket Server Settings).

## Install

Download the latest `TrainingRecordingSystem-Setup-x.y.z.exe` from
[Releases](https://github.com/SkyMistery/TrainingRecordingSystem/releases).
The installer is not code-signed yet, so Windows SmartScreen may show a
warning: choose **More info → Run anyway**. The app updates itself when a new
release is published.

## Development

```bash
npm install
npm run dev        # run the app with hot reload
npm run typecheck
npm run dist       # build the installer locally into dist/
```

Releasing: bump `version` in `package.json`, commit, then push a matching tag
(`git tag v0.1.0 && git push --tags`). GitHub Actions builds the installer and
publishes the release.

## Documentation

- [Roadmap](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Future proposals](docs/FUTURE.md)

## Design

The UI follows the [IVAO brand guidelines](https://brand.ivao.aero) and is
built with [Atmosphere](https://github.com/ivaoaero/atmosphere), IVAO's design
system (LGPL-3.0). Fonts (Poppins, Nunito Sans, IBM Plex Mono) are bundled via
Fontsource under the SIL Open Font License.

## Licence

[MIT](LICENSE). Third-party components keep their own licences.
