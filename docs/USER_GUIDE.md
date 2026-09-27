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

The app looks for a new version at startup and every few hours, but never
downloads or installs one by itself. When there is one, the top bar shows
**Update to x.y.z**: press it and confirm to download it in the background
(**Update x.y.z · 45%**), then **Restart to update** and confirm to install it.
Neither works while recording.

### Terms of use

On first start (and whenever they change) the app shows its
[terms of use](TERMS.md) and asks you to accept them; OBS, the hotkeys and the
Companion start only once you have. In short: you are responsible for what
you record; record only with the consent of the trainee and everyone else in
the voice call; note the recording in your flight plan or ATIS remarks (IVAO
Rule 2.1.12); keep private windows and notifications off the recorded
monitor; never publish recordings, voice notes or transcriptions; share
screenshots only with the trainee and the training staff involved; pair only
your own devices with the Companion. The terms are also linked at the bottom
of every page.

## 1. First setup

Until everything is set up, the Sessions page shows a **Before your first
session** checklist; **Hide this list** removes it. **Guide** in the top bar
opens this guide.

Each Setup section can be collapsed by clicking its title (**Collapse all** /
**Expand all** at the top); the app remembers which ones you closed.

The TRS window is left out of screen captures and screen sharing (OBS,
Discord, screenshot tools) on every page except the **Review**, the one meant
to be shared: the sessions list shows other trainees, Setup shows the
Companion's pairing code, the recording page your notes.

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
If OBS is recording, streaming, or using its virtual camera or replay buffer,
TRS doesn't connect (it would have to switch OBS away from what it is doing):
stop that in OBS, then press Connect. If you switch OBS to your own profile or
scene while TRS is open, TRS switches back before recording and never writes
into yours; if the scene changes during a recording, TRS puts it back and
tells you.

Close **TRS before OBS**: TRS gives your profile back when it closes, which it
can't do once OBS is gone. If you closed OBS first, it opens on "IVAO TRS"
next time: start TRS and quit it, or pick your profile in OBS (Profile menu).

### Display

In **Setup → Display** choose the monitor where Aurora runs. The whole monitor
is recorded, so Aurora's insets and floating windows are included — and so is
anything else that shows on it, including notifications. Choose **Downscale to
1080p** for 1440p/4K monitors if you want smaller files. The encoder is picked
for your graphics card on first run.

If you rearrange your monitors (another main monitor, a laptop docked), TRS
reads the recorded monitor's position again by itself, so hidden windows stay
covered.

### Hidden windows

Some windows on the recorded monitor are private: for example Aurora's
**COM BOX**, where you chat with other controllers. **Setup → Hidden windows**
covers them with a grey box in the recording and in screenshots, wherever you
move them on that monitor, together with their popups and menus. The COM BOX
is hidden by default: keep it that way — its messages belong to other people.

To hide another window, open it, choose it in the list and click **Add**. A
window is recognised by its program and title, so it stays hidden when you
close and reopen it; with **Hide every window of this program** every window of
that program is covered. Each rule shows **On screen** when its window is open:
if the window is open but the rule says **Not open**, its title changed — add
it again. Check the preview in **Setup → Display**.

If the boxes can't be placed (OBS switched to another scene collection, a
problem with Windows), the recording page, the status window and the Companion
say so in red, with an error sound, and the New session dialog warns before
you start: until it is fixed, those windows are recorded.

Good to know:
- The box covers the window's area even when another window is on top of it.
- While you drag a hidden window, the box follows it a moment later and is
  larger than the window while it moves; move it before an important moment
  rather than during it. A window that just opened can show for a frame.
- Notifications (Windows, Discord, messages) can't be hidden: turn on **Do not
  disturb** before recording.
- Windows on another monitor aren't recorded anyway.

### Audio

Add the sources you want in the recording, like in OBS:

- **Application**: Aurora, your voice client (Discord, TeamSpeak…). One entry
  per program; audio follows the program even if its window title changes.
