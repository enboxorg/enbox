import React, { useState, useEffect, useCallback } from 'react';
import type { DashboardProps, ServerStats, Tenant, TenantDetails } from '../types.js';
import { ServerStats as ServerStatsComponent } from './ServerStats.js';
import { TenantsList } from './TenantsList.js';
import { TenantDetailsModal } from './TenantDetailsModal.js';

type TabType = 'overview' | 'tenants';

export function Dashboard({ apiClient }: DashboardProps): JSX.Element {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<TenantDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [statsData, tenantsData] = await Promise.all([
        apiClient.getStats(),
        apiClient.getTenants(),
      ]);
      setStats(statsData);
      setTenants(tenantsData);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleSelectTenant = async (tenant: Tenant): Promise<void> => {
    try {
      const details = await apiClient.getTenantDetails(tenant.did);
      if (details) {
        setSelectedTenant(details);
      }
    } catch (err: any) {
      alert(`Failed to get tenant details: ${err.message}`);
    }
  };

  const handleDeleteTenant = async (did: string): Promise<void> => {
    try {
      await apiClient.deleteTenant(did);
      await fetchData();
    } catch (err: any) {
      alert(`Failed to delete tenant: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-red-600">Error: {error}</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">No data available</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900">DWN Server Admin Dashboard</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <nav className="flex space-x-4">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-2 rounded-md text-sm font-medium ${
                activeTab === 'overview'
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('tenants')}
              className={`px-3 py-2 rounded-md text-sm font-medium ${
                activeTab === 'tenants'
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Tenants {tenants.length > 0 && `(${tenants.length})`}
            </button>
          </nav>
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-6">
            <ServerStatsComponent stats={stats} />
            
            {stats.tenants && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Tenant Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-gray-900">{stats.tenants.count}</div>
                    <div className="text-sm text-gray-600">Total Tenants</div>
                  </div>
                  <div className="bg-green-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-green-600">{stats.tenants.active}</div>
                    <div className="text-sm text-gray-600">Active Tenants</div>
                  </div>
                  <div className="bg-red-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-red-600">{stats.tenants.count - stats.tenants.active}</div>
                    <div className="text-sm text-gray-600">Inactive Tenants</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'tenants' && (
          <TenantsList
            tenants={tenants}
            onSelectTenant={handleSelectTenant}
            onRefresh={fetchData}
          />
        )}

        {selectedTenant && (
          <TenantDetailsModal
            tenant={selectedTenant}
            onClose={() => setSelectedTenant(null)}
            onDelete={handleDeleteTenant}
          />
        )}
      </main>
    </div>
  );
}