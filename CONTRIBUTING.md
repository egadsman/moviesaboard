# Contributing

MoviesAboard is early. The fastest way to help: read the
[roadmap](docs/ROADMAP.md), find the current phase, and open an issue to
discuss before writing significant code.

## Dev setup

- Node 20+ (CI runs 22). Plain JavaScript ES modules — no TypeScript, no
  build step.
- `npm install`, then `npm test` (Node's built-in test runner).

## Ground rules

- [docs/contracts.md](docs/contracts.md) defines the stable data contracts.
  Changing a contract needs an issue and discussion first.
- Everything in `packages/core` stays **pure**: no I/O, no clock reads, no
  environment access. Pass data in, get data out.
- All timezone math flows through the core time module
  (`packages/core/lib/time.js`). Never hand-roll UTC offsets.
- Tests accompany code. Deterministic outputs (schedules, plans) get
  golden-file tests with fixtures checked in.
- Markdown prose wraps at 80 columns (`.markdownlint.json` enforces; tables
  are exempt).

## Pull requests

- Small and focused beats large and sweeping.
- CI must pass: tests, markdownlint, shellcheck.
- By contributing you agree your work is licensed AGPL-3.0-or-later.
