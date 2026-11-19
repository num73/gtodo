import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import StickyNoteWindow from './notes/StickyNoteWindow';
import PomodoroWindow from './pomodoro/PomodoroWindow';
import './styles.css';
import './responsive.css';
import './notes/notes.css';
import './pomodoro/pomodoro.css';
import './components/document-editor.css';
import type { DesktopAPI } from './shared/model';

declare global { interface Window { gtodo?: DesktopAPI } }

const parameters = new URLSearchParams(window.location.search);
const noteId = parameters.get('note');
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{noteId ? <StickyNoteWindow id={noteId} /> : parameters.get('window') === 'pomodoro' ? <PomodoroWindow /> : <App />}</React.StrictMode>);
