# Unperformed release gates — 2026-11-15

These gates are **not evidence of failure**; they are unexecuted. They keep the release
decision `blocked` until each produces a retained artifact.

## migration-matrix

- Command/procedure: Forward 0049→0054 and roll back 0054→0049 on SQLite, PGlite and live PostgreSQL, then restore and verify.
- Blocking reason: Not executed in this batch: this workstation has no PostgreSQL server and no Docker. Must run in CI with the pgvector service before Gate-0 exit.

## clean-machine-golden-path

- Command/procedure: 14-step golden path on a pristine machine: init → capture → governed task → approval → execute → crash recovery → export/import.
- Blocking reason: Not executed in this batch: requires a clean supported machine and a built frontend. Owner: W4.

## security-triage-review

- Command/procedure: Independent review of the security triage matrix and retest evidence.
- Blocking reason: Reviewer not yet assigned (E10-S30). Only that reviewer may close this record.

