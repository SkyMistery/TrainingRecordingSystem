import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AudioView } from './AudioView'
import { StatusView } from './StatusView'
import './styles/app.css'

// The status and hidden microphone windows load the same bundle with a hash.
const Root = window.location.hash === '#status' ? StatusView : window.location.hash === '#audio' ? AudioView : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
