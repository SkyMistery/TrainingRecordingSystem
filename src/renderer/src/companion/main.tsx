import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setMediaBase } from '@shared/media'
import { CompanionApp } from './CompanionApp'
import '../styles/app.css'

// Screenshots and voice notes come from the app's web server here.
setMediaBase('/media/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CompanionApp />
  </StrictMode>
)
