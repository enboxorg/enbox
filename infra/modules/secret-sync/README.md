# secret-sync

Event-driven sync from the AWS-managed Aurora master secret to the
`dwn/<env>/database-url` secret consumed by the DWN ECS services.

## Why this exists

The Aurora cluster is created with `manage_master_user_password = true`, so AWS
owns and rotates the master password on a schedule (~7 days). DWN tasks read
their connection string from a separate `dwn/<env>/database-url` secret. Without
this module, `dwn/<env>/database-url` silently drifts after each rotation and
the next ECS task launch fails to connect.

This module wires:

```
Aurora rotation -> Secrets Manager event -> EventBridge -> Lambda
                                                              |
                                                              +-> PutSecretValue on dwn/<env>/database-url
                                                              +-> ecs:UpdateService --force-new-deployment
```

A second EventBridge rule fires the same Lambda every 6 hours as a drift-check
safety net — even if the rotation event is ever missed, the consumer secret
will self-heal within 6 hours.

## Triggers

| Trigger | Event |
|---|---|
| `aws_cloudwatch_event_rule.rotation` | Filtered on `source=aws.secretsmanager`, `detail.eventName=RotationSucceeded`, `additionalEventData.SecretId=<master_secret_arn>` |
| `aws_cloudwatch_event_rule.drift_check` | `rate(6 hours)` schedule with payload `{"source": "drift-check"}` |

## Manual invocation

To bootstrap a fresh environment (after `terraform apply`) or to test, invoke
the Lambda directly:

```bash
aws lambda invoke \
  --function-name dwn-dev-secret-sync \
  --payload '{"source": "drift-check"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/out.json && cat /tmp/out.json
```

To force a real rotation in dev:

```bash
aws secretsmanager rotate-secret \
  --secret-id "$(terraform -chdir=infra/environments/dev output -raw aurora_master_secret_arn)" \
  --rotate-immediately
```

## Idempotency and retry semantics

The Lambda treats rotation events and the periodic drift-check schedule
differently to stay safe under partial-rollout failure modes:

* **Rotation events** (`detail-type: AWS Service Event via CloudTrail`,
  `eventName: RotationSucceeded`) always force a redeploy of every service
  in `ecs_service_names`, even when the consumer secret already matches the
  master. This is what makes the rollout retryable: if a previous invocation
  succeeded on the secret update and on rolling `dwn-<env>-http` but failed
  on `dwn-<env>-ws`, the Lambda async retry would otherwise see "secret
  already matches" and never roll the failed service. `UpdateService` with
  `force-new-deployment` is idempotent for ECS — repeating it just supersedes
  any in-flight deployment — so this is safe.
* **Drift-check events** (synthetic `{"source": "drift-check"}` payload from
  the schedule) only roll services when a drift was actually detected,
  otherwise the schedule would trigger four unnecessary redeploys per day.

Per-service failures inside `_force_redeploy_services` are aggregated; one
bad service does not prevent the others from being attempted in the same
invocation, and the Lambda raises with the list of failed services so async
retry / DLQ kicks in.

## Failure modes

| Failure | Result |
|---|---|
| Lambda raises | Async retried by Lambda (default 2 retries), then dead-lettered to `${name}-secret-sync-dlq` |
| `Errors` alarm | Fires on any Lambda error in the last 5 minutes |
| `dlq-depth` alarm | Fires when there is at least one unprocessed message in the DLQ |
| `stale` alarm | Fires when the Lambda has not been invoked in 24 hours (drift-check fires 4×/day) |

## Required inputs

See [`variables.tf`](variables.tf). The module needs:

* `master_secret_arn` — exposed by the `aurora` module as `master_secret_arn`
* `rds_cluster_id`, `rds_cluster_arn` — exposed by the `aurora` module
* `target_secret_arn` — the `dwn/<env>/database-url` secret ARN
* `ecs_cluster_name`, `ecs_cluster_arn`, `ecs_service_names` — the services to roll
* `sns_topic_arn` — optional; alarms route to this topic when set

## Outputs

* `lambda_function_name` — used in operational runbooks for `aws lambda invoke`
* `lambda_arn`, `lambda_role_arn`, `log_group_name`, `dlq_arn`, `errors_alarm_arn`
