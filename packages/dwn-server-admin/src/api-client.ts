import type { ServerStats, Tenant, TenantDetails } from './types.js';

// Admin API Client
export class AdminApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl?: string) {
    // Allow configuration via environment variable or parameter
    this.baseUrl = baseUrl || 
      (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}/admin${path}`, {
      ...options,
      headers,
      mode: 'cors',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async authenticate(secret: string): Promise<boolean> {
    try {
      const result = await this.request('/auth', {
        method: 'POST',
        body: JSON.stringify({ secret }),
      });
      
      this.token = result.token;
      return true;
    } catch (error) {
      console.error('Authentication failed:', error);
      return false;
    }
  }

  async getStats(): Promise<any> {
    return this.request('/stats');
  }

  async getTenants(): Promise<any[]> {
    return this.request('/tenants');
  }

  async getTenantDetails(did: string): Promise<any> {
    return this.request(`/tenants/${encodeURIComponent(did)}`);
  }

  async deleteTenant(did: string): Promise<void> {
    await this.request(`/tenants/${encodeURIComponent(did)}`, {
      method: 'DELETE',
    });
  }

  async clearAllData(confirmation: string): Promise<void> {
    await this.request('/clear-all-data', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    });
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  clearToken(): void {
    this.token = null;
  }
}