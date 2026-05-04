"""Aurora master-secret rotation sync.

Triggered by EventBridge when AWS rotates the Aurora master secret (and on a
periodic drift-check schedule). Reads the current Aurora credentials, composes
the canonical Postgres URL, updates the consumer secret if it has drifted, and
forces a rolling redeploy of the ECS services that consume it.

This Lambda is intentionally conservative:

* It validates that the inbound event refers to *our* master secret before
  doing anything (defense in depth on top of the EventBridge rule filter).
* It is idempotent: when the consumer secret already matches, no write or
  redeploy is performed.
* It always pulls the live cluster endpoint via DescribeDBClusters rather than
  trusting the host inside the rotated secret payload, so a writer failover
  cannot leave us pointing at a stale endpoint.
* It URL-encodes the password before composing the connection string. AWS
  generates passwords containing `/`, `@`, `:`, `?`, `#` and `%`, all of which
  break a naively concatenated URL.
* It emits CloudWatch EMF metrics so a single CloudWatch alarm can monitor
  the success / failure / drift signal across environments.
"""

import json
import logging
import os
import time
import urllib.parse
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


def _is_relevant_event(event: dict[str, Any]) -> bool:
    """Accept events that relate to *our* master secret or that are synthetic
    drift-check invocations. Reject anything else loudly."""
    if event.get("source") == "drift-check":
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


def _force_redeploy_services() -> list[str]:
    rolled: list[str] = []
    for service in ECS_SERVICE_NAMES:
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
    return rolled


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
        if current == new_url:
            logger.info("target secret already up-to-date")
            _emit_metric("SecretSyncNoOp")
            return {"status": "no-op", "environment": ENVIRONMENT}

        _put_target_secret(new_url)
        logger.info("updated target secret")
        _emit_metric("SecretSyncDrifted")

        rolled = _force_redeploy_services()
        _emit_metric("SecretSyncSucceeded")

        return {
            "status": "updated",
            "environment": ENVIRONMENT,
            "rolled_services": rolled,
        }

    except Exception:
        logger.exception("secret sync failed")
        _emit_metric("SecretSyncFailed")
        raise
