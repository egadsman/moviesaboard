# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately via GitHub: on
<https://github.com/egadsman/moviesaboard>, open the **Security** tab and
choose **Report a vulnerability** (this needs a GitHub account). Please
don't open public issues or discussions for vulnerabilities.

## Supported versions

Only the `main` branch is supported. There are no release branches yet;
fixes land on `main`.

## Scope and posture

The deployed surface is intentionally static: viewer pages, encoded HLS
content, and `schedule.json`, served by the operator's own web server or
the provided nginx stack, with the tiny station API proxied through and
never published directly.

The demo server (`scripts/demo-server.js`) is a development convenience,
not hardened for the public internet, and runs with no authentication.
It does validate requests — malformed URLs and NUL bytes are rejected,
resolved file paths must stay inside the serving directories, and POST
bodies are capped at 16 KB — but exposing it directly to the internet is
not a supported configuration.

Vote submission (`POST /api/vote`) is the only write path. It accepts a
JSON body of at most 16 KB, rejects slugs not on the current ballot,
truncates the client-supplied voter id to 64 characters, and keeps votes
in memory only (they reset on restart). There is no rate limiting and
voter identity is client-supplied, so ballot stuffing is possible by
design — it's a demo ballot, not an election.

## Out of scope

- Vulnerabilities in the operator's own web server (nginx or otherwise).
- Vulnerabilities in ffmpeg, or in media files the operator encodes.
- Ballot stuffing on the demo vote endpoint (see above).
- Denial of service against a demo server deliberately exposed to the
  public internet.
