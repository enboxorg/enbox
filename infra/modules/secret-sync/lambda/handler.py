"""Aurora master-secret rotation sync.

Triggered by EventBridge when AWS rotates the Aurora master secret (and on a
periodic drift-check schedule). Reads the current Aurora credentials, composes
the canonical Postgres URL, updates the consumer secret if it has drifted, and
forces a rolling redeploy of the ECS services that consume it.

This Lambda is intentionally conservative:

* It validates that the inbound event refers to *our* master secret before
  doing anything (defense in depth on top of the EventBridge rule filter).
* It always pulls the live cluster endpoint via DescribeDBClusters rather than
  trusting the host inside the rotated secret payload, so a writer failover
  cannot leave us pointing at a stale endpoint.
* It URL-encodes the password before composing the connection string. AWS
  generates passwords containing `/`, `@`, `:`, `?`, `#` and `%`, all of which
  break a naively concatenated URL.
* It emits CloudWatch EMF metrics so a single CloudWatch alarm can monitor
  the success / failure / drift signal across environments.

Retry semantics
---------------

The Lambda must remain safely retryable when any invocation triggers a
partial rollout: e.g. PutSecretValue succeeds, UpdateService(http) succeeds,
UpdateService(ws) fails. If the next retry short-circuited on "secret already
matches", the failed service would never be rolled and would keep running
with the stale credentials baked into its env vars at task launch — and this
applies equally to rotation events and to the periodic drift-check schedule
when the latter is the one that found the drift.

The fix is to ignore event type for the rollout decision and instead consult
ECS directly for each service: a service "needs a roll" iff none of its
deployments were created at or after the consumer secret's LastChangedDate
AND in a non-FAILED rollout state. The FAILED filter matters because the
ECS service module enables the deployment circuit breaker with rollback —
``UpdateService`` can succeed, the Lambda can return success, and minutes
later the new tasks can fail their health checks and ECS rolls back to the
previous task set, leaving the service running on tasks that cached the
*old* secret value at launch.

* Initial happy path: PutSecretValue updates LastChangedDate, every service
  has its previous deployment created earlier, so every service is rolled.
* Partial-rollout retry: services that succeeded on the prior invocation now
  have a deployment created after LastChangedDate and are skipped; the
  service that failed is rolled again.
* Drift-check on a stable cluster: every service already has a deployment
  newer than LastChangedDate, the function returns no-op.
* Circuit-breaker rollback recovery: a deployment that ``UpdateService``
  accepted but ECS later marked FAILED is treated as not-rolled, so the
  next invocation re-rolls the service rather than silently believing it
  was up to date.

Per-service errors are aggregated rather than aborting the loop, so one bad
service cannot prevent the others from being attempted in the same
invocation, and the function raises once at the end if any services failed
so Lambda async retry / DLQ kicks in.
"""

import json
import logging
import os
import time
import urllib.parse
from datetime import datetime
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ENVIRONMENT = os.environ["ENVIRONMENT"]
TARGET_SECRET_ARN = os.environ["TARGET_SECRET_ARN"]
MASTER_SECRET_ARN = os.environ["MASTER_SECRET_ARN"]
RDS_CLUSTER_ID = os.environ["RDS_CLUSTER_ID"]
DB_NAME = os.environ["DB_NAME"]
ECS_CLUSTER_NAME = os.environ["ECS_CLUSTER_NAME"]
ECS_SERVICE_NAMES = [s for s in os.environ["ECS_SERVICE_NAMES"].split(",") if s]

METRIC_NAMESPACE = "DWN/SecretSync"

secrets_client = boto3.client("secretsmanager")
rds_client = boto3.client("rds")
ecs_client = boto3.client("ecs")


def _emit_metric(name: str, value: float = 1.0, unit: str = "Count") -> None:
    """Emit a CloudWatch EMF metric line to stdout (parsed by the log agent)."""
    emf = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": METRIC_NAMESPACE,
                    "Dimensions": [["Environment"]],
                    "Metrics": [{"Name": name, "Unit": unit}],
                }
            ],
        },
        "Environment": ENVIRONMENT,
        name: value,
    }
    print(json.dumps(emf))


