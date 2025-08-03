# Deploy Enbox with Railway Template

This guide explains how to set up Enbox as a Railway template for one-click deployment.

## For Repository Maintainers

### Step 1: Submit Your Template to Railway

1. Ensure your `railway-template.json` is in the repository root
2. Submit your template at: https://railway.app/submit-template
3. Fill out the form:
   - **Template Name**: Enbox - DWN Server Platform
   - **Repository URL**: https://github.com/enboxorg/enbox
   - **Description**: Deploy a complete DWN server with web wallet and demo apps
   - **Category**: Web3 / Decentralized

### Step 2: Get Your Template URL

Once approved, Railway will provide you with:
- A template URL: `https://railway.app/template/enbox`
- A referral code (optional) for credits

### Step 3: Update the Deploy Button

Update the README.md with your actual template URL:

```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/enbox)
```

## For Users: One-Click Deployment

### Step 1: Click Deploy

Click the "Deploy on Railway" button in the README.

### Step 2: Configure Your Deployment

Railway will prompt you to:
1. **Connect your GitHub account** (if not already connected)
2. **Name your project** (e.g., "my-enbox-instance")
3. **Set the PostgreSQL password** (auto-generated or custom)

### Step 3: Deploy

Click "Deploy" and Railway will:
- Fork the repository to your GitHub account (optional)
- Create all four services (dwn-server, web-wallet, dapp-demo, postgres)
- Configure all environment variables automatically
- Set up the database connections
- Deploy everything

### Step 4: Access Your Services

After deployment (typically 5-10 minutes), you'll have:
- **DWN Server**: `https://dwn-server-<project-name>.up.railway.app`
- **Web Wallet**: `https://web-wallet-<project-name>.up.railway.app`
- **Demo App**: `https://dapp-demo-<project-name>.up.railway.app`

## What Gets Deployed

The template automatically sets up:

1. **DWN Server**
   - Dockerfile-based deployment
   - Connected to PostgreSQL
   - All storage configurations
   - WebSocket support enabled

2. **Web Wallet**
   - Static site deployment
   - Connected to your DWN server
   - Built with Vite

3. **Demo App**
   - Static site deployment
   - Connected to your DWN server
   - Example implementation

4. **PostgreSQL Database**
   - Version 15
   - Persistent storage
   - Automatic backups (based on your Railway plan)

## Post-Deployment Configuration

### Custom Domain (Optional)
1. Go to each service's Settings
2. Add your custom domain
3. Update DNS records as instructed

### Environment Variables
All critical environment variables are pre-configured. To modify:
1. Go to the service in Railway dashboard
2. Click on "Variables"
3. Update as needed

### Scaling
To scale any service:
1. Go to the service settings
2. Adjust the number of replicas
3. Modify resource allocations

## Troubleshooting

### Build Failures
- Check the deploy logs for each service
- Ensure the repository structure hasn't changed
- Verify all dependencies are properly defined

### Connection Issues
- Verify environment variables are set correctly
- Check that all services are running
- Look at the network logs in Railway dashboard

### Database Issues
- Ensure PostgreSQL is running
- Check connection strings in environment variables
- Verify database migrations completed

## Alternative: Manual Import

If the template isn't available yet, users can still deploy manually:

1. Fork this repository
2. Create a new Railway project
3. Add services manually as described in `RAILWAY_MULTI_SERVICE.md`
4. Configure environment variables

While this takes more steps, it provides the same end result.

## Support

- **Railway Documentation**: https://docs.railway.app
- **Enbox Issues**: https://github.com/enboxorg/enbox/issues
- **Railway Discord**: https://discord.gg/railway