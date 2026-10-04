import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './AuthGate';
import './styles.css';
import './theme';
import './theme.css';
import './interface.css';
import './board-timer.css';
import './studio.css';


const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root element');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AuthGate><App /></AuthGate>
  </React.StrictMode>,
);