def _is_drift_check(event: dict[str, Any]) -> bool:
    """True when the invocation came from the periodic drift-check schedule
    rather than a Secrets Manager rotation event."""
    return event.get("source") == "drift-check"


def _is_relevant_event(event: dict[str, Any]) -> bool:
    """Accept events that relate to *our* master secret or that are synthetic
    drift-check invocations. Reject anything else loudly."""
    if _is_drift_check(event):
        return True

    detail = event.get("detail") or {}
    additional = detail.get("additionalEventData") or {}
    secret_id = additional.get("SecretId") or detail.get("secretId")

    if not secret_id:
        return False

    return secret_id == MASTER_SECRET_ARN


def _read_master_credentials() -> tuple[str, str]:
    """Return the current (username, password) from the AWS-managed master
    secret. The secret payload is JSON with at minimum `username` and
    `password` keys."""
    response = secrets_client.get_secret_value(SecretId=MASTER_SECRET_ARN)
    payload = json.loads(response["SecretString"])
    return payload["username"], payload["password"]


def _read_cluster_endpoint() -> tuple[str, int]:
    """Return the current (endpoint, port) for the writer instance. Calling
    DescribeDBClusters guarantees we use the live writer regardless of any
    failover that may have happened during rotation."""
    response = rds_client.describe_db_clusters(DBClusterIdentifier=RDS_CLUSTER_ID)
    cluster = response["DBClusters"][0]
    return cluster["Endpoint"], int(cluster["Port"])


def _compose_url(username: str, password: str, endpoint: str, port: int) -> str:
    encoded_password = urllib.parse.quote(password, safe="")
    encoded_username = urllib.parse.quote(username, safe="")
    return f"postgres://{encoded_username}:{encoded_password}@{endpoint}:{port}/{DB_NAME}"


def _read_target_secret() -> str | None:
    try:
        response = secrets_client.get_secret_value(SecretId=TARGET_SECRET_ARN)
    except secrets_client.exceptions.ResourceNotFoundException:
        return None
    return response.get("SecretString")


def _put_target_secret(value: str) -> None:
    secrets_client.put_secret_value(SecretId=TARGET_SECRET_ARN, SecretString=value)


def _read_target_last_changed() -> datetime:
    """Return the consumer secret's LastChangedDate. This is the timestamp the
    rollout is measured against — any ECS deployment created at or after this
    instant is considered to have launched tasks that pulled the current
    secret value."""
    response = secrets_client.describe_secret(SecretId=TARGET_SECRET_ARN)
    last_changed = response.get("LastChangedDate") or response.get("CreatedDate")
    if last_changed is None:
        raise RuntimeError(
            f"target secret {TARGET_SECRET_ARN} has neither LastChangedDate "
            "nor CreatedDate in DescribeSecret response"
        )
    return last_changed


def _services_needing_roll(secret_last_changed: datetime) -> list[str]:
    """Return the subset of configured services that have *not* been told to
    deploy at or after ``secret_last_changed`` with a healthy rollout.

    A service is considered up to date iff it has at least one deployment
    with ``createdAt >= secret_last_changed`` AND ``rolloutState != FAILED``.
    Both ``IN_PROGRESS`` and ``COMPLETED`` count, so we don't supersede an
    in-flight rollout from a prior invocation; ``FAILED`` does not, because
    the ECS service module enables the deployment circuit breaker with
    rollback (see ``infra/modules/ecs-service/main.tf``). That means a
    deployment can reach ``UpdateService`` success, the Lambda can return
    success, and minutes later the new tasks can fail their health checks
    and ECS rolls back to the previous task set — leaving the service back
    on tasks that cached the *old* secret value at launch. The next drift
    check would otherwise see the FAILED deployment timestamp and no-op,
    silently leaving the service stale.
    """
    response = ecs_client.describe_services(
        cluster=ECS_CLUSTER_NAME,
        services=ECS_SERVICE_NAMES,
    )

    failures = response.get("failures") or []
    if failures:
        raise RuntimeError(f"DescribeServices failures: {failures}")

    by_name = {service["serviceName"]: service for service in response.get("services", [])}
    missing = [name for name in ECS_SERVICE_NAMES if name not in by_name]
    if missing:
        raise RuntimeError(f"ECS services not found in cluster {ECS_CLUSTER_NAME}: {missing}")

    needing_roll: list[str] = []
    for name in ECS_SERVICE_NAMES:
        deployments = by_name[name].get("deployments") or []
        rolled_post_update = any(
            d.get("createdAt") is not None
            and d["createdAt"] >= secret_last_changed
            and d.get("rolloutState") != "FAILED"
            for d in deployments
        )
        if not rolled_post_update:
            needing_roll.append(name)
            logger.info(
                "service has no healthy deployment after secret update — needs roll",
                extra={
                    "cluster": ECS_CLUSTER_NAME,
                    "service": name,
                    "secret_last_changed": secret_last_changed.isoformat(),
                    "deployments": [
                        {
                            "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
                            "rolloutState": d.get("rolloutState"),
                            "status": d.get("status"),
                        }
                        for d in deployments
                    ],
                },
            )
    return needing_roll


