# ADR-0002: Enforce architecture dependency boundaries with Oxlint

## Status

Accepted

## Context

Personal OS is structured as a modular monolith with explicit package boundaries.

The repository contains packages such as:

```text

packages/domain

packages/application

packages/ports

packages/contracts

packages/adapters-local

packages/adapters-openai

packages/adapters-ollama

packages/adapters-cloudflare

packages/adapters-aws

```

Separating these packages into directories and registering them in a pnpm workspace does not by itself enforce architectural dependency direction.

pnpm primarily defines:

- which packages belong to the workspace

- how workspace packages resolve each other

It does not understand architectural constraints such as:

```text

domain must not depend on adapters

```

Personal OS treats inward dependency direction as an important architectural invariant.

For example, the following dependencies are forbidden:

```text

domain ──────X──────> adapters-local

domain ──────X──────> adapters-openai

domain ──────X──────> adapters-cloudflare

```

while infrastructure adapters may depend inward on Domain or Ports:

```text

adapters-local ─────> domain

adapters-local ─────> ports

```

These rules should not exist only as documentation or code-review conventions. They should be mechanically enforceable.

The relevant distinction is:

```text

unit / integration test

  → verifies runtime behavior

architecture dependency check

  → verifies static source structure

```

Architecture dependency enforcement therefore belongs to static analysis rather than runtime testing.

## Initial Investigation

Several approaches were considered.

The first serious candidate was dependency-cruiser because it is specifically designed to analyze JavaScript and TypeScript dependency graphs.

It supports concepts such as:

- forbidden dependency directions

- circular dependency detection

- module dependency graph inspection

- declarative architecture rules

A configuration was initialized locally and the environment was inspected with:

```bash

pnpm exec dependency-cruiser --info

pnpm exec dependency-cruiser --init

```

The repository was correctly detected as:

- a monorepo

- an ESM project

- a TypeScript project using the shared TypeScript configuration

However, dependency-cruiser 18.5.0 reported:

```text

typescript   >=2.0.0 <7.0.0

```

while Personal OS currently uses TypeScript 7.0.2.

As a consequence, dependency-cruiser did not enable TypeScript source analysis:

```text

x .ts

x .tsx

x .d.ts

```

Using dependency-cruiser would therefore require either:

1. downgrading the repository from TypeScript 7, or

2. running an architecture analyzer outside its declared TypeScript compatibility range

Neither option was considered desirable.

Downgrading TypeScript solely for architecture enforcement would make the broader toolchain conform to a secondary analysis tool rather than the other way around.

Running an unsupported parser configuration would weaken confidence in the architecture enforcement mechanism itself.

This triggered a reconsideration of tools already available in the existing Vite+ / Oxlint toolchain.

## Decision

Personal OS v0.1 will use Oxlint as the source-level architecture dependency enforcement mechanism.

Architecture constraints will be expressed through Oxlint rules in the existing Vite+ lint configuration.

No separate architecture test runner or dependency-analysis command will be introduced for v0.1.

The initial enforcement consists of two mechanisms.

### Restricted dependency directions

Source files under:

```text

packages/domain/**

```

must not import infrastructure adapter packages.

Package-level imports such as:

```ts
import { Something } from "@personal-os/adapters-local";
```

are prohibited.

Type-only imports are also considered architectural dependencies:

```ts
import type { Something } from "@personal-os/adapters-local";
```

and are prohibited as well.

Relative imports that bypass package names are also forbidden.

For example:

```ts
import type { Something } from "../../adapters-local/src/something";
```

must not be used as an escape hatch around the package boundary.

This rule is implemented using Oxlint's `no-restricted-imports`.

Conceptually:

```text

packages/domain/**

        X

        └── packages/adapters-*

```

### Circular dependencies

Circular source dependencies are also treated as architecture violations.

For example:

```text

A → B → C → A

```

must be rejected.

Oxlint's `import/no-cycle` rule is enabled for this purpose.

Type-only dependencies are included in the cycle analysis because architectural coupling exists even when the dependency disappears after TypeScript compilation.

## Current Configuration

The Vite+ lint configuration includes the `import` plugin in addition to the existing TypeScript plugin.

Conceptually:

```ts
plugins: ["typescript", "import"];
```

Circular dependencies are rejected with:

