'use client';

import {
  EnboxMark,
  InstallBar,
  CodeBlock,
  FeatureCard,
  CardGrid,
  Divider,
  Button,
} from '@enbox/ui';

/* ------------------------------------------------------------------ */
/* Bun logo — small inline SVG (no equivalent in @enbox/ui)           */
/* ------------------------------------------------------------------ */
function BunLogo({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 70"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Bun"
    >
      <path
        d="M71.1 32.2C71.1 52 55.2 68.2 35.8 68.2S.5 52 .5 32.2c0-6.4 1.7-12.4 4.6-17.6C9.3 6.5 17.3 1 26.6 1c3.5 0 6.8.8 9.7 2.3a26 26 0 0 1 9.7-2.3c9.3 0 17.3 5.5 21.5 13.6 2.3 4.3 3.6 9.2 3.6 14.3v3.3Z"
        fill="#fbf0df"
        stroke="#000"
        strokeWidth="1.5"
      />
      <ellipse cx="22.5" cy="37.5" rx="4.5" ry="5.5" fill="#000" />
      <ellipse cx="40" cy="37.5" rx="4.5" ry="5.5" fill="#000" />
      <ellipse cx="23" cy="36" rx="1.5" ry="2" fill="#fff" />
      <ellipse cx="40.5" cy="36" rx="1.5" ry="2" fill="#fff" />
      <path d="M28 48c2.5 3 7.5 3 10 0" stroke="#000" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M27 14c-2-6 3-12 8-10M38 14c2-6-3-12-8-10M32.5 12c0-7 5-11 5-11" stroke="#3b6e2c" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Code example content                                                */
/* ------------------------------------------------------------------ */
const codeExample = `import { Enbox, defineProtocol } from '@enbox/api';

// Define a typed protocol
const Notes = defineProtocol({
  protocol:  'https://example.com/notes',
  published: true,
  types: {
    note: {
      schema:      'https://example.com/note',
      dataFormats: ['application/json'],
    },
  },
  structure: { note: {} },
});

// Connect and use the protocol
const enbox = Enbox.connect({ agent, connectedDid: did });
const notes = enbox.using(Notes);

// Create
const { record } = await notes.records.create('note', {
  data: { title: 'First note', body: 'Hello from Enbox!' },
});

// Read
const data = await record.data.json();

// Update
await record.update({
  data: { title: 'Updated note', body: 'Changed.' },
});

// Query
const { records } = await notes.records.query('note');

// Delete
await record.delete();`;

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */
export default function HomePage() {
  return (
    <div className="flex flex-col items-center flex-1">

      {/* ---- Hero ---- */}
      <section className="relative w-full flex flex-col items-center text-center pt-4 pb-8">
        <div className="flex flex-col items-center gap-6 w-full" style={{ maxWidth: '1080px', padding: '0 clamp(1.25rem, 5vw, 3rem)' }}>

          {/* Mark */}
          <div className="flex justify-center mb-4 pt-12">
            <EnboxMark size={64} />
          </div>

          {/* Title */}
          <h1
            className="font-bold tracking-tight"
            style={{
              fontSize: 'clamp(3rem, 6vw, 3.75rem)',
              lineHeight: '1.15',
              color: 'var(--text-primary)',
              maxWidth: '16ch',
              margin: '0 auto',
            }}
          >
            en<span className="font-extrabold">b</span>ox
          </h1>

          {/* Subtitle */}
          <p
            className="leading-snug"
            style={{
              fontSize: 'clamp(1.125rem, 2.5vw, 1.3125rem)',
              color: 'var(--text-secondary)',
              maxWidth: '52ch',
              margin: '0 auto',
            }}
          >
            A TypeScript SDK for decentralised identity and personal data storage.
            Your users own their data. You build the experience.
          </p>

          {/* Actions */}
          <div className="flex items-center justify-center gap-4 flex-wrap mt-2">
            <Button href="/docs" variant="primary" size="lg">
              Get Started
            </Button>
            <Button
              href="https://github.com/enboxorg/enbox"
              variant="secondary"
              size="lg"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </Button>
          </div>

          {/* Install bar */}
          <div className="mt-4">
            <InstallBar command="bun add @enbox/api" />
          </div>

          {/* Bun note */}
          <p className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Built with <BunLogo size={20} /> Bun
          </p>
        </div>
      </section>

      {/* ---- Code example ---- */}
      <section
        className="w-full flex justify-center"
        style={{ padding: '48px clamp(1.25rem, 5vw, 3rem)' }}
      >
        <div className="w-full" style={{ maxWidth: '720px' }}>
          <CodeBlock language="typescript">
            <pre><code>{codeExample}</code></pre>
          </CodeBlock>
        </div>
      </section>

      {/* ---- Divider ---- */}
      <div className="w-full" style={{ maxWidth: '1080px', padding: '0 clamp(1.25rem, 5vw, 3rem)' }}>
        <Divider />
      </div>

      {/* ---- Features ---- */}
      <section
        className="w-full flex justify-center"
        style={{ padding: '80px clamp(1.25rem, 5vw, 3rem)' }}
      >
        <div className="w-full" style={{ maxWidth: '1080px' }}>
          <CardGrid>
            <FeatureCard
              title="Decentralised Identity"
              description="DID-based identity that users own. No central account server. Supports did:dht, did:jwk, did:key, and did:web."
            />
            <FeatureCard
              title="Personal Data Vaults"
              description="Data stored in Decentralised Web Nodes. Users choose where their data lives. Sync across devices automatically."
            />
            <FeatureCard
              title="Type-Safe Protocols"
              description="Define DWN protocols with TypeScript types. Compile-time checks for paths, schemas, and record data."
            />
            <FeatureCard
              title="End-to-End Encryption"
              description="Records encrypted with ECDH key agreement and AES-256-GCM content encryption. Per-protocol encryption policies."
            />
            <FeatureCard
              title="Real-Time Subscriptions"
              description="LiveQuery provides an initial snapshot plus deduplicated change events. Connection lifecycle built in."
            />
            <FeatureCard
              title="Self-Hostable Server"
              description="Run your own DWN server with PostgreSQL, MySQL, or SQLite. Rate limiting, quotas, and admin dashboard included."
            />
          </CardGrid>
        </div>
      </section>

    </div>
  );
}
