const { useState, useEffect, useCallback } = React;
const { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } = Recharts;

// Admin API client
class AdminApiClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}/admin${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  getStats() {
    return this.request('/stats');
  }

  getMetrics() {
    return this.request('/metrics', {
      headers: { 'Accept': 'text/plain' }
    }).then(text => text);
  }

  getTenants() {
    return this.request('/tenants');
  }

  getTenantDetails(did) {
    return this.request(`/tenants/${encodeURIComponent(did)}`);
  }

  deleteTenant(did) {
    return this.request(`/tenants/${encodeURIComponent(did)}`, {
      method: 'DELETE',
    });
  }

  clearAllData(confirmation) {
    return this.request('/clear-all-data', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    });
  }
}

// Login Component
function LoginForm({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter an admin token');
      return;
    }
    onLogin(token.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            DWN Server Admin Dashboard
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Enter your admin token to access the dashboard
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="token" className="sr-only">Admin Token</label>
              <input
                id="token"
                name="token"
                type="password"
                autoComplete="current-password"
                required
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Admin Token (SHA256 hash of DWN_ADMIN_API_SECRET)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <div>
            <button
              type="submit"
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              Sign in
            </button>
          </div>
          
          <div className="text-sm text-gray-600">
            <p><strong>Note:</strong> The admin token is the SHA256 hash of your DWN_ADMIN_API_SECRET environment variable.</p>
            <p className="mt-2">If you haven't set one, the default token is:</p>
            <code className="block mt-1 p-2 bg-gray-100 rounded text-xs break-all">
              7c2b7b05359e25e3b0ecee0171d129e377ca27608c303585155511e363b10c07
            </code>
          </div>
        </form>
      </div>
    </div>
  );
}

