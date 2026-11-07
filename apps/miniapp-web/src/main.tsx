import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.tsx'
import { ThemeToggle } from './components/ThemeToggle'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeToggle />
    <App />
  </StrictMode>,
)
