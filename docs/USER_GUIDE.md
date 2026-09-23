# User guide

Training Recording System (TRS) records a training session from Aurora, lets
you mark significant moments and dictate notes while it happens, and replays
everything during the debriefing — with your notes kept on a separate screen.

## 1. First setup

### OBS Studio

TRS records through [OBS Studio](https://obsproject.com/) 30.2 or later.

1. Open OBS → **Tools → WebSocket Server Settings**, tick **Enable WebSocket
   server**, then **Show Connect Info** and copy the password.
2. In TRS open **Setup → OBS Studio**, paste the password and press
   **Connect**.

TRS uses its own OBS profile and scene collection ("IVAO TRS"): your own
scenes are never changed, and OBS goes back to your profile when TRS closes.
If OBS is already recording or streaming, TRS waits instead of switching.

### Display

In **Setup → Display** choose the monitor where Aurora runs. The whole monitor
is recorded, so Aurora's insets and floating windows are included. Choose
**Downscale to 1080p** for 1440p/4K monitors if you want smaller files. The
encoder is picked for your graphics card on first run.

### Audio

Add the sources you want in the recording, like in OBS:

- **Application**: Aurora, your voice client (Discord, TeamSpeak…). One entry
  per program; audio follows the program even if its window title changes.
- **Microphone**: your voice. Keep **Mute in the recording while I dictate a
  voice note** on, so your notes don't end up in the video.
- **Desktop audio**: everything you hear (includes the app's beeps).

Each source has its own mute and volume, with a live level meter.

### Markers and hotkeys

Hotkeys work while Aurora has focus. Defaults: **F9** marker, **F10** range
start/end. Set **Voice note (hold)** to a key or a mouse side button that
Aurora doesn't use. Keys still reach Aurora too.

- **Pre-roll** (default 10 s): markers are placed before the key press, since
  you usually notice a moment after it happens.
- **Categories** (optional): Phraseology, Separation, Coordination, Traffic
  management, Positive — rename, recolour, add your own. A category hotkey tags
  the latest marker.
- A small always-on-top **status window** shows time, markers and dictation,
  on a monitor that isn't recorded. It never takes focus from Aurora.

If Aurora runs **as administrator**, run TRS as administrator too, otherwise
Windows doesn't pass it the keys pressed in Aurora.

### Voice notes

In **Setup → Voice notes** choose the microphone (speak: the bar moves), the
language you dictate in (more reliable than automatic detection for short
notes) and the transcription model. Models are downloaded once:

| Model | Size | Notes |
|---|---|---|
| Base | 142 MB | fastest |
| Small | 466 MB | recommended |
| Large v3 Turbo | 547 MB | most accurate, slower on older CPUs |

Transcription runs on your PC: nothing is sent online.

## 2. Recording a session

1. **Sessions → New session**: trainee VID (and name), position, training
   type, your VID, date.
2. During the session:
   - **Marker** hotkey: screenshot + marker at the current moment (minus the
     pre-roll).
   - **Range** hotkey: press to start, press again to end.
   - **Voice note**: hold the key, speak, release. The note goes to the open
     range, or to the latest marker if placed within the last 60 s (setting),
     otherwise it creates a new marker.
   - Buttons on the recording page (and on the Companion) do the same.
3. **Stop recording**. The session folder contains `recording.mp4`,
   `session.json`, `screenshots/` and `notes/`.

Sessions are saved in `Documents\IVAO TRS\Sessions`.

## 3. Debriefing

**Sessions → Review** opens the player. This window never shows your notes,
so you can share it on Discord.

| Key | Action |
|---|---|
| Space / K | play / pause |
| ← → | 5 s back / forward (Shift: 30 s) |
| [ ] or Page Up / Down | previous / next marker |
| mouse wheel, + − | zoom at the cursor; drag to move |
| 0 or double-click | reset zoom |
| F | full window (Esc to exit) |

Zooming in on a label keeps it readable even through Discord's compression
(720p without Nitro).

### Notes window and Companion

Your notes live in the **Companion** view: the current marker with its notes
and transcriptions, all markers, category chips, player controls and speed,
and buttons to adjust a marker to the current position ("Start at / End at").

- **Notes window** (Review page or Setup → Companion): the Companion in a
  window on another monitor.
- **Tablet or phone**: Setup → Companion → **Allow a tablet or phone on the
  same network**, then scan the QR code. The device stays paired; next time
  open the same address. **New pairing code** unpairs every device.

During a recording the Companion also offers Marker, Range and Hold-to-dictate
buttons (the PC's microphone records the note).

#### Tablet doesn't connect?

- Same Wi-Fi as the PC.
- The Windows network must be **Private**: Windows Settings → Network &
  internet → Wi-Fi → your network → Network profile type → **Private**. TRS
  warns you when it is Public.
- Windows Firewall must allow the app on **private networks**: when Windows
  asks, tick Private networks; or open *Allow an app through Windows Firewall*
  → Change settings → tick **Private** for the app.
- A page that stays loading (blank/black, with the browser's stop "X")
  means the connection is blocked: check the two points above.
- If the PC's address changes (router restart), scan the QR code again.

Use network access only on your home network, not on public Wi-Fi.

## 4. Editing after the session

In Review (from the notes window or a tablet) you can change categories, edit
transcriptions (click the text), transcribe again, delete notes or markers,
and move a marker or a range's start/end to the current position. Changes are
saved immediately.