// Server Stats Component
function ServerStats({ stats }) {
  const memoryData = [
    { name: 'RSS', value: Math.round(stats.server.memory.rss / 1024 / 1024), unit: 'MB' },
    { name: 'Heap Used', value: Math.round(stats.server.memory.heapUsed / 1024 / 1024), unit: 'MB' },
    { name: 'External', value: Math.round(stats.server.memory.external / 1024 / 1024), unit: 'MB' },
  ];

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28'];

  const formatUptime = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Server Statistics</h3>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Server Info</h4>
          <dl className="space-y-2">
            <div className="flex justify-between">
              <dt className="text-sm text-gray-600">Version:</dt>
              <dd className="text-sm font-medium">{stats.server.version}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-600">Uptime:</dt>
              <dd className="text-sm font-medium">{formatUptime(stats.server.uptime)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-600">WebSocket Support:</dt>
              <dd className="text-sm font-medium">{stats.server.config.webSocketSupport ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-sm text-gray-600">Registration Required:</dt>
              <dd className="text-sm font-medium">{stats.server.config.registrationRequired ? 'Yes' : 'No'}</dd>
            </div>
          </dl>
        </div>
        
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Memory Usage</h4>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={memoryData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, value, unit }) => `${name}: ${value}${unit}`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
              >
                {memoryData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mt-6">
        <h4 className="text-sm font-medium text-gray-700 mb-2">Storage Configuration</h4>
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-gray-600">Message Store:</dt>
            <dd className="font-mono text-gray-900 break-all">{stats.stores.messageStore}</dd>
          </div>
          <div>
            <dt className="text-gray-600">Data Store:</dt>
            <dd className="font-mono text-gray-900 break-all">{stats.stores.dataStore}</dd>
          </div>
          <div>
            <dt className="text-gray-600">Event Log:</dt>
            <dd className="font-mono text-gray-900 break-all">{stats.stores.eventLog}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// Tenants List Component
function TenantsList({ tenants, onSelectTenant, onRefresh }) {
  return (
    <div className="bg-white rounded-lg shadow">
      <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Registered Tenants</h3>
        <button
          onClick={onRefresh}
          className="text-sm text-indigo-600 hover:text-indigo-800"
        >
          Refresh
        </button>
      </div>
      
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                DID
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Terms of Service Hash
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {tenants.length === 0 ? (
              <tr>
                <td colSpan="4" className="px-6 py-4 text-center text-sm text-gray-500">
                  No tenants registered
                </td>
              </tr>
            ) : (
              tenants.map((tenant) => (
                <tr key={tenant.did} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">
                    {tenant.did}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {tenant.isActive ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                    {tenant.termsOfServiceHash ? tenant.termsOfServiceHash.substring(0, 16) + '...' : 'N/A'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => onSelectTenant(tenant)}
                      className="text-indigo-600 hover:text-indigo-900"
                    >
                      View Details
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Tenant Details Modal
function TenantDetailsModal({ tenant, onClose, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');

  const handleDelete = async () => {
    if (deleteInput === tenant.did) {
      await onDelete(tenant.did);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Tenant Details</h3>
        </div>
        
        <div className="p-6 space-y-4">
          <div>
            <h4 className="text-sm font-medium text-gray-700">DID</h4>
            <p className="mt-1 text-sm font-mono text-gray-900 break-all">{tenant.did}</p>
          </div>
          
          <div>
            <h4 className="text-sm font-medium text-gray-700">Status</h4>
            <p className="mt-1 text-sm text-gray-900">
              {tenant.isActive ? (
                <span className="text-green-600">Active</span>
              ) : (
                <span className="text-red-600">Inactive - {tenant.inactiveReason}</span>
              )}
            </p>
          </div>
          
          <div>
            <h4 className="text-sm font-medium text-gray-700">Terms of Service Hash</h4>
            <p className="mt-1 text-sm font-mono text-gray-900">{tenant.termsOfServiceHash || 'N/A'}</p>
          </div>
          
          {tenant.stats && (
            <div>
              <h4 className="text-sm font-medium text-gray-700">Statistics</h4>
              <dl className="mt-1 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-600">Message Count:</dt>
                  <dd className="font-medium">{tenant.stats.messageCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">Data Size:</dt>
                  <dd className="font-medium">{tenant.stats.dataSize}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-600">Last Activity:</dt>
                  <dd className="font-medium">{tenant.stats.lastActivity}</dd>
                </div>
              </dl>
            </div>
          )}
          
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full mt-4 bg-red-600 text-white py-2 px-4 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              Delete Tenant Data
            </button>
          ) : (
            <div className="mt-4 p-4 bg-red-50 rounded-md">
              <p className="text-sm text-red-800 mb-2">
                ⚠️ This action cannot be undone. Type the tenant DID to confirm:
              </p>
              <input
                type="text"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                placeholder={tenant.did}
                className="w-full px-3 py-2 border border-red-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleDelete}
                  disabled={deleteInput !== tenant.did}
                  className="flex-1 bg-red-600 text-white py-2 px-4 rounded-md hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => {
                    setConfirmDelete(false);
                    setDeleteInput('');
                  }}
                  className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-md hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="bg-gray-200 text-gray-800 py-2 px-4 rounded-md hover:bg-gray-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Main Dashboard Component
function Dashboard({ apiClient }) {
  const [stats, setStats] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

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
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDeleteTenant = async (did) => {
    try {
      await apiClient.deleteTenant(did);
      await fetchData();
    } catch (err) {
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
            <ServerStats stats={stats} />
            
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
            onSelectTenant={setSelectedTenant}
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

// Main App Component
function App() {
  const [token, setToken] = useState(() => localStorage.getItem('adminToken'));
  const [apiClient, setApiClient] = useState(null);

  const handleLogin = async (adminToken) => {
    const client = new AdminApiClient(window.location.origin, adminToken);
    
    try {
      // Test the token by making a request
      await client.getStats();
      
      // Token is valid, save it
      localStorage.setItem('adminToken', adminToken);
      setToken(adminToken);
      setApiClient(client);
    } catch (err) {
      alert(`Login failed: ${err.message}`);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setToken(null);
    setApiClient(null);
  };

  useEffect(() => {
    if (token && !apiClient) {
      handleLogin(token);
    }
  }, [token]);

  if (!apiClient) {
    return <LoginForm onLogin={handleLogin} />;
  }

  return (
    <>
      <Dashboard apiClient={apiClient} />
      <button
        onClick={handleLogout}
        className="fixed bottom-4 right-4 bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700"
      >
        Logout
      </button>
    </>
  );
}

// Render the app
ReactDOM.render(<App />, document.getElementById('root'));