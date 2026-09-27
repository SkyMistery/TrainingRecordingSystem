import { useState } from 'react'
import { Alert, Button } from '@ivao/atmosphere-react'
import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { AppNotice } from '@shared/types'

const ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info }

/** Something the trainer must see on any page (a save that failed, OBS lost…), until dismissed. */
export function NoticeBanner({ notice }: { notice: AppNotice }): React.JSX.Element {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <Alert
        variant={notice.kind === 'info' ? 'default' : 'destructive'}
        Icon={ICONS[notice.kind]}
        title={notice.title}
        description={error ? `${notice.message} ${error}` : notice.message}
      />
      <div className="flex justify-end gap-2">
        {notice.retry && (
          <Button
            size="sm"
            isLoading={retrying}
            onClick={() => {
              setRetrying(true)
              setError(null)
              window.api
                .retryNotice()
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setRetrying(false))
            }}
          >
            Save again
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void window.api.dismissNotice().catch(() => undefined)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
