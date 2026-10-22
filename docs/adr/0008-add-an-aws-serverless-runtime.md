# ADR 0008: Add an AWS serverless runtime

- Status: Accepted
- Date: 2026-10-20

## Context

The application already runs locally and on Cloudflare through cloud-neutral ports. AWS operation
must preserve the same domain behavior, keep canonical history recoverable, protect raw evidence,
and remain inexpensive for a single-user workload.

## Decision

Add an AWS composition using API Gateway HTTP API, Lambda, Cognito JWT authorization, DynamoDB,
S3, Systems Manager Parameter Store, CloudWatch, SNS, and AWS Budgets. Provision it with AWS SAM.

- DynamoDB stores canonical events, projections, and optional Agent Run records. Canonical events
  use point-in-time recovery and a retained table.
- S3 stores content-addressed raw evidence with encryption, public access blocked, and retention on
  stack deletion.
- Cognito protects every API route except `GET /health`.
- An OpenAI key is optional and is read from an SSM SecureString whose path is under
  `/personal-os/`; storage and retrieval continue to work without it.
- Lambda error and throttle alarms publish to SNS. When an alert email is supplied, the stack also
  creates an 80%-forecast monthly cost notification.
- Local, Cloudflare, and AWS persistence implementations execute the same adapter contract tests.

## Consequences

The repository gains a second cloud target without introducing AWS types into the domain or
application layers. DynamoDB projection search is intentionally scan-based for the initial
single-user deployment; a production scale-up must add purpose-built indexes or a search adapter.
AWS account setup, Cognito user enrollment, alert subscription confirmation, and deployment remain
operator actions and are not performed by tests.

## Revisit when

- projection scans no longer fit the latency or cost budget;
- multiple tenants require stronger partitioning and authorization boundaries;
- regional recovery objectives require replicated tables and buckets; or
- a managed search service is justified by measured retrieval requirements.
