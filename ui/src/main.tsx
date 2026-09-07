import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Session } from './Session.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element (#root) not found in index.html');

createRoot(container).render(
  <StrictMode>
    <Session><App /></Session>
  </StrictMode>,
);