- **Microphone**: your voice. Keep **Mute in the recording while I dictate a
  voice note** on, so your notes don't end up in the video; if OBS doesn't mute
  it, the recording page tells you.
- **Desktop audio**: everything you hear (includes the app's beeps).

Each source has its own mute and volume, with a live level meter.

### Markers and hotkeys

Hotkeys work while Aurora has focus. Defaults: **F9** marker, **F10** range
start/end. Set **Voice note (hold)** to a key or a mouse side button that
Aurora doesn't use. Keys still reach Aurora too, and hotkeys work while you
hold another key (talking on Right Ctrl or AltGr). A key that types text (a
letter, Space) would also fire while you write in Aurora or Discord: the app
warns you; prefer a function key (F1–F24) or a mouse side button.

- **Pre-roll** (default 10 s): markers are placed before the key press, since
  you usually notice a moment after it happens.
- **Categories** (optional): Phraseology, Separation, Coordination, Traffic
  management, Positive — rename, recolour, add your own. A marker can have
  several categories (e.g. Phraseology and Coordination): click the chips to
  add or remove them. A category hotkey adds that category to the latest
  marker, or removes it if the marker already has it. Removing a category
  hides it from the markers of recorded sessions (TRS asks first): rename it
  instead if you only want another name.
- A small always-on-top **status window** shows time, markers and dictation,
  on a monitor that isn't recorded, and is left out of the recording even if
  you drag it onto that monitor. It never takes focus from Aurora.

If Aurora runs **as administrator**, run TRS as administrator too: otherwise
Windows doesn't pass TRS the keys pressed in Aurora, nor lets TRS press keys
in it (the Companion's push-to-talk says so instead of pressing).

### Voice notes

In **Setup → Voice notes** choose the microphone (speak: the bar moves), the
language you dictate in (more reliable than automatic detection for short
notes) and the transcription model. Models are downloaded once:

| Model | Size | Notes |
|---|---|---|
| Base | 142 MB | fastest |
| Small | 466 MB | recommended |
| Large v3 Turbo | 547 MB | most accurate, slower on older CPUs |

Transcription runs on your PC: nothing is sent online. If Windows lacks the
Microsoft Visual C++ Redistributable it needs, Setup says so.

**English words in notes dictated in another language** (tower, approach,
readback, the ICAO alphabet…): the transcription is told to expect them, in
the language you dictate in. **Large v3 Turbo** gets them right much more
often than Small (about four times slower; notes are transcribed one at a
time in the background, without slowing OBS down). Add your own words in
**Words to recognise**: callsigns, fixes, SIDs, airports, or English words you
mix in, separated by commas (Latin letters only). Notes transcribed before a
change can be transcribed again from the sessions list; a note that gets no
text the second time keeps the one it had. A note without any sound (a button
pressed by mistake) stays without text instead of getting a made-up sentence.

**Muting yourself in Discord while you dictate.** Set your voice note key as
**Push to Mute** in Discord (User Settings → Keybinds): holding it for a note
also mutes you in the call. For notes dictated with the Companion's or the
app's **Hold to dictate** button, turn on **Also press … for notes started
from a button** in Setup → Voice notes: TRS then holds the key for you while
the note is recorded, so Discord mutes you there too. Like a real press, the
key also reaches the window in front. If TRS can't press it (the screen is
locked, or the window in front runs as administrator), the note is not started,
so it can't be heard in the call.

## 2. Recording a session

1. **Sessions → New session**: trainee VID (and name), position, session
   type (**Training** or **Exam**), your VID, date. Tick **The trainee and the
   other participants in the voice call have agreed to be recorded** — ask them
   first: recording can't start without it, and the confirmation (with the
   time and the terms version) is kept in the session's `session.json`. Turn on
   Do not disturb.
