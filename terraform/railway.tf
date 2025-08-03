terraform {
  required_providers {
    railway = {
      source  = "railway-app/railway"
      version = "~> 0.1"
    }
  }
}

provider "railway" {
  token = var.railway_token
}

resource "railway_project" "enbox" {
  name = "enbox-monorepo"
}

resource "railway_service" "dwn_server" {
  project_id = railway_project.enbox.id
  name       = "dwn-server"
  
  source = {
    repo = "github.com/your-org/enbox"
    branch = "main"
  }
  
  builder = "dockerfile"
  dockerfile_path = "packages/dwn-server/Dockerfile"
  
  environment_variables = {
    DS_PORT                     = "${{PORT}}"
    DWN_BASE_URL               = "https://${{RAILWAY_PUBLIC_DOMAIN}}"
    DWN_TTL_CACHE_URL          = "${{Postgres.DATABASE_URL}}"
    DWN_STORAGE_MESSAGES       = "${{Postgres.DATABASE_URL}}"
    DWN_STORAGE_DATA           = "${{Postgres.DATABASE_URL}}"
    DWN_STORAGE_EVENTS         = "${{Postgres.DATABASE_URL}}"
    DWN_STORAGE_RESUMABLE_TASKS = "${{Postgres.DATABASE_URL}}"
    DS_WEBSOCKET_SERVER        = "on"
    MAX_RECORD_DATA_SIZE       = "1gb"
    DWN_SERVER_LOG_LEVEL       = "info"
  }
}

resource "railway_service" "web_wallet" {
  project_id = railway_project.enbox.id
  name       = "web-wallet"
  
  source = {
    repo = "github.com/your-org/enbox"
    branch = "main"
  }
  
  builder = "nixpacks"
  build_command = "cd examples/web-wallet && npm install && npm run build"
  static_files_path = "examples/web-wallet/dist"
  
  environment_variables = {
    VITE_DWN_URL = "https://${railway_service.dwn_server.railway_public_domain}"
  }
}

resource "railway_service" "dapp_demo" {
  project_id = railway_project.enbox.id
  name       = "dapp-demo"
  
  source = {
    repo = "github.com/your-org/enbox"
    branch = "main"
  }
  
  builder = "nixpacks"
  build_command = "cd examples/dapp-demo && npm install && npm run build"
  static_files_path = "examples/dapp-demo/dist"
  
  environment_variables = {
    VITE_DWN_URL = "https://${railway_service.dwn_server.railway_public_domain}"
  }
}

resource "railway_postgres" "database" {
  project_id = railway_project.enbox.id
  name       = "postgres"
}