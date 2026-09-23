import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { StatusView } from './StatusView'
import './styles/app.css'

// The status window loads the same bundle with #status.
const Root = window.location.hash === '#status' ? StatusView : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
