import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center items-center text-center flex-1 gap-6 py-20 px-6">
      <h1 className="text-4xl font-bold tracking-tight">
        en<span className="font-extrabold">b</span>ox docs
      </h1>
      <p className="text-fd-muted-foreground max-w-lg text-lg">
        Decentralised identity, data, and authentication for JavaScript and
        TypeScript.
      </p>
      <div className="flex flex-row gap-3">
        <Link
          href="/docs"
          className="inline-flex items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground px-5 py-2.5 text-sm font-medium transition-colors hover:opacity-90"
        >
          Get Started
        </Link>
        <a
          href="https://github.com/enboxorg/enbox"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-lg border border-fd-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
        >
          GitHub
        </a>
      </div>
    </div>
  );
}
