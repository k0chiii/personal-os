# Personal OS

> A local-first, model-agnostic personal knowledge and agent infrastructure for building an explainable, evolving computational model of a person.

**Status:** Early development / v0.1
**Primary language:** TypeScript
**Scope:** Research, learning, and personal infrastructure

## Overview

Personal OS is an experimental infrastructure for representing a person as an evolving, queryable, and explainable computational model.

The goal is not to build a chatbot that simply remembers previous conversations.

Instead, Personal OS aims to maintain a structured model of:

- evidence and source material,
- facts and assertions,
- preferences and beliefs,
- goals and constraints,
- projects and activities,
- decisions and their outcomes,
- relationships between concepts,
- changes over time,
- and the provenance behind every important claim.

This model can then be used by different LLMs, local models, agents, interfaces, and future tools without making any single model provider the source of truth.

Long term, the project explores the idea of a **Personal Digital Twin** or **clone agent**: a system capable of reasoning about how a person has thought, acted, changed, and might make future decisions, while remaining grounded in explicit evidence and uncertainty.

---

## Why this project exists

Most AI assistants treat personal context as an implementation detail of the assistant itself:

```text
User
  ↓
Conversation history
  ↓
LLM memory
  ↓
Answer
```

Personal OS reverses that relationship.

```text
                    ┌───────────────┐
                    │ Personal Model│
                    └───────┬───────┘
                            │
             ┌──────────────┼──────────────┐
             ↓              ↓              ↓
          Local LLM      Remote LLM      Other Agent
```

The personal model belongs to the user.

Models are replaceable reasoning engines.

A change in model provider should not erase the person being modeled.

---

## Core principles

### Evidence first

Important assertions should be traceable back to their source evidence.

For example:

```text
Evidence
   ↓ supports
Assertion
   ↓ describes
Person
```

An inferred statement such as:

> The person appears to prefer minimal visual design.

must remain distinguishable from:

> The person explicitly stated that they prefer minimal visual design.

---

### History is append-only

Personal information changes over time.

Old preferences, goals, beliefs, and interpretations should not simply be overwritten.

Instead:

```text
Preference A
valid: 2025-01 → 2026-05

Preference B
valid: 2026-05 →
supersedes: Preference A
```

Historical state should remain queryable.

---

### Human authority

LLMs may propose changes to the personal model.

They do not directly mutate canonical personal data.

```text
Evidence
  ↓
Archivist
  ↓
Proposal
  ↓
Human review
  ↓
Canonical event
```

---

### Local-first, cloud-capable

The core system should be usable locally without relying on a commercial AI provider.

A local configuration may use:

- SQLite
- local files
- Ollama
- llama.cpp

Cloud deployments may use infrastructure such as:

- Cloudflare Workers
- D1
- R2
- Queues
- Vectorize

AWS-compatible adapters may be implemented separately.

Cloud infrastructure is an adapter, not part of the domain model.

---

### Model agnostic

Applications depend on an abstract LLM interface rather than a specific SDK.

Possible providers include:

```text
LLMPort
├── OpenAI
├── Ollama
├── llama.cpp
└── future providers
```

Provider-specific capabilities such as structured output, tool calling, vision, or reasoning controls are modeled explicitly rather than pretending that all models behave identically.

---

### Explainability

A generated conclusion should be inspectable.

A future query such as:

> Why does the system think I value research freedom?

should be answerable with:

- supporting assertions,
- original evidence,
- relevant decisions,
- conflicting evidence,
- temporal context,
- and uncertainty.

---

## Ontology

Personal OS includes an explicit ontology layer.

The ontology defines the concepts the system recognizes and the semantic relationships between them.

Example concepts include:

```text
Person
Organization
Role
Project
Artifact
ResearchTopic
Technology

Evidence
Assertion

Goal
Value
Preference
Belief
Constraint

Decision
Option
Criterion
Outcome
```

Example relations include:

```text
Person ──workedOn────→ Project
Person ──heldRole────→ Role
Role ────in──────────→ Organization

Project ─created─────→ Artifact
Project ─uses────────→ Technology

Evidence ─supports───→ Assertion
Assertion ─about─────→ Person

Decision ─motivatedBy→ Goal
Decision ─constrainedBy→ Constraint
Decision ─resultedIn─→ Outcome
```

The ontology, domain model, and persistence model are intentionally treated as different layers.

```text
Ontology
    What concepts mean

Domain Model
    What behavior and invariants the application enforces

Persistence Model
    How data is stored
```

The v0.1 canonical store is not planned as an RDF or OWL database.

Instead, the system is designed so that portions of the personal model can later be exported to formats such as JSON-LD or RDF.

---

## Architecture

The initial architecture follows a modular monolith using ideas from:

- Domain-Driven Design
- Clean Architecture
- Ports and Adapters
- Dependency Injection
- CQRS
- Event Sourcing
- Outbox Pattern

These patterns are used selectively.

The project deliberately avoids turning architectural terminology into decorative ceremony.

```text
Interfaces
    ↓
Application
    ↓
Domain
    ↑
Ports
    ↑
Infrastructure adapters
```

The domain layer must not depend on:

- Cloudflare SDKs,
- AWS SDKs,
- database drivers,
- ORMs,
- OpenAI SDKs,
- MCP SDKs,
- HTTP frameworks.

Concrete dependencies are connected at the composition root through dependency injection.

---

## Planned repository structure

