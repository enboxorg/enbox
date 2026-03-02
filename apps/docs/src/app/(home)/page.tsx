import Link from 'next/link';

function EnboxMark() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Enbox"
    >
      <rect x="4" y="4" width="20" height="20" rx="4" stroke="#545d69" strokeWidth="1.5" fill="none" />
      <rect x="10" y="10" width="20" height="20" rx="4" stroke="#78828f" strokeWidth="1.5" fill="none" />
      <rect x="16" y="16" width="20" height="20" rx="4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="26" cy="26" r="2.5" fill="currentColor" />
    </svg>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-2 p-5 rounded-xl border border-fd-border bg-fd-card text-left">
      <h3 className="text-sm font-semibold text-fd-card-foreground">{title}</h3>
      <p className="text-sm text-fd-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="flex flex-col items-center flex-1 px-6">
      {/* Hero */}
      <div className="flex flex-col items-center text-center gap-6 pt-24 pb-16 max-w-2xl">
        <EnboxMark />
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          en<span className="font-extrabold">b</span>ox
        </h1>
        <p className="text-fd-muted-foreground max-w-lg text-lg leading-relaxed">
          A TypeScript SDK for decentralised identity and personal data storage.
          Your users own their data. You build the experience.
        </p>
        <div className="flex flex-row gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground px-6 py-2.5 text-sm font-medium transition-colors hover:opacity-90"
          >
            Get Started
          </Link>
          <a
            href="https://github.com/enboxorg/enbox"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>
      </div>

      {/* Install */}
      <div className="w-full max-w-lg pb-12">
        <pre className="rounded-xl border border-fd-border bg-fd-card px-5 py-4 text-sm font-mono text-fd-card-foreground overflow-x-auto">
          <span className="text-fd-muted-foreground select-none">$ </span>npm install @enbox/api @enbox/auth
        </pre>
      </div>

      {/* Code example */}
      <div className="w-full max-w-2xl pb-16">
        <div className="rounded-xl border border-fd-border bg-fd-card overflow-hidden">
          <div className="px-5 py-3 border-b border-fd-border">
            <span className="text-xs font-mono text-fd-muted-foreground">example.ts</span>
          </div>
          <pre className="px-5 py-4 text-sm font-mono text-fd-card-foreground overflow-x-auto leading-relaxed">
{`import { AuthManager } from '@enbox/auth';
import { Enbox, defineProtocol } from '@enbox/api';

// Define a typed protocol
const Notes = defineProtocol({
  protocol:  'https://example.com/notes',
  published: true,
  types:     { note: { schema: 'https://example.com/note', dataFormats: ['application/json'] } },
  structure: { note: {} },
});

// Authenticate and connect
const auth = await AuthManager.create();
const session = await auth.connect();
const enbox = Enbox.connect({ session });

// Full CRUD with type safety
const notes = enbox.using(Notes);
await notes.configure();

// Create
const { record } = await notes.records.create('note', {
  data: { title: 'First note', body: 'Hello from Enbox!' },
});

// Read
const text = await record.data.json();

// Update
await record.update({ data: { title: 'Updated note', body: 'Changed.' } });

// Query
const { records } = await notes.records.query('note');

// Delete
await record.delete();`}
          </pre>
        </div>
      </div>

      {/* Features */}
      <div className="w-full max-w-3xl pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <FeatureCard
            title="Decentralised Identity"
            description="DID-based identity that users own. No central account server. Supports did:dht, did:jwk, did:key, and did:web."
          />
          <FeatureCard
            title="Personal Data Vaults"
            description="Data stored in Decentralized Web Nodes. Users choose where their data lives. Sync across devices automatically."
          />
          <FeatureCard
            title="Type-Safe Protocols"
            description="Define DWN protocols with TypeScript types. Compile-time checks for paths, schemas, and record data."
          />
          <FeatureCard
            title="End-to-End Encryption"
            description="Records encrypted with ECDH-ES+A256KW key agreement and AES-256-GCM content encryption. Per-protocol encryption policies."
          />
          <FeatureCard
            title="Multi-Identity"
            description="Multiple identities in a single vault. Switch between them, export for backup, recover from a 12-word phrase."
          />
          <FeatureCard
            title="Self-Hostable Server"
            description="Run your own DWN server with PostgreSQL, MySQL, or SQLite. Rate limiting, quotas, admin dashboard included."
          />
        </div>
      </div>
    </div>
  );
}
