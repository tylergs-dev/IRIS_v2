import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { InboxWindow } from './InboxWindow'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

// One bundle, two windows. Main opens the inbox popout at `#inbox` (INBOX_HASH in the main
// process); everything else is the full app.
const isInboxWindow = window.location.hash === '#inbox'

createRoot(container).render(
  <StrictMode>{isInboxWindow ? <InboxWindow /> : <App />}</StrictMode>
)
