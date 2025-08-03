import type { ServerStats, Tenant, TenantDetails } from './types.js';

export class AdminApiClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/admin${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      let error: { error?: string } = { error: 'Unknown error' };
      try {
        error = await response.json();
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    // Handle text responses (like metrics)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/plain')) {
      return response.text() as unknown as T;
    }

    return response.json();
  }

  async getStats(): Promise<ServerStats> {
    return this.request<ServerStats>('/stats');
  }

  async getMetrics(): Promise<string> {
    return this.request<string>('/metrics', {
      headers: { 'Accept': 'text/plain' }
    });
  }

  async getTenants(): Promise<Tenant[]> {
    return this.request<Tenant[]>('/tenants');
  }

  async getTenantDetails(did: string): Promise<TenantDetails | null> {
    try {
      return await this.request<TenantDetails>(`/tenants/${encodeURIComponent(did)}`);
    } catch (error: any) {
      if (error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async deleteTenant(did: string): Promise<void> {
    await this.request<void>(`/tenants/${encodeURIComponent(did)}`, {
      method: 'DELETE',
    });
  }

  async clearAllData(confirmation: string): Promise<void> {
    await this.request<void>('/clear-all-data', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    });
  }
}