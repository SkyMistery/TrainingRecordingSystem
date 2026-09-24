# User guide

Training Recording System (TRS) records a training session from Aurora, lets
you mark significant moments and dictate notes while it happens, and replays
everything during the debriefing — with your notes kept on a separate screen.

## Install

You need Windows 10 (2004) or later and [OBS Studio](https://obsproject.com/)
30.2 or later.

Download `TrainingRecordingSystem-Setup-x.y.z.exe` from
[Releases](https://github.com/SkyMistery/TrainingRecordingSystem/releases) and
run it. The installer is not code-signed, so Windows SmartScreen may warn:
choose **More info → Run anyway**.

The app then updates itself. It looks for a new version at startup and every
few hours and downloads it in the background: the top bar shows **Update
x.y.z · 45%**, then **Restart to update**. Press it to install now (not
possible while recording), or simply close the app: the update installs when
it closes. Versions before 1.2.1 showed nothing until the download finished,
so leave them open a minute or two.

### Terms of use

On first start (and whenever they change) the app shows its
[terms of use](TERMS.md) and asks you to accept them. In short: you are
responsible for what you record; record only with the consent of the trainee
and everyone else in the voice call; note the recording in your flight plan or
ATIS remarks (IVAO Rule 2.1.12); never publish recordings, voice notes or
transcriptions; share screenshots only with the trainee and the training staff
involved. The terms are also linked at the bottom of every page.

## 1. First setup

Until everything is set up, the Sessions page shows a **Before your first
session** checklist; **Hide this list** removes it. **Guide** in the top bar
opens this guide.

Each Setup section can be collapsed by clicking its title (**Collapse all** /
**Expand all** at the top); the app remembers which ones you closed.

### OBS Studio

TRS records through [OBS Studio](https://obsproject.com/) 30.2 or later.

1. Open OBS → **Tools → WebSocket Server Settings**, tick **Enable WebSocket
   server**, then **Show Connect Info** and copy the password.
2. In TRS open **Setup → OBS Studio**, paste the password and press
   **Connect**.

Next time, if OBS wasn't running when TRS started, click **OBS not connected ·
Connect** in the top bar: TRS connects with the saved settings; if OBS
doesn't answer, it tells you why and offers to open Setup.

TRS uses its own OBS profile and scene collection ("IVAO TRS"): your own
scenes are never changed, and OBS goes back to your profile when TRS closes.
If OBS is already recording, streaming or using its virtual camera, TRS waits
instead of switching. If you switch OBS to your own profile while TRS is
open, TRS switches back before recording and never writes into yours.

Close **TRS before OBS**: TRS gives your profile back when it closes, which it
can't do once OBS is gone. If you closed OBS first, it opens on "IVAO TRS"
next time: start TRS and quit it, or pick your profile in OBS (Profile menu).

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
  management, Positive — rename, recolour, add your own. A marker can have
  several categories (e.g. Phraseology and Coordination): click the chips to
  add or remove them. A category hotkey adds that category to the latest
  marker, or removes it if the marker already has it. Removing a category
  also removes it from the markers of recorded sessions (TRS asks first):
  rename it instead if you only want another name.
- A small always-on-top **status window** shows time, markers and dictation,
  on a monitor that isn't recorded, and is left out of the recording even if
  you drag it onto that monitor. It never takes focus from Aurora.

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

1. **Sessions → New session**: trainee VID (and name), position, session
   type (**Training** or **Exam**), your VID, date. Tick **The trainee and the
   other participants in the voice call have agreed to be recorded** — ask them
   first: recording can't start without it, and the confirmation (with the
   time) is kept in the session's `session.json`.
2. During the session:
   - **Marker** hotkey: screenshot + marker at the current moment (minus the
     pre-roll).
   - **Range** hotkey: press to start, press again to end.
   - **Voice note**: hold the key, speak, release. The note goes to the open
     range, or to the latest marker if placed within the last 60 s (setting),
     otherwise it creates a new marker.
   - Buttons on the recording page (and on the Companion) do the same.
3. **Stop recording**. The session folder is named
   `<date>_<trainee VID>_<trainee name>_<position>_<session type>`, e.g.
   `2026-09-24_123456_Mario-Rossi_LIRF_APP_Training` (a second session with the
   same trainee on the same day ends in `-2`). It contains `recording.mp4`,
   `session.json`, `notes/` and the screenshots folder, named like the
   session with `_screen` at the end so you can share it on its own.
   Sessions recorded before v1.1 keep their old names and `screenshots/`.

Sessions are saved in `Documents\IVAO TRS\Sessions`; change it in **Setup →
Sessions folder**. Existing sessions stay where they are: move their folders
into the new one if you want them in the list.

While recording, the status window also shows how many voice notes are
waiting to be transcribed.

While recording, the TRS window itself is left out of screen captures (OBS,
Discord), so voice note transcriptions can't end up in the video even with a
single monitor. The Review window is shared normally.

If the connection to OBS drops during a session, TRS reconnects on its own for
a minute and carries on with the same session if OBS kept recording (markers
pressed while disconnected are lost). If OBS itself stopped or crashed, the
session is closed and its recording is picked up from the session folder the
next time you open it.

If the microphone is unplugged, TRS says so and switches to the Windows
default microphone. A voice note ends by itself after 3 minutes.

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
  window on a monitor that is neither the TRS window's nor the recorded one.
  It is left out of screen captures, so it stays private even if it ends up on
  a shared or recorded screen. (**Open in browser** has no such protection:
  keep that browser window off shared screens.)
- **Tablet or phone**: Setup → Companion → **Allow a tablet or phone on the
  same network**, then scan the QR code. The device stays paired; next time
  open the same address. **New pairing code** unpairs every device.
- The **Companion** button in the top bar (shown while the Companion is
  enabled) opens the QR code from any page, with the count of connected
  devices. While a review is open the QR code stays hidden until you press
  **Show the QR code**, since that window may be shared on Discord.

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
saved immediately. Deleting asks once more ("Delete?"), and the screenshot and
audio files go to the Windows Recycle Bin.

From the **⋯** menu of a session in the list:

- **Edit details…** — fix typos in the trainee VID or name, the position or the
  session type. The session folder and its screenshots folder are renamed to
  match (older sessions get the new folder names too). Close File Explorer
  windows showing the session first.
- **Transcribe voice notes again** — every note of the session, e.g. after
  downloading a better model. Text you edited by hand is kept.
- **Delete session…** — moves the session folder (recording, screenshots,
  notes) to the Windows Recycle Bin; restore it from there if needed.
