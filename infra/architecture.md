# Dev Environment Architecture

```mermaid
graph TB
    subgraph Internet
        Client[Client / Browser]
    end

    DNS[dev.aws.dwn.enbox.id<br/>CNAME -> ALB]

    subgraph AWS["AWS Account 387235730938"]
        subgraph VPC["VPC 10.0.0.0/16"]
            subgraph PubSub["Public Subnets"]
                ALB[Application Load Balancer<br/>dwn-dev<br/>HTTPS :443 / HTTP :80 redirect]
            end

            subgraph PrivSub["Private Subnets"]
                subgraph ECSCluster["ECS Cluster: dwn-dev"]
                    HTTP[DWN HTTP Service<br/>Fargate<br/>:3000]
                    WS[DWN WebSocket Service<br/>Fargate<br/>:3000]
                    NATS[NATS JetStream<br/>Fargate<br/>:4222 client / :8222 monitor]
                end
            end

            subgraph DataSub["Data Subnets"]
                Aurora[(Aurora PostgreSQL 15.8<br/>db.t4g.medium<br/>dwn-dev.cluster-xxx.rds.amazonaws.com)]
            end

            EFS[EFS Volume<br/>NATS persistent storage]
            NAT[NAT Gateway]
        end

        subgraph AWSServices["AWS Services"]
            ECR[ECR<br/>dwn-server repo]
            SM[Secrets Manager<br/>database-url / admin-token]
            S3[S3: dwn-dev-store-us-east-1<br/>DWN data storage]
            CW[CloudWatch<br/>Logs + Alarms]
            ACM[ACM Certificate<br/>dev.aws.dwn.enbox.id]
        end
    end

    Client -->|HTTPS| DNS
    DNS --> ALB
    ALB -->|default: forward| HTTP
    ALB -->|Upgrade: websocket| WS
    HTTP -->|NATS pub/sub| NATS
    WS -->|NATS pub/sub| NATS
    HTTP -->|port 5432| Aurora
    WS -->|port 5432| Aurora
    HTTP -->|S3 API| S3
    WS -->|S3 API| S3
    NATS -->|EFS mount /data| EFS
    HTTP -.->|secrets injection| SM
    WS -.->|secrets injection| SM
    ALB -.->|TLS termination| ACM
    HTTP -.->|logs| CW
    WS -.->|logs| CW
    NATS -.->|logs| CW
    HTTP -.->|image pull| ECR
    NAT -->|outbound| Internet

    classDef primary fill:#2563eb,stroke:#1e40af,color:#fff
    classDef data fill:#7c3aed,stroke:#5b21b6,color:#fff
    classDef service fill:#059669,stroke:#047857,color:#fff
    classDef infra fill:#d97706,stroke:#b45309,color:#fff

    class HTTP,WS,NATS primary
    class Aurora,S3,EFS data
    class SM,CW,ACM,ECR service
    class ALB,NAT,DNS infra
```

## Key Details

| Component | Details |
|---|---|
| **ALB** | Internet-facing, TLS 1.3, HTTP->HTTPS redirect, WebSocket routing via `Upgrade` header |
| **DWN HTTP** | Fargate, 512 CPU / 1024 MB, autoscaling 1-2 tasks |
| **DWN WebSocket** | Fargate, 512 CPU / 1024 MB, autoscaling 1-2 tasks |
| **NATS** | Single-node JetStream, EFS-backed persistence, CloudMap service discovery (`nats-0.nats.local`) |
| **Aurora** | PostgreSQL 15.8 Serverless-compatible, `db.t4g.medium`, encrypted, managed master password |
| **S3** | `dwn-dev-store-us-east-1`, SSE-S3 encryption, restricted bucket policy |
| **Secrets** | `dwn/dev/database-url` (Postgres connection string), `dwn/dev/admin-token` (bearer token) |
| **Monitoring** | CloudWatch alarms for ALB 5xx, ALB latency P95, ECS CPU/memory, Aurora CPU |
