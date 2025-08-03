import type { Dwn } from '@enbox/dwn-sdk-js';
import type { Express, Request, Response, NextFunction } from 'express';
import type { RegistrationManager } from '../registration/registration-manager.js';
import type { DwnServerConfig } from '../config.js';

import express from 'express';
import { register } from 'prom-client';
import log from 'loglevel';
import { createHash } from 'crypto';
import { SqliteDialect, PostgresDialect, MysqlDialect } from '@enbox/dwn-sql-store';
import { Kysely } from 'kysely';

export interface AdminApiOptions {
  config: DwnServerConfig;
  dwn: Dwn;
  registrationManager?: RegistrationManager;
}

export class AdminApi {
  private config: DwnServerConfig;
  private dwn: Dwn;
  private registrationManager?: RegistrationManager;
  private adminToken: string;

  constructor(options: AdminApiOptions) {
    this.config = options.config;
    this.dwn = options.dwn;
    this.registrationManager = options.registrationManager;
    
    // Generate admin token from config or use default
    const adminSecret = this.config.adminApiSecret || 'default-admin-secret-change-me';
    this.adminToken = createHash('sha256').update(adminSecret).digest('hex');
    
    if (adminSecret === 'default-admin-secret-change-me') {
      log.warn('Using default admin secret - please set DWN_ADMIN_API_SECRET environment variable for production');
    }
  }

  /**
   * Authentication middleware for admin endpoints
   */
  private authenticate(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    if (token !== this.adminToken) {
      res.status(403).json({ error: 'Invalid admin token' });
      return;
    }

    next();
  }

  /**
   * Register admin routes on the Express app
   */
  public registerRoutes(app: Express): void {
    const adminRouter = express.Router();
    
    // Apply authentication to all admin routes
    adminRouter.use(this.authenticate.bind(this));

    // Server statistics endpoint
    adminRouter.get('/stats', async (_req: Request, res: Response) => {
      try {
        const stats = await this.getServerStats();
        res.json(stats);
      } catch (error) {
        log.error('Error getting server stats:', error);
        res.status(500).json({ error: 'Failed to retrieve server statistics' });
      }
    });

    // Metrics endpoint (Prometheus format)
    adminRouter.get('/metrics', async (_req: Request, res: Response) => {
      try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (error) {
        log.error('Error getting metrics:', error);
        res.status(500).json({ error: 'Failed to retrieve metrics' });
      }
    });

    // List tenants endpoint
    adminRouter.get('/tenants', async (_req: Request, res: Response) => {
      try {
        const tenants = await this.listTenants();
        res.json(tenants);
      } catch (error) {
        log.error('Error listing tenants:', error);
        res.status(500).json({ error: 'Failed to list tenants' });
      }
    });

    // Get tenant details endpoint
    adminRouter.get('/tenants/:did', async (req: Request, res: Response) => {
      try {
        const { did } = req.params;
        const details = await this.getTenantDetails(did);
        if (!details) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }
        res.json(details);
      } catch (error) {
        log.error('Error getting tenant details:', error);
        res.status(500).json({ error: 'Failed to retrieve tenant details' });
      }
    });

    // Delete tenant data endpoint
    adminRouter.delete('/tenants/:did', async (req: Request, res: Response) => {
      try {
        const { did } = req.params;
        await this.deleteTenantData(did);
        res.json({ message: 'Tenant data deleted successfully' });
      } catch (error) {
        log.error('Error deleting tenant data:', error);
        res.status(500).json({ error: 'Failed to delete tenant data' });
      }
    });

    // Clear all data endpoint (dangerous - requires additional confirmation)
    adminRouter.post('/clear-all-data', async (req: Request, res: Response) => {
      const { confirmation } = req.body;
      
      if (confirmation !== 'DELETE_ALL_DATA') {
        res.status(400).json({ 
          error: 'Confirmation required', 
          message: 'Send { "confirmation": "DELETE_ALL_DATA" } to confirm' 
        });
        return;
      }

      try {
        await this.clearAllData();
        res.json({ message: 'All data cleared successfully' });
      } catch (error) {
        log.error('Error clearing all data:', error);
        res.status(500).json({ error: 'Failed to clear all data' });
      }
    });

