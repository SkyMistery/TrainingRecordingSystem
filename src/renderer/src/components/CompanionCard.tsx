import { useEffect, useState } from 'react'
import { Alert, Button, Input, Label, Switch } from '@ivao/atmosphere-react'
import { CircleAlert, ExternalLink, KeyRound, NotebookPen, QrCode, ShieldAlert } from 'lucide-react'
import type { AppState, CompanionInfo, CompanionSettings } from '@shared/types'
import { SetupSection, type SectionProps } from './SetupSection'

/**
 * QR code and link to pair a tablet or phone on the same network. While a
 * review is open the main window may be shared on Discord, and the link is a
 * secret: it stays hidden until the trainer asks for it.
 */
export function CompanionPairing({ info, concealed }: { info: CompanionInfo; concealed: boolean }): React.JSX.Element {
  const networkUrl = info.urls[1] ?? null
  const [revealed, setRevealed] = useState(false)
  // The network may have changed since the Companion started (Wi-Fi up later, new address).
  useEffect(() => {
    window.api.refreshCompanion().catch(() => undefined)
  }, [])
  if (concealed && !revealed) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p>The QR code is hidden while a review is open: this window may be shared on Discord.</p>
        <Button variant="outline" size="sm" onClick={() => setRevealed(true)}>
          <QrCode className="size-4" aria-hidden />
          Show the QR code
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-start gap-5">
      {info.qr && <img src={info.qr} alt="QR code to pair a device" className="size-48 rounded-md bg-white p-2" />}
      <div className="flex min-w-64 flex-1 flex-col gap-2 text-sm">
        <p>Scan the QR code with the tablet’s camera, or open this link on it:</p>
        {networkUrl ? (
          <code className="select-text break-all rounded-sm bg-fuselage-100 p-2 font-mono text-xs dark:bg-fuselage-800">
            {networkUrl}
          </code>
        ) : (
          <span className="text-semantic-red-600">No network connection found.</span>
        )}
        <p className="text-xs text-muted-foreground">
          The link contains a secret code: share it only with your own devices. Windows may ask to allow the app on
          private networks — allow it, or the tablet can’t connect.
        </p>
      </div>
    </div>
  )
}

export function CompanionCard({
  state,
  settings,
  section
}: {
  state: AppState
  settings: CompanionSettings
  section: SectionProps
}): React.JSX.Element {
  const info = state.companion
  const [port, setPort] = useState(String(settings.port))
  const [confirmReset, setConfirmReset] = useState(false)
  useEffect(() => setPort(String(settings.port)), [settings.port])

  const save = (patch: Partial<CompanionSettings>): void =>
    void window.api
      .saveCompanionSettings(patch)
      .catch((error: unknown) => console.error('Could not save the Companion settings', error))

  return (
    <SetupSection
      title="Companion"
      description={
        <>
          Your private view: notes, transcriptions and player controls, on another monitor or a tablet — while the
          review window is shared on Discord without them.
        </>
      }
      contentClassName="flex flex-col gap-5"
      {...section}
    >
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />
        Enable the Companion page
      </label>

      {settings.enabled && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void window.api.openNotesWindow()} disabled={!info.running}>
              <NotebookPen className="size-4" aria-hidden />
              Open notes window
            </Button>
            <Button variant="outline" onClick={() => void window.api.openCompanionInBrowser()} disabled={!info.running}>
              <ExternalLink className="size-4" aria-hidden />
              Open in browser
            </Button>
            <span className="self-center text-sm text-muted-foreground">
              {info.clients === 0 ? 'No device connected' : `${info.clients} connected`}
            </span>
          </div>

          <label className="flex items-center gap-3 text-sm">
            <Switch checked={settings.lan} onCheckedChange={(lan) => save({ lan })} />
            Allow a tablet or phone on the same network
          </label>

          {settings.lan && <CompanionPairing info={info} concealed={state.review !== null} />}

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="companion-port">Port</Label>
              <Input
                id="companion-port"
                className="w-28"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                onBlur={() => {
                  const value = Math.round(Number(port))
                  if (value >= 1024 && value <= 65535 && value !== settings.port) save({ port: value })
                  else setPort(String(settings.port))
                }}
              />
            </div>
            {confirmReset ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Unpair all devices?</span>
                <Button variant="outline" size="sm" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setConfirmReset(false)
                    void window.api.newCompanionToken()
                  }}
                >
                  Unpair
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
                <KeyRound className="size-4" aria-hidden />
                New pairing code
              </Button>
            )}
          </div>

          {settings.lan && info.publicNetwork && (
            <Alert
              variant="destructive"
              Icon={ShieldAlert}
              title="Your network is set to Public"
              description="Windows blocks tablets from connecting on Public networks. In Windows Settings → Network & internet → Wi-Fi (or Ethernet) → your network, set “Network profile type” to Private, then reopen this page."
            />
          )}
          {info.error && (
            <Alert variant="destructive" Icon={CircleAlert} title="Companion not running" description={info.error} />
          )}
          {settings.lan && (
            <Alert
              Icon={ShieldAlert}
              title="Local network only"
              description="Use it on your home network. On shared or public Wi-Fi, turn network access off."
            />
          )}
        </>
      )}
    </SetupSection>
  )
}
