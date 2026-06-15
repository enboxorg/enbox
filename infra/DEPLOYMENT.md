# AWS deployment operations

Operational runbook for the Enbox AWS deployment. Read this when:

- You're modifying anything under `infra/` (Terraform, modules, environments).
- You're shipping a `dwn-server` change that needs to roll out to dev/prod.
- The CI deploy pipeline is broken and you need to deploy by hand.
- You're adding a new workspace package and need to update the Dockerfile.

For a description of *what* is deployed (ALB, ECS services, Aurora, S3, secret-sync wiring), see [`infra/architecture.md`](./architecture.md). This document only covers *how* deploys happen and where to operate them from.

## Layout

| Directory | Purpose |
|---|---|
| `infra/bootstrap/` | One-time Terraform state backend (S3 bucket + DynamoDB lock table) |
| `infra/environments/dev/` | Dev environment Terraform config |
| `infra/environments/prod/` | Prod environment Terraform config |
| `infra/modules/` | Reusable Terraform modules (alb, aurora, ecs-cluster, ecs-service, monitoring, nats, s3-data, secret-sync, vpc) |

Dev environment quick reference (full details in [`infra/architecture.md`](./architecture.md)):

- **URL:** `https://dev.aws.dwn.enbox.id`
- **AWS Account:** `387235730938`, **Region:** `us-east-1`
- **ECS Cluster:** `dwn-dev`; services `dwn-dev-http`, `dwn-dev-ws`, `dwn-dev-nats-0`
- **ECR Repo:** `387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server`

## CI/CD pipeline

`.github/workflows/deploy.yml` triggers on push to `main` when `dwn-server` or its dependencies change. It:

1. Runs the full CI suite.
2. Builds a Docker image and pushes to ECR (tagged `sha-<short>`).
3. Force-deploys to the dev ECS cluster.
4. Prod requires manual approval via GitHub Environment protection rules.

**Note:** The deploy workflow requires GitHub repo variables (`AWS_ECR_ROLE_ARN`, `AWS_TERRAFORM_ROLE_ARN`, `ECS_CLUSTER_DEV`, `ECS_SERVICES_DEV`, etc.) to be configured. If these are not set, the workflow will `startup_failure`.

## Manual deployment

When the CI deploy pipeline is unavailable, deploy manually:

```bash
# 1. Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 387235730938.dkr.ecr.us-east-1.amazonaws.com

# 2. Build and tag the image (from repo root)
SHA_SHORT=$(git rev-parse --short=7 HEAD)
docker build -t 387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT} .

# 3. Push to ECR
docker push 387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT}

# 4. Register new task definitions with the updated image
#    (get current task def, update image, register new revision)
for svc in dwn-dev-http dwn-dev-ws; do
  CURRENT=$(aws ecs describe-services --cluster dwn-dev --services $svc --region us-east-1 --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --task-definition $CURRENT --region us-east-1 --query 'taskDefinition' | \
    jq "del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy) | .containerDefinitions[0].image = \"387235730938.dkr.ecr.us-east-1.amazonaws.com/dwn-server:sha-${SHA_SHORT}\"" > /tmp/${svc}-task-def.json
  aws ecs register-task-definition --cli-input-json file:///tmp/${svc}-task-def.json --region us-east-1
done

# 5. Update services with new task definitions and force deploy
aws ecs update-service --cluster dwn-dev --service dwn-dev-http --task-definition dwn-dev-http --force-new-deployment --region us-east-1
aws ecs update-service --cluster dwn-dev --service dwn-dev-ws --task-definition dwn-dev-ws --force-new-deployment --region us-east-1

# 6. Wait for services to stabilize
aws ecs wait services-stable --cluster dwn-dev --services dwn-dev-http dwn-dev-ws --region us-east-1
echo "Deployment complete!"

# 7. Verify
curl -sf https://dev.aws.dwn.enbox.id/health && echo " OK"
```

## Dockerfile

The production Dockerfile is at the repo root (`Dockerfile`). It's a 3-stage build (deps → build → runtime) using `oven/bun:1-alpine`. When adding new workspace packages, remember to add a `COPY packages/<name>/package.json packages/<name>/` line in both the `deps` and `build` stages so bun workspace resolution succeeds.

## Terraform operations

```bash
# Plan changes (from infra/environments/dev/):
terraform plan -var certificate_arn="..." -var dwn_image="..."

# Apply changes:
terraform apply -var certificate_arn="..." -var dwn_image="..."
```

State is stored in S3 (`enbox-terraform-state` bucket, `env/dev/terraform.tfstate` key) with DynamoDB locking (`enbox-terraform-locks` table).

## Database Restore Runbook

Use this only after restoring the DWN database from a backup or snapshot. Do not
run the adoption-reset drop list during a restore; it deletes the data you just
restored.

After the database restore completes and before clients resume sync, rotate the
replication epoch:

```sql
UPDATE "replicationMeta"
SET "value" = gen_random_uuid()::text
WHERE "key" = 'epoch';
```

For PostgreSQL environments where `gen_random_uuid()` is unavailable, generate a
UUID outside the database and set it explicitly:

```sql
UPDATE "replicationMeta"
SET "value" = '<fresh-random-uuid>'
WHERE "key" = 'epoch';
```

The epoch is the store-generation marker used by replication cursors. Restored
stores can have older rows under the same tenant high-water positions; rotating
the epoch forces clients to discard stale cursors instead of validating them
against the restored store and skipping or misreading rows.

## Adoption Reset Runbook

Use this only when intentionally resetting DWN message/storage state while
preserving registration and admin state. This is not a database restore
procedure.

1. Bring up the new server build first and verify `/health`.
2. Stop write traffic to the old server.
3. Drop only the DWN store tables and migration metadata:

```sql
DROP TABLE IF EXISTS "messageStoreRecordsTags" CASCADE;
DROP TABLE IF EXISTS "messageStoreMessages" CASCADE;
DROP TABLE IF EXISTS "dataRefs" CASCADE;
DROP TABLE IF EXISTS "dataBlocks" CASCADE;
DROP TABLE IF EXISTS "dataStore" CASCADE;
DROP TABLE IF EXISTS "stateIndexNodes" CASCADE;
DROP TABLE IF EXISTS "stateIndexRoots" CASCADE;
DROP TABLE IF EXISTS "stateIndexMeta" CASCADE;
DROP TABLE IF EXISTS "resumableTasks" CASCADE;
DROP TABLE IF EXISTS "replicationCounters" CASCADE;
DROP TABLE IF EXISTS "replicationFingerprints" CASCADE;
DROP TABLE IF EXISTS "replicationMeta" CASCADE;
DROP TABLE IF EXISTS "kysely_migration" CASCADE;
DROP TABLE IF EXISTS "kysely_migration_lock" CASCADE;
```

Do not drop registration or admin tables: `registeredTenants`, `tenantQuotas`,
`adminAuditLog`, `adminWebhooks`, `adminPasskeys`, and `cacheEntries`.

4. Start the new server so migrations recreate the DWN store schema.
5. Verify health and registration/admin endpoints.
6. Publish or switch the agent endpoint after the new server is serving the
   reset store.
