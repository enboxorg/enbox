import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { ServerStatsProps } from '../types.js';

export function ServerStats({ stats }: ServerStatsProps): JSX.Element {
  const memoryData = [
    { name: 'RSS', value: Math.round(stats.server.memory.rss / 1024 / 1024), unit: 'MB' },
    { name: 'Heap Used', value: Math.round(stats.server.memory.heapUsed / 1024 / 1024), unit: 'MB' },
    { name: 'External', value: Math.round(stats.server.memory.external / 1024 / 1024), unit: 'MB' },
  ];

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28'];

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
  };

  interface CustomLabelProps {
    name: string;
    value: number;
    unit: string;
  }

  const renderCustomLabel = ({ name, value, unit }: CustomLabelProps): string => {
    return `${name}: ${value}${unit}`;
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
                label={renderCustomLabel as any}
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