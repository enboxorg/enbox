import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name       : 'electrobun-dwn',
    identifier : 'org.enbox.electrobun-dwn',
    version    : '0.0.1',
    urlSchemes : ['dwn'],
  },
  build: {
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.ts',
      },
    },
    copy: {
      'src/mainview/index.html' : 'views/mainview/index.html',
      'src/mainview/index.css'  : 'views/mainview/index.css',
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
