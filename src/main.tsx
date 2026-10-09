import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/board.css';
import './styles/workspace.css';
import './styles/tools.css';
import './styles/debrief.css';
import { App } from './App';
import { ProgressProvider } from './state/progress';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProgressProvider>
      <App />
    </ProgressProvider>
  </StrictMode>,
);
