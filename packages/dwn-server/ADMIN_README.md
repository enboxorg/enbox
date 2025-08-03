# DWN Server Admin Interface

The DWN Server Admin Interface provides a web-based dashboard for server operators to monitor statistics and manage their DWN server.

## Features

- **Server Statistics**: Real-time server metrics including uptime, memory usage, and configuration details
- **Tenant Management**: View registered tenants, check their status, and manage tenant data
- **Data Management**: Ability to remove specific tenant data or clear all server data
- **Secure Access**: Token-based authentication to ensure only authorized operators can access the interface

## Accessing the Admin Interface

1. Ensure the admin API is enabled (it's enabled by default)
2. Navigate to: `http://your-dwn-server:3000/admin-ui/`
3. Enter your admin token to log in

## Configuration

### Environment Variables

- `DWN_ADMIN_API_ENABLED`: Set to `'true'` to enable the admin interface (default: `true`)
- `DWN_ADMIN_API_SECRET`: Secret key used to generate the admin token (highly recommended to set in production)

### Generating Your Admin Token

The admin token is the SHA256 hash of your `DWN_ADMIN_API_SECRET`. You can generate it using:

```bash
echo -n "your-secret-here" | sha256sum
```

Or in Node.js:
```javascript
const crypto = require('crypto');
const secret = 'your-secret-here';
const token = crypto.createHash('sha256').update(secret).digest('hex');
console.log(token);
```

**⚠️ Important**: If you don't set `DWN_ADMIN_API_SECRET`, a default value will be used. The default token is:
```
7c2b7b05359e25e3b0ecee0171d129e377ca27608c303585155511e363b10c07
```

**Always set a custom secret in production!**

## API Endpoints

All admin API endpoints require Bearer token authentication:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" http://localhost:3000/admin/stats
```

### Available Endpoints

- `GET /admin/stats` - Server statistics and configuration
- `GET /admin/metrics` - Prometheus-format metrics
- `GET /admin/tenants` - List all registered tenants
- `GET /admin/tenants/:did` - Get details for a specific tenant
- `DELETE /admin/tenants/:did` - Delete all data for a specific tenant
- `POST /admin/clear-all-data` - Clear all server data (requires confirmation)

### Example: Get Server Stats

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:3000/admin/stats
```

Response:
```json
{
  "server": {
    "version": "@enbox/dwn-server",
    "uptime": 3600,
    "memory": {
      "rss": 104857600,
      "heapTotal": 52428800,
      "heapUsed": 41943040,
      "external": 2097152
    },
    "config": {
      "webSocketSupport": true,
      "registrationRequired": true,
      "baseUrl": "http://localhost:3000"
    }
  },
  "tenants": {
    "count": 5,
    "active": 4
  },
  "stores": {
    "messageStore": "level://data",
    "dataStore": "level://data",
    "eventLog": "level://data",
    "resumableTaskStore": "level://data"
  }
}
```

### Example: Delete Tenant Data

```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:3000/admin/tenants/did:example:123
```

### Example: Clear All Data

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "DELETE_ALL_DATA"}' \
  http://localhost:3000/admin/clear-all-data
```

## Security Considerations

1. **Always set a custom `DWN_ADMIN_API_SECRET` in production**
2. Use HTTPS in production to protect the admin token in transit
3. Consider implementing IP whitelisting or additional authentication layers
4. Regularly rotate your admin secret
5. Monitor access logs for unauthorized access attempts

## Limitations

- Tenant deletion is not fully implemented yet - it requires extending the DWN store interfaces
- Some statistics (like message count per tenant) are placeholders pending store interface updates
- The admin UI requires JavaScript to be enabled in the browser

## Future Enhancements

- Real-time metrics and graphs
- Batch tenant operations
- Audit logging for admin actions
- Role-based access control
- Export/import functionality
- Automated backups