```ts

"import/no-cycle": [

  "error",

  {

    ignoreTypes: false,

  },

];

```

Domain-specific boundary enforcement is applied through an override:

```ts

{

  files: ["packages/domain/**/*.ts"],

  rules: {

    "no-restricted-imports": [

      "error",

      {

        patterns: [

          {

            group: ["@personal-os/adapters-*"],

            message:

              "Domain must not depend on infrastructure adapters.",

          },

          {

            regex:

              "^(\\.\\./)+(packages/)?adapters-[^/]+(/|$)",

            message:

              "Domain must not bypass package boundaries with relative imports.",

          },

        ],

      },

    ],

  },

}

```

The configuration therefore treats architecture enforcement as part of the repository's normal static-analysis pipeline.

## Enforcement Model

The resulting enforcement structure is:

```text

vite.config.ts

      ↓

Oxlint architecture rules

      ↓

vp check

      ↓

CI

```

The architecture rules live alongside the other static-analysis rules rather than behind a separate command.

This intentionally avoids introducing:

```text

pnpm check:arch

```

for v0.1.

Instead:

```text

vp check

├── lint

├── type-aware checks

├── architecture boundary rules

└── circular dependency rules

vp test

├── unit tests

└── integration tests

```

Static architecture constraints therefore remain separate from behavioral tests while still sharing the existing static-analysis entry point.

## Verification

The architecture rule was verified with an intentional violation.

A temporary dependency from Domain to `adapters-local` was created using a relative TypeScript import.

Running:

```bash

vp check

```

failed as expected.

The temporary violation was then removed and `vp check` returned to a passing state.

This confirms that the configured rule is not merely present in configuration but actively prevents the dependency direction it is intended to prohibit.

## CI Policy

CI is the authoritative enforcement mechanism.

The existing CI pipeline already runs:

```text

vp check

vp test

```

Because architecture enforcement is integrated into `vp check`, no additional CI command is required.

A Pull Request containing a prohibited architecture dependency will cause `vp check` to fail and therefore prevent the CI check from passing.

The resulting structure is:

```text

Oxlint configuration

        ↓

architecture rule Source of Truth

        ↓

vp check

        ↓

local static feedback

        ↓

CI

        ↓

authoritative enforcement

```

## Local Git Hook Policy

Git hooks may be introduced later as an additional developer-feedback mechanism.

Because architecture validation is already part of `vp check`, a future hook can invoke the existing static-analysis workflow rather than introducing a second architecture-specific command.

Possible strategies include:

```text

pre-commit

  → lightweight lint or targeted static checks

```

or:

```text

pre-push

  → vp check

  → vp test

```

The choice should be based on measured execution time and developer experience.

Git hooks are not considered authoritative because they can be bypassed.

CI remains the final enforcement layer.

## Package Manifest Validation

Oxlint currently enforces source-level dependencies.

This is distinct from dependencies declared in `package.json`.

For example, the following declaration is architecturally suspicious even if no source file imports it yet:

```json
{
  "dependencies": {
    "@personal-os/adapters-local": "workspace:*"
  }
}
```

A source-level import rule alone does not guarantee detection of every invalid manifest dependency.

Long term, architecture enforcement may therefore consist of two layers:

```text

Architecture Enforcement

├── Oxlint

│   ├── source import restrictions

│   └── circular dependency detection

│

└── manifest validation

    └── package.json dependency declarations

```

For v0.1, source-level enforcement is considered sufficient.

Manifest-level validation will be added if package dependency declarations become complex enough to justify a separate mechanism.

## Alternatives Considered

### Alternative A: dependency-cruiser

dependency-cruiser was initially the preferred option because architecture dependency analysis is its primary purpose.

Advantages include:

- declarative dependency graph rules

- circular dependency detection

- dedicated dependency analysis

- architecture-oriented reporting

- scalability to larger dependency graphs

It was also tested directly in the Personal OS repository.

However, dependency-cruiser 18.5.0 currently supports TypeScript versions below 7 while Personal OS uses TypeScript 7.0.2.

Its environment inspection therefore did not enable TypeScript source parsing.

Adopting it would require changing the primary TypeScript toolchain for the sake of a secondary analysis tool or relying on an unsupported configuration.

Additionally, after inspecting the existing Oxlint capabilities, the rules required for v0.1 were found to already exist in the current toolchain.

