import { createRoot } from 'react-dom/client';
import StaffTrack from '../app/stafftrack';
import { browserApi, attachmentUrl } from './browser-api';
import '../app/globals.css';
import '../app/stafftrack.css';

createRoot(document.getElementById('root')!).render(<StaffTrack api={browserApi} attachmentUrl={attachmentUrl} local />);
