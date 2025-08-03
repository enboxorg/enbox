/// <reference types="vite-plugin-svgr/client" />
/// <reference types="vite/client" />
import '@mui/material/IconButton';

interface ImportMetaEnv {
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}