2. During the session:
   - **Marker** hotkey: screenshot + marker at the current moment (minus the
     pre-roll).
   - **Range** hotkey: press to start, press again to end.
   - **Voice note**: hold the key, speak, release. The note goes to the open
     range, or to the latest marker if placed within the last 60 s (setting),
     otherwise it creates a new marker.
   - Buttons on the recording page (and on the Companion) do the same.
   - Voice notes can't be played on the PC while recording (they would end up
     in the recording and the call): listen on a phone or tablet.
3. **Stop recording**. The session folder is named
   `<date>_<trainee VID>_<trainee name>_<position>_<session type>`, e.g.
   `2026-09-24_123456_Mario-Rossi_LIRF_APP_Training` (a second session with the
   same details ends in `-2`). It contains `recording.mp4`, `session.json`,
   `notes/` and the screenshots folder, named like the session with `_screen`
   at the end so you can share it on its own. Sessions recorded before v1.1
   keep their old names and `screenshots/`.

Sessions are saved in `Documents\IVAO TRS\Sessions`; change it in **Setup →
Sessions folder**. Existing sessions stay where they are: move their folders
into the new one if you want them in the list. If the folder is synchronised
with OneDrive (Windows often does that with Documents), Setup warns you: the
recordings would be uploaded to the cloud. Choose a folder outside OneDrive.

While recording, the status window also shows how many voice notes are
waiting to be transcribed, and any problem with the recording.

If the connection to OBS drops during a session, TRS reconnects on its own for
a minute and carries on with the same session if OBS kept recording (markers
pressed while disconnected are lost); a message at the top says what happened.
If OBS itself stopped or crashed, the session is closed and its recording is
picked up from the session folder the next time you open it. A recording you
start in OBS itself never goes into a session's folder.

If the session file can't be saved at the end (disk full, a program holding
it), the markers and notes stay in the app and a message offers **Save again**:
close what holds the folder, then press it before quitting.

If the microphone is unplugged, TRS says so and switches to the Windows
default microphone, keeping what you already dictated; plugged back in, it is
used again. A voice note ends by itself after 3 minutes, or when its key is
up even if TRS missed the release. Locking the PC or putting it to sleep
releases every key TRS holds. Shutting Windows down stops and saves the
recording first.

## 3. Debriefing

**Sessions → Review** opens the player. This window never shows your notes,
so you can share it on Discord (share the TRS window, not your whole screen).

| Key | Action |
|---|---|
| Space / K | play / pause |
| ← → | 5 s back / forward (Shift: 30 s) |
| J L | 10 s back / forward |
| [ ] or Page Up / Down | previous / next marker |
| mouse wheel, + − | zoom at the cursor; drag to move |
| 0 or double-click | reset zoom |
| F | full window (Esc to exit) |

The buttons under the video also jump 5 or 10 s, and set the speed from 0.5×
to 10× (5× and 10× to skim through quiet parts; the sound keeps playing at
every speed).

Zooming in on a label keeps it readable even through Discord's compression
(720p without Nitro).

### Notes window and Companion

Your notes live in the **Companion** view: the current marker with its notes
and transcriptions, all markers, category chips, player controls and speed,
and buttons to adjust a marker to the current position ("Start at / End at").

- **Notes window** (Review page or Setup → Companion): the Companion in a
  window on a monitor that is neither the TRS window's nor the recorded one.
  It is left out of screen captures, so it stays private even if it ends up on
  a shared or recorded screen. A voice note played there comes out of the PC:
  if you share TRS on Discord with its sound, the trainee hears it — listen on
  a tablet or phone instead. (**Open in browser** has no protection from
  captures: keep that browser window off shared screens.)
- **Tablet or phone**: Setup → Companion → **Allow a tablet or phone on the
  same network**, then scan the QR code. Each link pairs one device, once;
  the device then stays paired (open the same address next time). TRS tells
  you whenever a device pairs. **Paired devices** in Setup → Companion lists
  them: remove one you lost or don't recognise; **Unpair all devices** removes
  them all.
