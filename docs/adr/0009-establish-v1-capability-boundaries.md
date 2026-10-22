# ADR 0009: Establish v1 capability boundaries

- Status: Accepted
- Date: 2026-10-20

## Context

The v0.1 vertical slice proved evidence-backed, human-approved temporal memory across local,
Cloudflare, and AWS runtimes. Moving toward a stable release requires broader intent modeling,
semantic retrieval, explicit criticism, operational governance, ingestion, and a usable review
surface without allowing an agent to silently change canonical personal data.

## Decision

- Represent Goal, Project, Artifact, ResearchTopic, Value, Belief, and Constraint through the same
  temporal Assertion lifecycle as Preference. Every canonical Assertion still requires Evidence and
  an approved Proposal.
- Keep semantic retrieval behind embedding and vector-index ports. The default implementation is a
  deterministic local hash embedding with lexical fallback and reciprocal-rank fusion. P3 content
  cannot be sent to a remote embedding provider.
- Make the Critic a deterministic, separately testable stage that can accept, request revision, or
  abstain when context is contradictory.
- Treat purge as an audited event: remove raw bytes, retain metadata and canonical history, and omit
  purged bytes from backups. Retention executes the same operation.
- Encrypt portable backups with AES-256-GCM and obtain keys outside canonical storage.
- Keep Source Connectors cursor-based and normalize every imported document into Evidence before
  any semantic proposal is created.
- Provide a static web console for review, search, current state, and timeline. It calls the same
  HTTP API and does not bypass human approval.
- Add forward-only schema migrations, application and gateway rate limits, and explicit recovery
  and rollback runbooks.

## Consequences

The v1 candidate covers each proposed capability gate with executable code and tests while
preserving the v0.1 trust boundary. Local hash embeddings are useful for deterministic fallback,
not a replacement for a measured production embedding model. In-memory application rate limiting
is a per-process defense; AWS API Gateway throttling is the distributed outer limit. A stable v1
still requires an approved product contract, privacy review, recovery drill, deployment, and tag.

## Revisit when

- retrieval evaluation justifies a different local embedding or reranker;
- multi-user operation requires tenant-isolated indexes and distributed rate limiting;
- connector credentials require rotation beyond the current secret-store ports; or
- the v1 product contract changes the selected release gates.
