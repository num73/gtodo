import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import StickyNoteWindow from './notes/StickyNoteWindow';
import './styles.css';
import './responsive.css';
import './notes/notes.css';
import './pomodoro/pomodoro.css';
import type { DesktopAPI } from './shared/model';

declare global { interface Window { gtodo?: DesktopAPI } }

const noteId = new URLSearchParams(window.location.search).get('note');
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{noteId ? <StickyNoteWindow id={noteId} /> : <App />}</React.StrictMode>);