```text
personal-os/
├── apps/
│   ├── api/
│   ├── cli/
│   ├── mcp-server/
│   └── web/
│
├── packages/
│   ├── domain/
│   ├── application/
│   ├── ports/
│   ├── contracts/
│   ├── adapters-local/
│   ├── adapters-openai/
│   ├── adapters-ollama/
│   ├── adapters-cloudflare/
│   ├── adapters-aws/
│   ├── retrieval/
│   ├── eval/
│   └── observability/
│
├── ontology/
├── docs/
│   ├── adr/
│   └── architecture/
│
├── research/
│   └── python/
│
└── tests/
```

This structure is expected to evolve as the implementation reveals where the real boundaries belong.

---

## Technology direction

The current direction for v0.1 is:

| Area                   | Current direction                      |
| ---------------------- | -------------------------------------- |
| Language               | TypeScript                             |
| Package manager        | pnpm                                   |
| Toolchain              | Vite+ / Oxlint / Oxfmt / Vitest        |
| Local database         | SQLite                                 |
| Local raw storage      | filesystem / content-addressed storage |
| Local LLM              | Ollama / llama.cpp                     |
| Remote LLM             | provider adapters, initially OpenAI    |
| HTTP                   | Hono                                   |
| Agent interoperability | MCP                                    |
| Cloud target           | Cloudflare                             |
| Research / analysis    | Python                                 |

These are **current decisions**, not permanent constraints.

Architecture decisions are recorded as ADRs and should include explicit conditions under which they should be revisited.

---

## v0.1 target

The first version focuses on infrastructure rather than sophisticated personality simulation.

A representative vertical slice is:

```text
Import evidence
      ↓
Store raw source
      ↓
Create assertion proposal
      ↓
Human review
      ↓
Append event
      ↓
Update projection
      ↓
Search assertion
      ↓
Explain its provenance
```

A later v0.1 slice extends this toward decision simulation:

```text
Past decisions
      +
Relevant evidence
      +
Current state
      ↓
Context Builder
      ↓
LLM / local model
      ↓
Predicted decision
      ↓
Critic
      ↓
Evidence-grounded result
```

---

## What this repository does not contain

This repository is intentionally public.

It is **not** intended to contain the personal dataset used by a deployed Personal OS instance.

In particular, this repository must not contain:

- private conversations,
- email archives,
- personal documents,
- private decision logs,
- credentials,
- API keys,
- access tokens,
- sensitive embeddings,
- production databases,
- personal model snapshots.

Those belong in separately managed private storage.

The public repository contains the software, schemas, ontology, documentation, tests, and synthetic fixtures needed to build Personal OS.

---

## Privacy model

Personal data is expected to be classified approximately as:

```text
P0  Public
P1  Personal
P2  Sensitive
P3  Restricted
```

A core requirement is that restricted information can be processed locally without being sent to a remote model provider.

For example:

```text
P3 data
   ↓
Provider policy
   ↓
Local model only
```

Privacy enforcement should be testable behavior, not merely a prompt instruction.

---

## Learning project

Personal OS is also deliberately being built as a learning project.

The implementation is intended to explore, through actual code:

- domain modeling,
- DDD,
- dependency inversion,
- dependency injection,
- event-driven architecture,
- temporal data modeling,
- ontology design,
- relational and semantic retrieval,
- local LLM inference,
- LLM provider abstraction,
- MCP,
- cloud infrastructure,
- security,
- evaluation,
- observability.

Important abstractions should be introduced only after understanding the concrete problem they solve.

For core architecture, being able to explain the implementation is considered part of the definition of done.

---

## Development status

```text
v0.1 — in progress
```

Current focus:

```text
Environment
→ Domain model
→ Clean Architecture
→ Dependency Injection
→ Evidence / Assertion vertical slice
→ Event history
→ Ontology
→ Retrieval
→ LLM providers
→ Context Builder
→ Agents
→ MCP / HTTP
→ Cloud deployment
```

The architecture is expected to change substantially while these ideas are tested in implementation.

---

## Research influences

The project is influenced by work on:

- long-term memory for language-model agents,
- generative agents,
- personal simulation,
- lifelogging,
- provenance,
- ontologies and knowledge representation,
- human-computer interaction,
- and agent interoperability.

Some relevant starting points include:

- _Generative Agents: Interactive Simulacra of Human Behavior_
- _MemGPT: Towards LLMs as Operating Systems_
- _LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory_
- _LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals_
- W3C PROV
- OWL 2
- JSON-LD
- Model Context Protocol

A more complete bibliography will be maintained in the project documentation.

---

## Project philosophy

The central question behind Personal OS is not:

> How much information can an AI remember about a person?

It is:

> How can a changing human being be represented computationally without erasing uncertainty, history, provenance, contradiction, and agency?

That means the project treats the following as first-class concerns:

```text
Evidence
Time
Contradiction
Uncertainty
Provenance
Human authority
Portability
```

A system that generates convincing personal responses but cannot explain where its model came from is not sufficient.

---

## Contributing

The project is currently an early-stage personal research and learning project.

Issues, architectural discussion, and research references are welcome as the design develops.

The interfaces and architecture are not yet stable.

---

## License

No open-source license has been selected yet.

The repository being publicly accessible does **not** by itself grant permission to copy, modify, or redistribute its contents.

A license will be chosen explicitly once the project structure and intended collaboration model become clearer.
