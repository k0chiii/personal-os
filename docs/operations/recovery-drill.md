# Recovery drill

Run this drill in an isolated directory and, for AWS, a non-production stack. Record the date,
operator, source revision, backup checksum, elapsed time, and each acceptance result.

## Portable encrypted backup

Generate or retrieve a 32-byte base64 key without writing it to the repository:

```bash
export PERSONAL_OS_BACKUP_KEY='<base64-encoded-32-byte-key>'
pnpm personal verify
pnpm personal backup create-encrypted /secure/off-device/personal-os.backup
```

Create an empty recovery directory and restore:

```bash
PERSONAL_OS_HOME=/tmp/personal-os-recovery \
  pnpm personal backup restore-encrypted /secure/off-device/personal-os.backup
PERSONAL_OS_HOME=/tmp/personal-os-recovery pnpm personal verify
PERSONAL_OS_HOME=/tmp/personal-os-recovery pnpm personal current --privacy P0,P1,P2,P3
```

Acceptance criteria:

- decryption and AES-GCM authentication succeed;
- event count and non-purged Evidence integrity match the source;
- current Assertions and historical searches match representative fixtures;
- purged raw Evidence is absent while its `evidence.purged` audit event remains;
- a wrong key fails before any events are restored.

Destroy the isolated recovery state after recording the results. Keep the off-device backup and key
in separate approved locations.

## AWS canonical data

1. Stop or block mutation traffic while preserving health access.
2. Record the Event table ARN, desired recovery timestamp, and latest known global position.
3. Restore the Event table to a new DynamoDB table with point-in-time recovery.
4. Compare stream versions, global positions, and representative canonical events with the source.
5. Build a clean Projection table by replaying canonical events through an approved recovery tool or
   one-time job. Never treat the Projection table as the canonical backup.
6. Copy or verify content-addressed Evidence objects in the retained S3 bucket.
7. Deploy an isolated API stack against the recovered resources and run health, search, provenance,
   timeline, authorization, and privacy checks.
8. Cut over only after owner approval. Keep original resources until the recovery is accepted.

The current SAM template creates its own physical resource references. Production recovery that
imports pre-existing tables or buckets therefore needs a reviewed recovery template or one-time
composition change; it must not be improvised during an incident.
