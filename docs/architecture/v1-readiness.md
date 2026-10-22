# v1 readiness

The source requirements define v0.1 but do not yet define a normative v1 contract. This document
therefore treats v1 as a set of proposed release gates derived from the long-term vision and the
explicit v0.1 deferrals. It should be replaced or amended when product-level v1 requirements are
approved.

## Candidate baseline available now

- Canonical Evidence and Event storage, temporal Assertions, Decisions, Outcomes, provenance, audit,
  rebuild, and portable backup/restore.
- Local SQLite/filesystem, Cloudflare Worker/D1/R2, and AWS Lambda/DynamoDB/S3 operation behind the
  same ports.
- HTTP and MCP read/query/context/simulation interfaces.
- Local Ollama and llama.cpp providers, remote OpenAI, privacy-aware routing, deterministic
  abstention, counter-evidence, and Agent Run observability.
- A 160-case evaluation dataset, ranked-retrieval metrics, and executable Local/Cloud runtime
  contracts.

## Proposed v1 release gates

| Track           | Candidate implementation                                                                                                                     | Status                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Intent model    | Eight temporal Assertion kinds share the Evidence → Proposal → human approval lifecycle.                                                     | Implemented and tested         |
| Retrieval       | Embedding/vector ports, local hash embeddings, Vectorize and DynamoDB adapters, lexical-semantic fusion, privacy guard, and ranking metrics. | Implemented and tested         |
| Reasoning       | Deterministic Critic reports contradictory Assertions/Decisions, challenged claims, and uncited predictions.                                 | Implemented and tested         |
| Governance      | Audited raw-byte purge, retention execution, AES-256-GCM backups, local/AWS secret stores, and a recovery drill.                             | Implemented and tested locally |
| Ingestion       | Cursor-based connector contract and recursive Markdown/JSON/text directory connector normalize sources into Evidence.                        | Implemented and tested         |
| Product surface | Static accessible review/search/timeline/current-state console; mutations remain on approval endpoints.                                      | Implemented and built          |
| Operations      | SQLite/D1 forward migrations, native Cloudflare/API Gateway rate limits, SAM configuration, alarms, budget, rollback, and AWS runbook.       | Validated; deployment pending  |
| Evaluation      | 60 additional cases cover six deferred categories; retrieval evaluation reports MRR and Recall@k.                                            | Implemented and tested         |

## Release rule

Calling the software v1 should require an approved v1 requirement document, all selected release
gates mapped to executable tests, a clean restore drill, a privacy review, and a tagged deployment
artifact. Features not selected for the first stable release should be explicitly deferred instead
of being implied by the version number.

The repository now contains candidate implementations for every table row. It intentionally remains
a v1 candidate because the product contract, formal privacy review, operator-recorded recovery drill,
authenticated AWS deployment, and release tag require owner or account authority outside automated
repository work.
