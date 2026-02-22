import { render } from 'preact';
import './index.css';
import { App } from './components/App';

const root = document.getElementById('app');
if (!root) { throw new Error('Missing #app mount element'); }
render(<App />, root);
