# Future proposals

Ideas discussed but not scheduled. They are kept here so they can be picked up
later without redesigning the app.

## Debriefing report

Generate a PDF or HTML report from a session: session metadata, markers in
chronological order with screenshot, time, category and transcribed note. It
could be sent to the trainee or archived after the debriefing.

## Native recording engine (without OBS)

The recorder is behind an interface (`Recorder`), with OBS as the first
implementation. A native implementation would:

- capture a display with the Windows Graphics Capture API;
- capture per-application audio with the WASAPI process loopback API
  (Windows 10 2004+), which requires a small native module;
- encode with a bundled FFmpeg (hardware encoders when available).

Markers, voice notes, review and companion would not change.

## Cloud archive

Optional upload of screenshots (or the whole session) to Google Drive, which is
where trainers archive material today.

## More UI languages

The UI strings are kept in a translation catalogue, so languages such as
Italian can be added without code changes.
