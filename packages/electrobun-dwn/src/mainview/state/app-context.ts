import { createContext } from '@lit/context';
import type { AppStore } from './app-store.js';

export const appContext = createContext<AppStore>('app-store');
