import { Component, type ReactNode } from 'react'
import { Alert, Button } from '@ivao/atmosphere-react'
import { CircleAlert } from 'lucide-react'

/**
 * A page that fails to render shows this instead of a blank window (from
 * which a review couldn't even be closed): the recording goes on in the
 * main process whatever happens here.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Page error', error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex flex-col gap-4">
        <Alert
          variant="destructive"
          Icon={CircleAlert}
          title="This page ran into a problem"
          description={`${this.state.error.message} A recording in progress is not affected.`}
        />
        <div>
          <Button
            onClick={() => {
              void window.api
                .closeReview()
                .catch(() => undefined)
                .finally(() => this.setState({ error: null }))
            }}
          >
            Back to the sessions
          </Button>
        </div>
      </div>
    )
  }
}
