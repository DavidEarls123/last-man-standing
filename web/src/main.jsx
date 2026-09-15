import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './auth.jsx';
import { PlatformProvider } from './platform.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlatformProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
      </PlatformProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
