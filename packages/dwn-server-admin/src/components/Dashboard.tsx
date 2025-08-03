import React, { useState, useEffect, useCallback } from 'react';
import type { DashboardProps, Tenant, TenantDetails, ServerStats } from '../types.js';
import { ServerStats as ServerStatsComponent } from './ServerStats.js';
import { TenantsList } from './TenantsList.js';
import { TenantDetailsModal } from './TenantDetailsModal.js';

export const Dashboard: React.FC<DashboardProps> = ({ apiClient, onLogout }) => {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<TenantDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [statsData, tenantsData] = await Promise.all([
        apiClient.getStats(),
        apiClient.getTenants()
      ]);
      setStats(statsData);
      setTenants(tenantsData);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchData();
    // Refresh data every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleSelectTenant = async (tenant: Tenant) => {
    try {
      const details = await apiClient.getTenantDetails(tenant.did);
      setSelectedTenant(details);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch tenant details');
    }
  };

  const handleDeleteTenant = async (did: string) => {
    if (!confirm('Are you sure you want to delete this tenant? This action cannot be undone.')) {
      return;
    }

    try {
      await apiClient.deleteTenant(did);
      setSelectedTenant(null);
      await fetchData();
    } catch (err: any) {
      setError(err.message || 'Failed to delete tenant');
    }
  };

  if (loading && !stats) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-red-50 p-6 rounded-lg">
          <h2 className="text-red-800 text-xl font-semibold mb-2">Error</h2>
          <p className="text-red-600">{error}</p>
          <button
            onClick={fetchData}
            className="mt-4 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <h1 className="text-3xl font-bold text-gray-900">DWN Server Admin Dashboard</h1>
            <button
              onClick={onLogout}
              className="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700"
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Server Statistics</h2>
            {stats && <ServerStatsComponent stats={stats} />}
          </div>

          <div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-4">Registered Tenants</h2>
            <TenantsList
              tenants={tenants}
              onSelectTenant={handleSelectTenant}
              onRefresh={fetchData}
            />
          </div>
        </div>

        <div className="mt-8">
          <button
            onClick={fetchData}
            className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
          >
            Refresh All Data
          </button>
        </div>
      </div>

      {selectedTenant && (
        <TenantDetailsModal
          tenant={selectedTenant}
          onClose={() => setSelectedTenant(null)}
          onDelete={handleDeleteTenant}
        />
      )}
    </div>
  );
};