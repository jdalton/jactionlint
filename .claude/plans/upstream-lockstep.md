# Upstream lock-step for jactionlint

## Goal

Keep jactionlint's actionlint-derived behavior reviewable against pinned upstream actionlint, make the upstream fixture corpus available on fresh developer and CI checkouts, and provide a repeatable script path for advancing or rematerializing upstream pins. `.gitmodules` is the single source of truth for each pinned SHA and human release label; `.config/repo/lockstep.json` records relationship and review policy without duplicating the SHA.

## Current state

- `upstream/actionlint` is pinned in `.gitmodules` to `914e7df21a07ef503a81201c76d2b11c789d3fca # v1.7.12`, with a shallow sparse checkout of top-level Go implementation files, `go.mod`, `go.sum`, `cmd/**`, and the upstream `testdata/err/**` and `testdata/examples/**` trees. Its `go.mod` keeps the ignored checkout out of jactionlint's `go test ./...` package traversal.
- The compatibility test uses jactionlint's curated local corpus and expected outputs. The pinned upstream fixture corpus has meaningful content and diagnostic drift, so candidate fixture changes need an explicit review instead of substituting upstream `.out` files as jactionlint's golden output.
- `upstream/` is ignored and the upstream checkout is not tracked as a gitlink.
- The current setup is not complete for fresh clones: CI does not materialize the ignored upstream checkout, and there is no jactionlint-owned updater/materializer command yet.
- `SocketDev/sdxgen` has a full lockstep manifest with version-pin rows and dedicated upstream update/setup scripts. Its cdxgen row keeps `.gitmodules` authoritative and requires verification before accepting a candidate.
- The SHA can be resolved from `ref`; this upstream has public release tags through `v1.7.12` in the current remote listing. Keep the existing `ref = <sha> # v1.7.12` display format, and follow the repository's release-branch, shallow-single-branch, and archive-hash conventions where adopted.

## Design rules

1. Keep upstream checkouts in ignored root `upstream/<name>` directories. Never stage a gitlink.
2. Keep exactly one committed SHA per upstream in `.gitmodules`, formatted as `ref = <40-hex> # <release-tag>`. The lockstep row may carry the tag for readable reports, but must not copy the SHA.
3. Keep the checkout shallow and sparse to all paths needed to understand the reference. Inventory actionlint implementation, generated data, source generators, and compatibility fixtures before setting the sparse cone; fixture-only checkout cannot support full source reconciliation. Declare the consumed scope as `materialization: "sparse"` plus `sparse_cone` in the lockstep row.
4. Separate materialization from pin acceptance. Provide `setup [name|--all]` for the accepted pin, `check` for offline integrity, `update --plan` for candidate discovery, `verify` for candidate replay, and `update --apply` for an explicitly accepted candidate. Setup verifies detached HEAD equals `.gitmodules` `ref`, honors the exact sparse patterns, and refuses dirty or mismatched checkouts. Resolve annotated release tags to commit SHAs, reject prereleases and unintended downgrades, fetch the old and candidate SHAs explicitly, and report drift as unknown when shallow history cannot establish it.
5. An update must not silently bless behavior drift. Classify changed source, generated data, fixture, and packaging paths; report added/removed fixtures, changed outputs, local overlay mismatches, and behavior changes not covered by a test. Any unresolved or unmapped applicable change blocks acceptance, as in sdxgen's cdxgen verification flow.
6. Define a versioned verification receipt with accepted SHA, candidate SHA and path, changed files, verification-input digest, per-check results, change classifications, failures, and skipped coverage. The existing compatibility test covers a curated jactionlint corpus with local golden outputs; upstream fixture and diagnostic content has meaningful drift, so do not point this gate at upstream `.out` files. Run the local compatibility regression and list every candidate upstream change for explicit review. Apply `.gitmodules` and manifest tag changes only after the receipt passes and review is explicit; restore old metadata and checkout if apply fails.
7. CI must materialize and integrity-check the accepted pin before Go tests. Make required ShellCheck/Pyflakes coverage explicit in CI; report exercised and skipped fixtures, detect missing `.out` files and stale local config/exception entries, and do not treat a skipped compatibility case as a pass. Document that the current compatibility assertion guarantees upstream-expected diagnostics remain present while permitting additional jactionlint diagnostics.
8. Inventory all referenced upstream projects and source/data provenance. Create upstream rows for implementation, fixture, generator, or corpus sources whose contents jactionlint directly compares or derives from; keep ordinary Go module dependencies under `go.mod`/`go.sum` unless separately reviewed as source references.
9. Do not import the fleet's Node lockstep runtime wholesale. Keep the updater focused and use Node only for its own tasks: use a compatible existing Node.js on `PATH`, with a task-scoped `mise exec node@lts` fallback when needed. Do not add Node to the project's general tool selection or modify shell startup and global mise settings. Keep deterministic setup/checking in regular CI; keep network release discovery in an explicit update flow (or scheduled workflow).
10. Borrow the wheelhouse separation of **declaration, materialization, and acceptance**: `.gitmodules` declares provenance/pin; setup scripts only materialize that pin; lockstep verification reports drift; a separate explicit update/apply step changes the accepted pin. CI setup must not update pins. Keep the no-gitlink invariant mechanically checked, and make `check` offline and deterministic.
11. Use mise for the project's own executable tool versions and update cadence. Do not implement another tool version checker or let mise's tool auto-update policy rewrite the upstream source pin. These are separate inputs: mise keeps Go, ShellCheck, Pyflakes, and other development tools current; the upstream manager reviews and updates the actionlint repository SHA/tag.

