# AWS operations runbook

This runbook deploys the single-user Personal OS API to `ap-northeast-1`. It creates billable AWS
resources. The SAM deployment remains an explicit operator action.

## Prerequisites

- Node.js, pnpm, RTK, AWS CLI v2, and AWS SAM CLI
- an AWS credential chain allowed to create CloudFormation, IAM, Lambda, API Gateway, Cognito,
  DynamoDB, S3, SSM, CloudWatch, SNS, and Budgets resources
- a browser origin for the web console

Verify the account before changing it:

```bash
aws sts get-caller-identity
aws configure get region
```

## Validate and build

```bash
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp test --run
pnpm aws:validate
pnpm aws:build
pnpm --filter @personal-os/web build
```

The normal suite uses deterministic adapter contract doubles. Before a release, also run the live
contract below against disposable AWS resources so SDK serialization, IAM credentials, DynamoDB
transactions/queries, S3 bytes, projection replay, and hybrid retrieval are verified by AWS itself.

## Live AWS adapter contract

This test writes data and is deliberately blocked from production-looking resources. Create an
isolated stack whose generated resource names contain `contract`:

```bash
aws cloudformation deploy \
  --stack-name personal-os-contract \
  --template-file infra/aws/contract-template.yaml

aws cloudformation describe-stacks \
  --stack-name personal-os-contract \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
```

Export the three output values, acknowledge the live writes, then run the executable contract:

```bash
export EVENT_TABLE_NAME='<EventTableName output>'
export PROJECTION_TABLE_NAME='<ProjectionTableName output>'
export EVIDENCE_BUCKET_NAME='<EvidenceBucketName output>'
export PERSONAL_OS_AWS_LIVE_CONTRACT=true
pnpm aws:contract
```

The command refuses resources whose names do not contain `contract`. It covers S3 Evidence bytes,
DynamoDB canonical events and projections, optimistic concurrency, idempotency, rebuild, integrity,
and DynamoDB vector retrieval. Remove the disposable resources after recording the result.
CloudFormation cannot delete a non-empty bucket, so empty the contract Evidence bucket first. The
`case` guard refuses any bucket name that does not contain `contract`:

```bash
case "$EVIDENCE_BUCKET_NAME" in
  *contract*) aws s3 rm "s3://$EVIDENCE_BUCKET_NAME" --recursive ;;
  *) echo "refusing to empty non-contract bucket $EVIDENCE_BUCKET_NAME" >&2; exit 1 ;;
esac
aws cloudformation delete-stack --stack-name personal-os-contract
aws cloudformation wait stack-delete-complete --stack-name personal-os-contract
```

## Configure secrets

The optional OpenAI key must be a SecureString below `/personal-os/`. Do not place it in SAM
parameters, source control, or CloudFormation outputs.

```bash
aws ssm put-parameter \
  --name /personal-os/openai-api-key \
  --type SecureString \
  --value '<secret>' \
  --overwrite
```

Portable encrypted backups use a different 32-byte key outside the application database. A local
example for generating the environment value is:

```bash
openssl rand -base64 32
```

Store that value in a password manager or managed secret store. Losing it makes the encrypted
backup unrecoverable.

## Deploy

Review `infra/aws/samconfig.toml`, then deploy with production values:

```bash
pnpm aws:deploy -- \
  --parameter-overrides \
    AllowedOrigin=https://personal.example.com \
    AlertEmail=owner@example.com \
    MonthlyBudgetUsd=10 \
    RateLimitPerMinute=120 \
    ApiThrottleRateLimit=10 \
    ApiThrottleBurstLimit=20 \
    OpenAiApiKeyParameterName=/personal-os/openai-api-key \
    OwnerSubject=<Cognito sub of the owner>
```

Confirm the CloudFormation change set and SNS email subscription. Read the API URL, Cognito user
pool, client ID, tables, and bucket from stack outputs. The user pool only accepts users created by
an administrator; create the owner using the AWS console or the organization-approved identity
workflow. `GET /health` is public; all `/v1/*` routes require a Cognito JWT whose `sub` equals
`OwnerSubject`.

`OwnerSubject` is unknown until the owner exists, so the first deploy leaves it empty. The Lambda
then fails closed and answers every request, including `GET /health`, with HTTP 500. Read the
owner's `sub` and redeploy with the same parameters plus `OwnerSubject`:

```bash
aws cognito-idp admin-get-user \
  --user-pool-id '<UserPoolId>' \
  --username owner@example.com \
  --query "UserAttributes[?Name=='sub'].Value" \
  --output text
```

The web build is in `apps/web/dist`. Host those static files on the approved HTTPS origin, set that
origin as `AllowedOrigin`, then enter the API output URL and a Cognito access token in the console.
The token is held in browser session storage and is not persisted in local storage.

## Routine checks

- Check `GET /health` from the monitoring system.
- Review Lambda error and throttle alarms and the monthly budget notification.
- Verify DynamoDB point-in-time recovery remains enabled on the Event table.
- Treat the Projection table's vector records as derived data. Current AWS semantic search performs
  an exact scan suitable for the single-user baseline; move the `VectorIndexPort` adapter to
  OpenSearch Serverless or another vector service before higher-volume operation.
- Run the encrypted backup and recovery drill in `recovery-drill.md` at the chosen cadence.
- Treat changes to privacy routing, authorization, retention, or secret access as review-required.

## Rollback

For an application regression, redeploy the last known-good source revision with the same stack
parameters. Do not delete the stack as a rollback method: the Event table and Evidence bucket are
retained, while the derived Projection table is disposable.

If a CloudFormation update is stuck, inspect stack events before using the CloudFormation rollback
operation. If canonical Event data is damaged, stop writes and use DynamoDB point-in-time recovery
to a new table; do not overwrite the original. Recovery details and acceptance checks are in
`recovery-drill.md`.
