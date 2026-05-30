import React from 'react';
import ReactDOM from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { ThemeProvider } from '@/hooks/useTheme';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={150}>
        <App />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
