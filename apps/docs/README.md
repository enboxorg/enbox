# Enbox documentation site

Public documentation site for Enbox. Built with **Fumadocs + Next.js**, deployed as a static export to **Cloudflare Pages** at <https://enbox-docs.pages.dev> (future: `docs.enbox.id`).

Read this when:

- You're editing MDX under `apps/docs/content/docs/`.
- You're changing the Fumadocs theme, layout, or design tokens.
- The docs deploy fails and you need to reproduce the build locally.
- You're adding a new section and need to wire it into the sidebar.

The docs site is **excluded** from the monorepo-wide `bun run build`, `bun run lint`, and `bun run test:node` commands. It uses **Biome** (not ESLint) and **Next.js** (not esbuild) — so the root linter rules in [`../../AGENTS.md`](../../AGENTS.md) do not apply here.

## Build & dev

```bash
bun run docs:dev        # Dev server on localhost:3000
bun run docs:build      # Static export to apps/docs/out/
```

## Content

- `content/docs/` — MDX files (guides + API reference).
- Sidebar ordering via `meta.json` files in each directory.
- Fumadocs MDX components available: `<Cards>`, `<Card>`, `<Callout>`, `<Steps>`, `<Tabs>`.

## Design system

The Fumadocs theme is overridden in `src/app/global.css` to map `--color-fd-*` CSS variables to Enbox design tokens. Dark mode is default. Fonts: Inter + JetBrains Mono.

## Deployment

CI workflow `.github/workflows/docs-deploy.yml` triggers on changes to `apps/docs/`, `docs/`, or `packages/*/src/**`. On push to `main`, it builds and deploys to Cloudflare Pages via `wrangler pages deploy`. Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
