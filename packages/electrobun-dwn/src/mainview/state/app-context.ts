import type { AppStore } from './app-store.js';

import { createContext } from '@lit/context';

export const appContext = createContext<AppStore>('app-store');
