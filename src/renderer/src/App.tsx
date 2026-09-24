import { useEffect, useState } from 'react'
import { AppFooter } from './components/AppFooter'
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
        companion={
          state ? { info: state.companion, settings: state.companionSettings, reviewOpen: state.review !== null } : null
        }
      />
      <main className="flex flex-1 flex-col overflow-auto">
        {/* The review player uses the whole width: the recording is Full HD. */}
        <div className={review ? 'flex-1 px-6 py-4' : 'container max-w-5xl flex-1 py-8'}>
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
        <AppFooter version={version} />
      </main>
    </div>
  )
}