    // Mount admin router
    app.use('/admin', adminRouter);
  }

  /**
   * Get server statistics
   */
  private async getServerStats(): Promise<any> {
    const stats: any = {
      server: {
        version: this.config.serverName,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        config: {
          webSocketSupport: this.config.webSocketSupport,
          registrationRequired: !!this.config.registrationStoreUrl,
          baseUrl: this.config.baseUrl,
        }
      }
    };

    // Get tenant count if registration manager is available
    if (this.registrationManager) {
      const tenants = await this.listTenants();
      stats.tenants = {
        count: tenants.length,
        active: tenants.filter(t => t.isActive).length
      };
    }

    // Get store information
    stats.stores = {
      messageStore: this.config.messageStore,
      dataStore: this.config.dataStore,
      eventLog: this.config.eventLog,
      resumableTaskStore: this.config.resumableTaskStore
    };

    return stats;
  }

  /**
   * List all registered tenants
   */
  private async listTenants(): Promise<any[]> {
    if (!this.registrationManager || !this.config.registrationStoreUrl) {
      return [];
    }

    // Access the registration store database directly
    const url = new URL(this.config.registrationStoreUrl);
    let dialect;
    
    if (url.protocol === 'sqlite:' || url.protocol === 'sqlite3:') {
      dialect = new SqliteDialect({
        database: await import('better-sqlite3').then(m => m.default(url.pathname))
      });
    } else if (url.protocol === 'postgresql:' || url.protocol === 'postgres:') {
      const { Pool } = await import('pg');
      dialect = new PostgresDialect({
        pool: new Pool({ connectionString: this.config.registrationStoreUrl })
      });
    } else if (url.protocol === 'mysql:' || url.protocol === 'mysql2:') {
      const mysql = await import('mysql2');
      dialect = new MysqlDialect({
        pool: mysql.createPool(this.config.registrationStoreUrl)
      });
    } else {
      throw new Error(`Unsupported database protocol: ${url.protocol}`);
    }

    const db = new Kysely<any>({ dialect });
    
    try {
      const tenants = await db
        .selectFrom('registeredTenants')
        .selectAll()
        .execute();

      // Check if each tenant is active
      const tenantsWithStatus = await Promise.all(
        tenants.map(async (tenant) => {
          const checkResult = await this.registrationManager!.isActiveTenant(tenant.did);
          return {
            ...tenant,
            isActive: checkResult.isActiveTenant,
            inactiveReason: checkResult.detail
          };
        })
      );

      return tenantsWithStatus;
    } finally {
      await db.destroy();
    }
  }

  /**
   * Get detailed information about a specific tenant
   */
  private async getTenantDetails(did: string): Promise<any> {
    const tenants = await this.listTenants();
    const tenant = tenants.find(t => t.did === did);
    
    if (!tenant) {
      return null;
    }

    // Get message count for this tenant
    // Note: This is a simplified implementation - in practice you'd need to query the message store
    const details = {
      ...tenant,
      stats: {
        // These would require implementing count methods in the stores
        messageCount: 'Not implemented',
        dataSize: 'Not implemented',
        lastActivity: 'Not implemented'
      }
    };

    return details;
  }

  /**
   * Delete all data for a specific tenant
   */
  private async deleteTenantData(did: string): Promise<void> {
    // This is a simplified implementation
    // In practice, you would need to:
    // 1. Delete from message store
    // 2. Delete from data store
    // 3. Delete from event log
    // 4. Delete from registration store
    
    log.info(`Deleting data for tenant: ${did}`);
    
    // Note: The current store interfaces don't provide tenant-specific delete methods
    // This would require extending the store interfaces or implementing direct database access
    throw new Error('Tenant deletion not yet implemented - requires store interface extensions');
  }

  /**
   * Clear all data from all stores
   */
  private async clearAllData(): Promise<void> {
    log.warn('Clearing all data from all stores');
    
    // Get store instances from DWN
    const stores = (this.dwn as any).stores;
    
    if (stores?.messageStore) {
      await stores.messageStore.clear();
    }
    
    if (stores?.dataStore) {
      await stores.dataStore.clear();
    }
    
    if (stores?.eventLog) {
      await stores.eventLog.clear();
    }
    
    if (stores?.resumableTaskStore) {
      await stores.resumableTaskStore.clear();
    }
    
    log.info('All data cleared successfully');
  }
}