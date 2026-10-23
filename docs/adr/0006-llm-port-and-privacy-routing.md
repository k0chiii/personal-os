# ADR 0006: Keep provider behavior behind an LLM port

## Context

Personal OS must run locally, switch providers without changing use cases, and prevent P3 content
from reaching remote services.

## Decision

Application code depends on `LlmPort`. Mock, Ollama, llama.cpp, and OpenAI adapters normalize output
and errors. A provider router filters remote providers before invocation when a request includes P3,
then falls back only across eligible providers. Retrieved content is serialized as data under a fixed
system instruction.

## Alternatives

- Provider SDK types in Application would couple use cases to one vendor.
- Prompt-only privacy rules could still transmit restricted data before the model sees the prompt.

## Consequences

The shared port covers common behavior, while capability flags expose meaningful differences. New
provider-specific features may require explicit capability extensions rather than a lowest-common-
denominator abstraction.

## Revisit condition

Revisit when streaming, tool calls, embeddings, or provider-specific reasoning controls become an
executable use case.