- The **Companion** button in the top bar (shown while the Companion is
  enabled) opens the QR code from any page, with the count of connected
  devices. While a review is open the QR code stays hidden until you press
  **Show the QR code**, since that window may be shared on Discord.

The Companion shows the session being recorded or reviewed only: never your
other sessions. During a recording it also offers Marker, Range and
Hold-to-dictate buttons (the PC's microphone records the note; see "Muting
yourself in Discord" under Voice notes).

**Push-to-talk from the tablet or phone.** In Setup → Companion →
**Push-to-talk buttons**, set the key you talk with in your voice chat
(Discord…) and in Aurora — Right Ctrl, AltGr and the other modifier keys work
alone there; keys that would act on the window in front (Enter, Alt
combinations, Ctrl + a letter) are refused, and so is your voice-note key.
During a recording or a review the Companion shows a **Hold: Voice chat** and
a **Hold: Aurora** button: while you hold one, TRS holds that key on the PC,
and the button shows **Talking** only when the PC really does. Holding Aurora's
transmits on frequency in your name. The key is released when you let go, a
couple of seconds after the device stops answering (screen locked, Wi-Fi
lost), when the page goes to the background, when the recording or review
ends, and after 60 s (Aurora) or 5 minutes (voice chat) at the latest — then
let go of the button before pressing it again. While a key is held, a red bar
on the PC says which device holds it, with a **Release** button. Like a real
press, the key also reaches the window in front. In Discord, push-to-talk
works only with Input mode set to **Push to Talk** (User Settings → Voice &
Video).

#### Tablet doesn't connect?

- Same Wi-Fi as the PC.
- On your home network, the Windows network must be **Private**: Windows
  Settings → Network & internet → Wi-Fi → your network → Network profile type
  → **Private**. TRS warns you when it is Public — on a network that isn't
  yours (hotel, university), leave it Public and turn network access off.
- Windows Firewall must allow the app on **private networks**: when Windows
  asks, tick Private networks; or open *Allow an app through Windows Firewall*
  → Change settings → tick **Private** for the app.
- A page that stays loading (blank/black, with the browser's stop "X")
  means the connection is blocked: check the two points above.
- If the PC's address changes (router restart), scan the QR code again.

Use network access only on your home network, not on public Wi-Fi: the
Companion's connection is not encrypted.

## 4. Editing after the session

In Review (from the notes window or a tablet) you can change categories, edit
transcriptions (click the text), transcribe again, delete notes or markers,
and move a marker or a range's start/end to the current position. Changes are
saved immediately. Deleting asks once more ("Delete?"), and the screenshot and
audio files go to the Windows Recycle Bin; where there is none (a network
drive), the app says the files stayed in the session folder.

From the **⋯** menu of a session in the list:

- **Edit details…** — fix typos in the trainee VID or name, the position or the
  session type. The session folder and its screenshots folder are renamed to
  match (older sessions get the new folder names too). Close File Explorer
  windows showing the session first.
- **Transcribe voice notes again** — every note of the session, e.g. after
  downloading a better model. Text you edited by hand is kept.
- **Delete session…** — moves the session folder (recording, screenshots,
  notes) to the Windows Recycle Bin; restore it from there if needed. Empty
  the Recycle Bin to delete it for good.

TRS is a working tool, not an official record: markers, notes and details can
be changed afterwards and no history of changes is kept.

## 5. Removing TRS and its data

Uninstalling TRS (Windows Settings → Apps) removes the program only. What it
leaves, to delete yourself if you want:

- your sessions: the sessions folder (by default `Documents\IVAO TRS\Sessions`);
- its settings and transcription models (up to ~550 MB):
  `%APPDATA%\Training Recording System`;
- in OBS, the "IVAO TRS" profile and scene collection (Profile and Scene
  Collection menus → Remove);
- the Windows Firewall rule for the app, if you allowed it on private networks.
