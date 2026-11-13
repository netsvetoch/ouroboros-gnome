# Verification snapshot for handoff

Full run selected 207 tests and was intentionally interrupted for the user-requested pause/handoff. It is **not green or complete**: 67 tests passed (plus build), 2 failed, and the active test was interrupted with exit 130.

- `full-suite-report.json`: annotated interruption report; original individual failure statuses retained.
- `full-suite-test-routing-protocol-gjs.log`: real assertion failure; see HANDOFF.md for the unproven race hypothesis.
- `routing-protocol-isolated-retry.log`: isolated pass on unchanged source; does not resolve the flake.
- `full-suite-test-routing-journal-gjs.log`: prepare succeeded, recover failed to open Xvfb display.
- `full-suite-test-subagent-availability-gjs.log`: process interrupted for pause, not evidence of product failure.
- `settings-recovery/`, `login-receipt/`, `continuous-speech/`: successful selected reports plus their logs.

Report paths may refer to the original machine's `/tmp` directories. Copied logs are present locally by filename. `inputs_sha256` covers the source snapshot used by each run; documentation and handoff packaging changes are not product validation changes. Older selected reports do not prove later source revisions.

`diff-check.log` records cosmetic whitespace findings in three existing source EOFs and the copied upstream license. They were preserved during handoff rather than changing validated product inputs or upstream license bytes. This is not a claim of a clean `git diff --check`.

A credential-pattern scan matched only the literal PEM marker with dummy `private bytes` in `tests/review-diagnostic.test.mjs`; it is an intentional redaction test fixture. No private key material is present in that fixture.
