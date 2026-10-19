import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './transport/client';
import './devtools-ui/theme.css';

connect();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
