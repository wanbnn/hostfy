import React from 'react'
import {createRoot} from 'react-dom/client'

// Primer design tokens (base + functional) and the dark color theme.
import '@primer/primitives/dist/css/primitives.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'

import './fonts.css'
import './styles.css'
import './ai-builder.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)