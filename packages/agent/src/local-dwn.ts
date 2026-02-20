import type { Web5Rpc } from '@enbox/dwn-clients';

export const localDwnPortCandidates = [3000, 55555, 55556, 55557, 55558, 55559] as const;
const localDwnHostCandidates = ['127.0.0.1', 'localhost'] as const;

export type LocalDwnStrategy = 'prefer' | 'only' | 'off';

const localDwnServerName = '@enbox/dwn-server';

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export class LocalDwnDiscovery {
  private cachedEndpoint?: string;
  private cacheExpiry = 0;

  constructor(
    private rpcClient: Web5Rpc,
    private cacheTtlMs = 10_000
  ) {}

  public async getEndpoint(): Promise<string | undefined> {
    const now = Date.now();
    if (now < this.cacheExpiry) {
      return this.cachedEndpoint;
    }

    for (const port of localDwnPortCandidates) {
      for (const host of localDwnHostCandidates) {
        const endpoint = `http://${host}:${port}`;
        try {
          const serverInfo = await this.rpcClient.getServerInfo(endpoint);
          if (serverInfo.server === localDwnServerName) {
            this.cachedEndpoint = normalizeBaseUrl(endpoint);
            this.cacheExpiry = now + this.cacheTtlMs;
            return this.cachedEndpoint;
          }
        } catch {
          // keep probing candidate endpoints
        }
      }
    }

    this.cachedEndpoint = undefined;
    this.cacheExpiry = now + this.cacheTtlMs;
    return undefined;
  }
}
