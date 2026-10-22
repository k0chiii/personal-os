# Personal Ontology v0.1 competency questions

The ontology vocabulary is a semantic contract, not the TypeScript domain or SQLite schema. Stable
identifiers use `https://personal-os.dev/ontology/v0.1#<term>`. Adding a vocabulary term does not
require an ER change until executable behavior or persistence is required.

| Question | Answering data and relations                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CQ-01    | `Assertion.evidenceIds` and `Evidence supports Assertion`; exposed by provenance lookup.                                                         |
| CQ-02    | `Assertion.validFrom` and `validUntil`; temporal search uses the half-open interval.                                                             |
| CQ-03    | The `assertion.superseded` event carries previous and successor Assertions; `supersedes` is the semantic relation.                               |
| CQ-04    | Decision criteria, constraints, evidence, rationale, and the `motivatedBy` / `constrainedBy` relations. Goals are vocabulary-only in v0.1.       |
| CQ-05    | `Person workedOn Project`, `Project created Artifact`, and `Project used Technology`. These are vocabulary-only in the current executable model. |
| CQ-06    | `Person interestedIn ResearchTopic` plus supporting Evidence. This is vocabulary-only in the current executable model.                           |
| CQ-07    | Assertion `epistemicOrigin`, Evidence links, and `contradicts`; automated contradiction projection remains future work.                          |
| CQ-08    | Temporal Assertion queries at each instant, compared by subject, predicate, object, and supersession history.                                    |
| CQ-09    | `Assertion.epistemicOrigin`, whose values distinguish `self_stated` from `agent_inference`.                                                      |
| CQ-10    | `privacyClass` plus provider routing; P3 is denied to remote providers by executable policy and tests.                                           |

## Change log

- v0.1: established versioned classes, core relations, temporal/epistemic properties, definitions,
  domain/range expectations, stable identifier policy, and CQ-01 through CQ-10 mapping.
