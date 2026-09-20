ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
FROM ${BUN_IMAGE}

WORKDIR /opt/enbox-lab-routing-proof
COPY packages/lab/src/proofs/routing/runtime.ts ./runtime.ts

USER bun
ENTRYPOINT ["bun", "run", "/opt/enbox-lab-routing-proof/runtime.ts"]
