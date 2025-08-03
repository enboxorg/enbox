import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import nodePolyfills from 'vite-plugin-node-stdlib-browser';
// https://vitejs.dev/config/
export default defineConfig({
    base: '/',
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    define: {
        global: "globalThis",
    },
    plugins: [
        svgr(),
        react(),
        nodePolyfills(),
        VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            registerType: "prompt",
            injectRegister: "auto",
            pwaAssets: {
                disabled: false,
                config: true,
            },
            manifest: {
                name: "DWeb Wallet",
                short_name: "DWW",
                description: "A Decentralized Web Wallet Reference",
                theme_color: "#ffec19",
            },
            injectManifest: {
                maximumFileSizeToCacheInBytes: 5000000,
                globPatterns: ["**/*.{js,css,html,json,svg,png,ico}"],
            },
            devOptions: {
                enabled: true,
                navigateFallback: "index.html",
                suppressWarnings: false,
                type: "module",
            },
        }),
    ]
});