Introducing dependency-cruiser would therefore add:

- another development dependency

- another configuration file

- another execution command

- another tool lifecycle to maintain

without providing enough additional value at the current architecture scale.

dependency-cruiser is therefore not adopted in v0.1.

It remains a possible future option if its TypeScript compatibility and the repository's requirements change.

### Alternative B: Repository-Owned Architecture Tests

Architecture rules could be implemented as Vitest tests.

For example, a custom test could scan source files or `package.json` files for prohibited dependencies.

This would avoid introducing a dedicated architecture tool.

However, accurate dependency analysis quickly requires handling:

```text

static import

re-export

dynamic import

type-only import

module resolution

package aliases

circular dependencies

transitive dependencies

```

Implementing these correctly would gradually recreate a dependency-analysis tool inside Personal OS.

Architecture dependency analysis is not part of the Personal OS product domain.

Additionally, architecture structure is a static-analysis concern rather than a runtime behavioral concern.

For these reasons, architecture enforcement is not implemented as a normal Vitest suite.

### Alternative C: Documentation Only

Architecture rules could exist only in:

```text

docs/architecture/

```

and be enforced through code review.

This has minimal tooling cost but provides no machine enforcement.

As the repository grows, architectural violations would increasingly depend on reviewer awareness and memory.

Because dependency direction is treated as an important invariant, documentation alone is insufficient.

### Alternative D: TypeScript Configuration Only

TypeScript project configuration and module resolution can influence which imports resolve successfully.

However, `tsconfig` is primarily responsible for TypeScript compilation, module resolution, and type checking.

Using it as the primary architecture-policy mechanism would overload its responsibility and make architecture rules less explicit.

Architecture policy therefore remains separate from TypeScript compiler configuration.

### Alternative E: Nx Module Boundary Rules

Nx provides richer project-level module-boundary enforcement and could eventually express package dependency matrices through project metadata and tags.

For example:

```text

type:domain

type:application

type:adapter

type:app

```

could potentially be used to define allowed package relationships.

This is more expressive than the current Oxlint configuration.

However, adopting Nx would introduce an additional monorepo/project-graph layer into a repository that currently uses pnpm workspace and Vite+ successfully.

For the v0.1 rule set, this would add unnecessary infrastructure.

Nx may be reconsidered if the package dependency graph becomes substantially more complex.

## Consequences

### Positive

Architecture rules are machine-checkable.

TypeScript 7 can remain in use.

No additional architecture-analysis dependency is required.

Architecture enforcement uses the existing Vite+ / Oxlint toolchain.

No additional CI command is required.

Architecture validation remains a static-analysis concern instead of being modeled as a runtime test.

Domain-to-adapter imports are rejected.

Relative-import attempts to bypass package boundaries are rejected.

Type-only dependencies are treated as architectural dependencies.

Circular dependencies can be detected.

The same `vp check` command works locally and in CI.

The architecture rule has been verified with an intentional negative case.

### Negative

Oxlint's current rule set is less expressive than a dedicated full dependency-graph architecture tool.

The architecture policy is distributed through lint overrides rather than represented as a complete package dependency matrix.

Source-level enforcement does not automatically validate every `package.json` dependency declaration.

As the number of packages and architectural rules grows, `no-restricted-imports` configuration may become difficult to maintain.

The architecture configuration is coupled to the Vite+ / Oxlint toolchain.

## Revisit Conditions

This decision should be revisited if any of the following occur:

- package-level dependency rules grow substantially

- maintaining allowed and forbidden imports through lint overrides becomes difficult

- a complete dependency matrix is required

- manifest dependencies must be enforced alongside source imports

- cross-bounded-context rules become significantly more complex

- visualization of the dependency graph becomes important

- Oxlint no longer provides sufficient analysis capabilities

- dependency-cruiser gains suitable TypeScript 7 support and offers clear additional value

- Nx or another project-graph tool becomes justified by broader repository requirements

- architecture policy begins to be generated from repository metadata or ontology definitions

A future migration should preserve the same architectural invariant even if the enforcement tool changes.

## Related Requirements

- ENV-056

- ENV-057

- ENV-058

- ENV-059

- ENV-DOD-03

- ENV-DOD-05

- ENV-DOD-06

## Related ADRs

- ADR-0001: Adopt Vite+ as the unified TypeScript toolchain
