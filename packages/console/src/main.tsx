import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './transport/client';
import './devtools-ui/theme.css';
import './devtools-ui/field.css';
import './devtools-ui/tag.css';
import './devtools-ui/dot.css';

connect();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