def _force_redeploy_services(services: list[str]) -> tuple[list[str], list[dict[str, str]]]:
    """Force a new deployment on each given service.

    Errors on individual services are collected rather than re-raised so that
    a transient failure on one service cannot prevent the others from being
    rolled in the same invocation. The caller is responsible for raising when
    the returned ``failed`` list is non-empty so Lambda async retry kicks in.
    """
    rolled: list[str] = []
    failed: list[dict[str, str]] = []
    for service in services:
        try:
            ecs_client.update_service(
                cluster=ECS_CLUSTER_NAME,
                service=service,
                forceNewDeployment=True,
            )
            rolled.append(service)
            logger.info(
                "forced new deployment",
                extra={"cluster": ECS_CLUSTER_NAME, "service": service},
            )
        except Exception as exc:
            logger.exception(
                "failed to roll service",
                extra={"cluster": ECS_CLUSTER_NAME, "service": service},
            )
            failed.append({"service": service, "error": str(exc)})
    return rolled, failed


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    logger.info("received event: %s", json.dumps(event, default=str))

    if not _is_relevant_event(event):
        logger.info("event does not match our master secret, ignoring")
        return {"status": "ignored", "environment": ENVIRONMENT}

    try:
        username, password = _read_master_credentials()
        endpoint, port = _read_cluster_endpoint()
        new_url = _compose_url(username, password, endpoint, port)

        current = _read_target_secret()
        secret_drifted = current != new_url

        if secret_drifted:
            _put_target_secret(new_url)
            logger.info("updated target secret")
            _emit_metric("SecretSyncDrifted")
        else:
            logger.info("target secret already up-to-date")

        # The rollout decision is event-type-agnostic: a service needs to be
        # rolled iff it has no deployment recorded at or after the consumer
        # secret's LastChangedDate. This makes us safely retryable whether the
        # original failure happened on a rotation event or a drift-check
        # invocation: services that already rolled in a prior attempt show up
        # as "up to date" and are skipped, services that were never rolled
        # are picked up.
        secret_last_changed = _read_target_last_changed()
        services_to_roll = _services_needing_roll(secret_last_changed)

        if not services_to_roll:
            _emit_metric("SecretSyncNoOp")
            return {
                "status": "no-op",
                "environment": ENVIRONMENT,
                "secret_last_changed": secret_last_changed.isoformat(),
            }

        rolled, failed = _force_redeploy_services(services_to_roll)

        if failed:
            failed_services = [item["service"] for item in failed]
            raise RuntimeError(
                f"failed to roll {len(failed)} service(s): {failed_services}; "
                f"succeeded: {rolled}"
            )

        _emit_metric("SecretSyncSucceeded")
        return {
            "status": "updated" if secret_drifted else "rolled",
            "environment": ENVIRONMENT,
            "rolled_services": rolled,
            "secret_drifted": secret_drifted,
            "secret_last_changed": secret_last_changed.isoformat(),
        }

    except Exception:
        logger.exception("secret sync failed")
        _emit_metric("SecretSyncFailed")
        raise
