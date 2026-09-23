import { useEffect, useState } from 'react'
import { Header, type Page } from './components/Header'
import { useMarkerFeedbackSound } from './feedback'
import { useAppState } from './hooks'
import { RecordingPage } from './pages/RecordingPage'
import { ReviewPage } from './pages/ReviewPage'
import { SessionsPage } from './pages/SessionsPage'
import { SetupPage } from './pages/SetupPage'
import { useTheme } from './useTheme'

export function App(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [page, setPage] = useState<Page>('sessions')
  const { preference, setPreference } = useTheme()
  const state = useAppState()
  useMarkerFeedbackSound(state?.markerSettings.sound ?? false)

  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])

  const recording = state?.recording ?? null
  const review = recording ? null : (state?.review ?? null)

  return (
    <div className="flex h-full flex-col bg-body">
      <Header
        version={version}
        page={recording || review ? null : page}
        onNavigate={setPage}
        obsStatus={state?.obs.status ?? 'disconnected'}
        themePreference={preference}
        onThemeChange={setPreference}
      />
      <main className="flex-1 overflow-auto">
        <div className="container max-w-5xl py-8">
          {state &&
            (recording ? (
              <RecordingPage state={state} recording={recording} />
            ) : review ? (
              <ReviewPage key={review.folderName} state={state} review={review} />
            ) : page === 'setup' ? (
              <SetupPage state={state} />
            ) : (
              <SessionsPage state={state} onOpenSetup={() => setPage('setup')} />
            ))}
        </div>
      </main>
    </div>
  )
}
