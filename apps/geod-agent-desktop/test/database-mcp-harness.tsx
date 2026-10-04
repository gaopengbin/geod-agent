import { createRoot } from 'react-dom/client';
import { ExtensionStorePage } from '../src/extension-store';
import '../src/theme.css';
import '../src/styles.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')??'light';
createRoot(document.getElementById('root')!).render(<main style={{height:'100vh',display:'grid',gridTemplateColumns:'0px minmax(0,1fr)'}}><ExtensionStorePage active conversationId="database-connector-ui-check" /></main>);
