# Browser dapp architecture — what an Enbox web app must ship

Every Enbox browser app that has shipped so far — the web wallet and every
downstream dapp — has converged on the same runtime shape, and most of them
got one part of it wrong on their first deploy: the service worker. This note
exists so the next app doesn't. It names the moving parts, says which are
**required** (and what silently breaks without them), and ends with the
checklist a new dapp should be scaffolded against.

The audience is anyone — human or agent — building a browser app on
`@enbox/browser`. If you read nothing else, read [the service worker
section](#the-service-worker-is-the-dweb-network-stack-required): it covers
the one omission that never shows up in a build, a test run, or a demo of the
happy path.

## The runtime shape

A browser dapp is three cooperating execution contexts over one origin:

```text
┌─ page ────────────────────────────────────────────────────────┐
│ app UI                                                        │
│ @enbox/browser: Enbox/agent, connect ceremony, sync engine    │
│ storage: level -> browser-level -> IndexedDB                  │
└──────────────┬────────────────────────────────────────────────┘
               │ fetch()/<img src> of DWN-addressed URLs (DRLs)
┌─ service worker ─────────────────────────────────────────────┐
│ activatePolyfills(): DRL fetch interception                  │
│ DID doc -> DWN endpoints -> record -> Response (+ TTL cache) │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTPS / WebSocket
┌─ network ────────────────────────────────────────────────────┐
│ DWN servers (JSON-RPC over @enbox/dwn-clients), did:dht      │
│ resolution, optional ephemeral relays                        │
└──────────────────────────────────────────────────────────────┘
```

The page owns identity, records, and sync. The service worker owns **DWeb
addressing** — it is the app's network stack for DWN-addressed resources, not
an offline nicety. The two communicate through nothing but the fetch boundary,
which is exactly why a missing worker degrades silently instead of erroring.

## The service worker is the DWeb network stack (required)

`activatePolyfills()` (`packages/browser/src/web-features.ts`) is misleadingly
named: it is not a compatibility shim. Called **inside a service worker**, it
installs a fetch interceptor for DRLs — Decentralized Resource Locators, URLs
that address a record through a DID:

```text
https://<origin>/https/dweb/did:dht:abc…/read/protocols/<base64-protocol>/avatar
```

The interceptor resolves the DID document, finds the `DecentralizedWebNode`
service endpoints, fetches the record from the tenant's DWN, and returns it as
an ordinary `Response`, with an optional TTL'd Cache API layer in front
(`onCacheCheck`). That is what lets a plain `<img src>`, `<video src>`, or
`fetch()` address a record on *someone else's* DWN with zero app-level
plumbing — the mechanism avatars, attachments, and shared media ride. Called
**from a page**, the same function registers the worker and additionally wires
DRL-aware link handling and loading-overlay styles.

### What breaks without it — and why nothing tells you

Without a registered worker, every DRL fetch leaves the app as a request for a
URL no server can answer and dies as an **ordinary network error**. Nothing
throws at the SDK boundary, nothing logs a missing subsystem, and everything
else — connect ceremony, record CRUD, sync, queries — works perfectly. The
symptom is "broken images" or "the link 404s", which reads like a content bug,
not like a missing network stack.

This is worth stating because the omission is now a *pattern*: apps keep
shipping their first build without the worker. The causes are consistent:

- the API is named "polyfills", which reads as optional legacy shims;
- the worker is typically delivered via `vite-plugin-pwa`, which frames it as
  PWA/offline tooling — the first thing an MVP cuts;
- no build, type-check, or test gate fails when it's missing, so nothing
  pushes back on the cut.

Treat the service worker exactly like the Node-globals bundler shims below:
foundation, not enhancement. **A browser dapp without it is not a working
Enbox app; it is an app that hasn't hit a DRL yet.**

### Wiring it

Two supported patterns:

**Zero-config (prototypes):** call `activatePolyfills()` at your page
entrypoint. In a page context it self-registers as a root worker (it locates
its own script via `document.currentScript.src` / `import.meta.url`; pass
`path` explicitly under a strict CSP). Fastest path to working DRLs; you give
up control of precaching and update lifecycle.

**Own worker + `injectManifest` (what every production app does):** write a
small `src/sw.ts` that calls `activatePolyfills()` in worker scope, and let
`vite-plugin-pwa` build and register it alongside a Workbox precache. This is
the wallet's pattern and the pattern of every known downstream dapp. Four
build traps come with it, all previously shipped as bugs:

1. **Worker format must be `iife`, not `es`.** The plugin's `registerSW.js`
   registers a *classic* worker; the default ES output leaves `import.meta` in
   the bundle, which is a parse error in a classic script — the worker is
   served but never evaluates, and registration fails after the fact.
2. **Raise the precache size cap** (`maximumFileSizeToCacheInBytes`, e.g.
   8 MiB). The agent bundle alone exceeds Workbox's 2 MiB default; here the
   large file *is* the app.
3. **Shim `process` in the worker bundle.** The page gets Node globals from
   the bundler plugin; the worker bundle does not. Prepend
   `if(typeof process==="undefined"){self.process={env:{},browser:true,emitWarning:function(){}};}`
   via a `renderChunk` plugin, or the worker throws at evaluation.
4. **Disable the plugin in dev** (`devOptions.enabled: false`). A worker that
   precaches during `vite dev` serves yesterday's bundle over today's HMR.
   Test DRL behavior against `vite build && vite preview`.

### Verifying it

A service worker can be served, and even registered, without ever running —
that failure mode has shipped green through complete CI runs. Verify
**behaviorally**, in a real browser: the registration exists, the worker
reaches `activated`, and `navigator.serviceWorker.controller` is non-null
after one reload. A DRL `<img>` rendering is the end-to-end proof.

## Bundler shims (required)

`@enbox/dwn-sdk-js` reaches for Node built-ins in the browser. A Vite app
needs both of these, and fails at **import time** without them (which looks
like a bundler bug, not a missing shim):

```ts
// vite.config.ts
import nodePolyfills from "vite-plugin-node-stdlib-browser";
export default defineConfig({
  define: { global: "globalThis" },
  plugins: [nodePolyfills(), /* … */],
});
```

## Storage (required, do not substitute)

In browsers, `level` resolves to `browser-level` over IndexedDB. This is a
requirement, not a default: IndexedDB is what makes concurrent writes safe
across tabs, workers, and the service worker on one origin. Do not swap in
SQLite-WASM or in-memory stores (see the browser storage rule in
[AGENTS.md](../../AGENTS.md)).

## Hosting headers — two that break the app silently

The client holds keys and decrypts in the page, so hardening headers are
right — but two obvious ones break Enbox flows with **no error anywhere**:

- **Never set `Cross-Origin-Opener-Policy: same-origin`.** The wallet connect
  ceremony is popup + `postMessage`; COOP severs the opener relationship for a
  cross-origin popup, so the wallet gets `window.opener === null` and its
  approval can never come back. The popup opens; the request never arrives.
  If you later need cross-origin isolation, it must be
  `same-origin-allow-popups`, re-tested by hand against the ceremony.
- **`Referrer-Policy: no-referrer` is also wrong.** The wallet's consent
  screen identifies the requesting site by origin;
  `strict-origin-when-cross-origin` (origin only, never the path) is the
  tightest policy the ceremony works under.

And one for the worker itself: serve `/sw.js` with
`Cache-Control: no-cache, no-store, must-revalidate`. A cached worker serves
stale code indefinitely and makes "I redeployed and nothing changed" an
unfalsifiable bug report. Hashed assets stay `immutable`; the HTML shell and
the worker never are.

## The checklist

A new Enbox browser dapp ships, from its first commit:

- [ ] a service worker calling `activatePolyfills()` (own `sw.ts` +
      `injectManifest` for anything beyond a prototype), with the four build
      traps handled;
- [ ] a behavioral service-worker check (registered → activated → controls
      the page) somewhere in its verification path;
- [ ] `vite-plugin-node-stdlib-browser` + `define: { global: "globalThis" }`;
- [ ] the browser Level/IndexedDB stack, untouched;
- [ ] headers: no COOP `same-origin`, referrer `strict-origin-when-cross-origin`,
      `/sw.js` never cached;
- [ ] `@enbox/browser` pinned, owning the transitive `@enbox/*` graph.