## Plan

1. **Inventory references and finish the pin contract.** Search source, generators, tests, docs, and copied fixture metadata for upstream-derived behavior/data. Record which source projects need pins. Keep `.gitmodules` as authoritative SHA/label record, and provision any adopted codeload archive hash atomically with the pin. Keep `.config/repo/lockstep.json` declarations SHA-DRY: one row per tracked upstream, with correct sparse/full materialization, cone, upgrade policy, criticality, and verification input contract. Add a schema reference only if the matching schema is present and validated.

2. **Build a focused Go upstream manager.** Add `scripts/upstream` with `setup`, `check`, `update --plan`, `verify`, and `update --apply` commands. Parse `.gitmodules` safely, clone/fetch detached SHAs with release-tag single-branch shallow semantics, apply the declared sparse cone, and verify archive integrity if the hash convention is adopted. Plan mode reports candidate tag/SHA and changed paths without writes. Verification uses an isolated candidate materialization and emits the versioned receipt. Apply requires a fresh passing receipt, updates pin metadata atomically, and can recover from interruption. Keep candidate work outside the accepted checkout and clean it reliably.

3. **Make compatibility inputs and source reconciliation explicit.** Keep `actionlint_compat_test.go` bound to jactionlint's curated YAML and `.out` fixtures, including local `.config` overlays. The updater hashes those inputs, runs the regression gate, classifies every upstream path change, and requires `--accept-reviewed` whenever the candidate differs. Unknown change classes and failing regressions block apply. Review the upstream implementation and fixture diffs directly from the candidate report.

4. **Wire setup into developer and CI flows.** Add `mise` tasks for setup, check, update plan, verify, and apply, and ensure those tasks use the existing mise-managed Go/ShellCheck/Pyflakes tools instead of downloading tool binaries themselves. Run setup and check in the CI test job before `go test`; keep checkout recursion off because ignored gitlink-free references are materialized by the manager. Make ShellCheck/Pyflakes required where upstream fixtures need them. Document setup and update review in contributor docs.

5. **Add updater-focused tests.** Cover `.gitmodules` parsing including inline SHA labels, annotated tags, prerelease/downgrade rejection, archive hash verification, sparse setup, detached pin checks, dirty/mismatch refusal, candidate change classification, verification receipt input binding/staleness, missing history, failed checks, no-write plan mode, and interrupted apply recovery. Use temporary local repositories and fake verifier commands so the core suite is offline and deterministic.

6. **Document the acceptance loop.** Explain how to inspect upstream changes, run the update candidate, review fixture/golden changes, accept the new SHA and tag, and rerun compatibility checks. Record that release tags are preferred and the current pin never moves without an explicit reviewed update.

7. **Add lightweight code-as-law checks.** Following wheelhouse, enforce at least these invariants in CI: every `upstream/` reference has a URL, release-tag `branch`, full SHA `ref`, and `shallow = true`; sparse references declare their consumed paths; `upstream/` is ignored; no `upstream/` gitlink is tracked; the lockstep manifest references a real `.gitmodules` entry and does not carry a duplicate SHA. Keep the checks pure/offline; network tag freshness belongs to the explicit update planner.

8. **Keep mise updates distinct from upstream updates.** Review the current `mise.toml` tool pins and `.mise/config.toml` policy before changing them. Add/adjust mise auto-update intervals only for CLI tools where the project wants moving versions; retain fixed versions for tools with known compatibility constraints (for example staticcheck vs. Go export data). The actionlint pin update remains a candidate-and-verify operation; `mise upgrade` must never change `.gitmodules`.

## Verification

- Run the updater's unit tests against temporary repositories, including failure-path checks for moved tags, unavailable SHAs/history, dirty checkouts, stale receipts, and interrupted apply.
- From a clean checkout without `upstream/actionlint`, run `mise run setup:upstream`, then the focused compatibility test.
- Run the full Go test suite after setup.
- Run the check-only updater path and confirm it leaves `.gitmodules`, lockstep metadata, and the working tree unchanged.
- Review `git diff --check`, confirm `git ls-files --stage upstream/` contains no entries, and confirm `.gitignore` excludes `upstream/`.
- Exercise candidates with failing and unknown classifications and confirm the accepted pin remains unchanged. Confirm a passing receipt becomes stale if any verification input changes.
- Run the static upstream-contract checks offline and confirm malformed `.gitmodules`, missing sparse declarations, duplicate manifest SHAs, and an accidentally staged gitlink each fail with a direct repair hint.

## Implementation choice

Use Node for repository orchestration and mise tasks. Keep jactionlint behavior and compatibility coverage in Go. The Node manager owns git operations, `.gitmodules` and manifest consistency, archive checksum calculation, candidate change reporting, and the reviewed apply transaction.
