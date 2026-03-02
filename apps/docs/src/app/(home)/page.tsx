'use client';

import Link from 'next/link';
import { useState } from 'react';

/* ------------------------------------------------------------------ */
/* Enbox mark — three overlapping rounded rects + central node        */
/* ------------------------------------------------------------------ */
function EnboxMark({ size = 56 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Enbox"
    >
      <rect x="4" y="4" width="20" height="20" rx="4" stroke="var(--enbox-gray-600)" strokeWidth="1.5" fill="none" />
      <rect x="10" y="10" width="20" height="20" rx="4" stroke="var(--enbox-gray-400)" strokeWidth="1.5" fill="none" />
      <rect x="16" y="16" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="26" cy="26" r="2.5" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Bun logo — small inline SVG                                        */
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
/* Copy button with check animation                                    */
/* ------------------------------------------------------------------ */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 transition-colors cursor-pointer"
      style={{
        background: 'var(--enbox-gray-800)',
        color: copied ? 'var(--enbox-gray-50)' : 'var(--enbox-gray-400)',
      }}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Install bar — pill shape, mono font, accent prompt, copy button    */
/* ------------------------------------------------------------------ */
function InstallBar({ command }: { command: string }) {
  return (
    <div
      className="inline-flex items-center gap-3 px-3 py-2 rounded-full font-mono text-sm max-w-full"
      style={{
        background: 'var(--enbox-gray-900)',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        color: 'var(--enbox-gray-100)',
      }}
    >
      <span className="select-none" style={{ color: 'var(--enbox-white)' }}>$</span>
      <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{command}</span>
      <CopyButton text={command} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Code block — terminal-style with dots and language badge            */
/* ------------------------------------------------------------------ */
function CodeBlock({ language, filename, children }: { language: string; filename?: string; children: string }) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--enbox-gray-900)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          background: 'var(--enbox-gray-850)',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#ff5f57' }} />
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#febc2e' }} />
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#28c840' }} />
          </div>
          {filename && (
            <span className="ml-2 font-mono text-xs" style={{ color: 'var(--enbox-gray-400)' }}>
              {filename}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-xs uppercase tracking-wider"
            style={{ color: 'var(--enbox-gray-500)', letterSpacing: '0.04em' }}
          >
            {language}
          </span>
          <CopyButton text={children} />
        </div>
      </div>
      <div className="p-6 overflow-x-auto">
        <pre
          className="font-mono text-sm leading-relaxed m-0"
          style={{ background: 'transparent', border: 'none', color: 'var(--enbox-gray-100)' }}
        >
          {children}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feature card — design system card pattern                           */
/* ------------------------------------------------------------------ */
function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div
      className="flex flex-col gap-4 p-8 rounded-2xl transition-all duration-200"
      style={{
        background: 'var(--enbox-gray-900)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.10)';
        e.currentTarget.style.boxShadow = '0 4px 24px rgba(0, 0, 0, 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <h3 className="text-lg font-semibold" style={{ color: 'var(--enbox-gray-50)' }}>{title}</h3>
      <p className="text-base leading-relaxed" style={{ color: 'var(--enbox-gray-300)' }}>{description}</p>
    </div>
  );
}

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
              color: 'var(--enbox-gray-50)',
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
              color: 'var(--enbox-gray-300)',
              maxWidth: '52ch',
              margin: '0 auto',
            }}
          >
            A TypeScript SDK for decentralised identity and personal data storage.
            Your users own their data. You build the experience.
          </p>

          {/* Actions */}
          <div className="flex items-center justify-center gap-4 flex-wrap mt-2">
            <Link
              href="/docs"
              className="inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium no-underline whitespace-nowrap transition-all duration-200"
              style={{
                padding: '12px 32px',
                background: 'var(--enbox-white)',
                color: 'var(--enbox-gray-950)',
                border: '1px solid var(--enbox-white)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = '0 4px 16px rgba(255, 255, 255, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              Get Started
            </Link>
            <a
              href="https://github.com/enboxorg/enbox"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium no-underline whitespace-nowrap transition-all duration-200"
              style={{
                padding: '12px 32px',
                background: 'transparent',
                color: 'var(--enbox-gray-50)',
                border: '1px solid rgba(255, 255, 255, 0.16)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--enbox-gray-850)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              GitHub
            </a>
          </div>

          {/* Install bar */}
          <div className="mt-4">
            <InstallBar command="bun add @enbox/api" />
          </div>

          {/* Bun note */}
          <p className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--enbox-gray-300)' }}>
            Built with <BunLogo size={20} /> Bun
          </p>
        </div>
      </section>

      {/* ---- Code example ---- */}
      <section
        className="w-full flex justify-center"
        style={{ padding: 'var(--enbox-section-padding, 48px) clamp(1.25rem, 5vw, 3rem)' }}
      >
        <div className="w-full" style={{ maxWidth: '720px' }}>
          <CodeBlock language="ts" filename="example.ts">
{`import { Enbox, defineProtocol } from '@enbox/api';

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
await record.delete();`}
          </CodeBlock>
        </div>
      </section>

      {/* ---- Section divider ---- */}
      <div className="w-full" style={{ maxWidth: '1080px', padding: '0 clamp(1.25rem, 5vw, 3rem)' }}>
        <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }} />
      </div>

      {/* ---- Features ---- */}
      <section
        className="w-full flex justify-center"
        style={{ padding: '80px clamp(1.25rem, 5vw, 3rem)' }}
      >
        <div className="w-full" style={{ maxWidth: '1080px' }}>
          <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
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
          </div>
        </div>
      </section>

    </div>
  );
}
