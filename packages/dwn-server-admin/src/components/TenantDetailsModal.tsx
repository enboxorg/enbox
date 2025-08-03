import React, { useState } from 'react';
import type { TenantDetailsModalProps } from '../types.js';

export function TenantDetailsModal({ tenant, onClose, onDelete }: TenantDetailsModalProps): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');

  const handleDelete = async (): Promise<void> => {
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