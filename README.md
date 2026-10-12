# Aviation ML card fleet summary action (draft v0.1)

A read-only GitHub Action that summarizes draft aviation ML assurance and AI-assisted maintenance review cards in a pull request. It fails when a declared ODD condition has no HTTPS evidence reference, when a Level 2B/3A card lacks a disclosed human override path under the **Kinetic Gain conservative profile**, or when an MRO card lacks artifact digest, human review, and embedded-signature fields.

This action is a fast structural gate. It **does not** fetch evidence, validate full JSON Schemas, verify Ed25519 signatures, identify certifying staff, decide airworthiness, or authorize return to service. Run the relevant card-spec validator and independent signature/authority checks as separate gates before a regulated workflow. A complete declaration is not a certification decision.

## Use

Pin this action to a reviewed commit SHA when the repository is published. Supply newline-separated, workspace-relative paths:

```yaml
name: Aviation card checks
on: [pull_request]
permissions:
  contents: read
jobs:
  cards:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.0.2, Node 24
      - uses: mizcausevic-dev/aviation-ml-card-fleet-summary-action@PIN_REVIEWED_COMMIT_SHA
        with:
          aviation_cards: |
            examples/synthetic-aviation-card.json
          mro_cards: |
            examples/synthetic-mro-card.json
```

At least one card path is required. At most 500 cards and 1 MiB per card are accepted. Paths cannot escape the workspace. The action reads local JSON only and uses no network API or token. It writes a short gate result to the GitHub job summary. Because file paths and findings appear in CI logs, **do not place customer maintenance records, defense technical data, personal data, or restricted evidence in a public PR**.

## Rules

- `assurance.easa_ai_level` permits only `1A`, `1B`, `2A`, `2B`, or `3A`; 3B is reserved outside this draft profile.
- For `2B` or `3A`, `human_ai_teaming.human_override_available` must be true and `override_procedure_ref` must be HTTPS. This is a **Suite disclosure policy**, not a quoted EASA requirement.
- Every `odd.operating_conditions` entry needs a unique matching `odd.condition_evidence` row with at least one HTTPS `evidence_refs` URL. URL reachability and actual coverage remain unverified.
- An MRO card needs a 64-character lowercase `artifact.sha256`, an HTTPS `human_review.authority_ref`, UTC review/signature timestamps in order, and populated embedded-signature metadata/bytes. `override` requires a reason and other decisions must omit it. Presence does not prove cryptographic validity or staff authority.

The action rejects missing inputs, malformed or ambiguous JSON (including duplicate keys and unsafe integer literals), oversized files, and unsafe paths. It does not print card contents. See [the card schemas](https://github.com/mizcausevic-dev/aviation-ml-assurance-card-spec) and [MRO sign-off spec](https://github.com/mizcausevic-dev/mro-ai-signoff-card-spec) for the full document contracts once those repositories are published.

## Local verification

```text
npm test
node --check dist/index.cjs
```

`package.json` is private and there are no runtime or development package dependencies. Tests include a known-positive control and missing-override, missing-ODD-evidence, unsigned-MRO, malformed or ambiguous JSON, path-traversal, and untrusted-output negatives. The action runs on Node 24. Licensed AGPL-3.0-only, matching the existing Suite fleet-summary Actions.
