# hookcase

`hookcase` is a dependency-free Bun/TypeScript CLI for deterministic webhook fixture contracts. It turns a checked-in event document plus an environment secret into a reproducible HTTP request fixture, checks captured fixtures, and prints a curl/script-free request summary for integration tests.

The wedge is exactness: webhook integrations commonly fail at the signature, header, or body-byte boundary. Hookcase is a fixture generator and validator. It is not a tunnel, webhook receiver, SaaS, delivery service, proxy, or network replay tool.

## Hypothesis and evidence

Hypothesis: teams maintaining webhook integrations will find a small checked-in contract useful when it makes body bytes, headers, timestamps, and HMAC validation deterministic in one local command.

Evidence is deliberately classified:

- **Measured:** a local incumbent comparison (below) shows that hand-written JSON plus `openssl dgst -sha256 -hmac` can produce a signature, while the composed commands do not enforce Hookcase's canonical body, timestamp/nonce bounds, header contract, fixture schema, deterministic IDs, and validation in one command. This is a workflow comparison, not a claim that the tools cannot be composed.
- **Documented:** the contract and its limits are explicit here and enforced by the test suite: POST only, JSON only, bounded fields, canonical body bytes, sorted headers, timestamp-bound HMAC, and environment-only secret input.
- **Reported:** GitHub searches on 2026-09-23 found public webhook-testing activity including [inngest/typedwebhook.tools](https://github.com/inngest/typedwebhook.tools) (306 stars), [ar27111994/webhook-debugger-logger](https://github.com/ar27111994/webhook-debugger-logger) (27), [keatinge/webhook-replay](https://github.com/keatinge/webhook-replay) (16), and newer Hooklet (7). HN Algolia reported discussions including “Show HN: wt.dev - Dev tool for testing webhooks and email sending” (8 points), “Show HN: Replayable webhook hub” (2), and “Show HN: FlurryPORT – Capture and replay webhooks to localhost” (2). These are popularity/activity and reported-discussion signals only, not demand proof.
- **Inferred:** exactness is a plausible narrow problem because signatures cover bytes and headers, and a committed fixture can expose drift during integration tests. This is an inference from the contract mechanics, not customer or adoption evidence.
- **Untestable here:** willingness to adopt, frequency of webhook failures, integration-test time saved, and whether teams prefer a library, hosted service, or a broader replay tool. No customer, adoption, market-size, or revenue claim is made.

## Quickstart (under five minutes)

Requires Bun.

```sh
bun install --frozen-lockfile
export HOOKCASE_SECRET='local-only-secret'
bun run src/cli.ts create examples/event.json --secret-env HOOKCASE_SECRET --out /tmp/hookcase-fixture.json
bun run src/cli.ts check /tmp/hookcase-fixture.json
bun run src/cli.ts diff /tmp/hookcase-fixture.json /tmp/hookcase-fixture.json
HOOKCASE_DEMO_SECRET='demo-only' bun run src/cli.ts demo
```

`create` reads the secret only from the named environment variable. The fixture records the variable name and `stored: false`, never the secret. The example timestamp is explicit, so the output is byte-stable. `demo` uses a fixed event and timestamp; its environment variable is intended to be set only by the invoking test or demo process.

## Commands

```text
hookcase create EVENT.json --secret-env NAME --out FIXTURE.json
hookcase check FIXTURE.json
hookcase diff OLD.json NEW.json
hookcase demo
```

Exit codes are stable: `0` success, `1` unexpected failure or a changed `diff`, `2` usage/input/JSON error, `3` contract or signature error, and `4` missing/invalid secret environment input.

## Accepted event subset

The event document is a JSON object containing only these fields:

```json
{
  "id": "evt_example_001",
  "type": "order.created",
  "method": "POST",
  "path": "/webhooks/orders",
  "timestamp": 1700000000,
  "body": { "amount": 1250, "orderId": "ord_42" },
  "headers": { "x-provider": "example" },
  "contentType": "application/json"
}
```

`id` is 1–64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. `type` is 1–64 lowercase characters matching `[a-z0-9][a-z0-9._:-]*`. Only `POST`, an ASCII path without query/fragment, and `application/json` are accepted. `timestamp` is an integer from 2000-01-01 through 2100-01-01 UTC. `body` must be a JSON object or array, at most 64 KiB after canonicalization, with at most eight nesting levels. Object keys are sorted recursively; array order is preserved; duplicate JSON keys are rejected.

At most 13 selected headers are accepted. Names must be lower-case `x-*` tokens and values are strings of at most 256 UTF-8 bytes. CRLF, duplicate names, and transport/authentication headers such as `host`, `content-length`, `authorization`, `content-type`, and `transfer-encoding` are rejected. Hookcase owns `content-type`, `x-hookcase-timestamp`, and `x-hookcase-signature`.

## Fixture contract

The emitted JSON has stable key order and a final newline:

```json
{
  "version": 1,
  "eventId": "evt_example_001",
  "eventType": "order.created",
  "method": "POST",
  "path": "/webhooks/orders",
  "body": "{\"amount\":1250,\"orderId\":\"ord_42\"}",
  "contentType": "application/json",
  "headers": {
    "content-type": "application/json",
    "x-hookcase-signature": "sha256=<64 lowercase hex characters>",
    "x-hookcase-timestamp": "1700000000"
  },
  "timestamp": 1700000000,
  "signature": "sha256=<64 lowercase hex characters>",
  "secret": { "source": "environment", "name": "HOOKCASE_SECRET", "stored": false }
}
```

The signature is `sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`, with UTF-8 bytes for both the secret and exact body string. `check` validates the shape, canonical body, header/body/timestamp agreement, and HMAC using the environment variable named in `secret.name`. `diff` reports deterministic field changes and SHA-256 hashes for the two exact body strings without requiring the secret.

## Security and non-goals

- Secrets are read from one explicitly named environment variable, bounded, and never written to a fixture or intentionally printed.
- JSON and headers are parsed and bounded before signing. CRLF/header injection and forbidden transport/authentication headers are rejected.
- There are no network calls, listening sockets, external replay operations, or delivery behavior.
- A fixture is an artifact for local tests and review. It is not proof that a remote provider accepts a request, and it does not model provider-specific signing schemes beyond this documented HMAC contract.

## Local incumbent comparison

The incumbent workflow is composable shell tooling, not a straw man:

```sh
body='{"amount":1250,"orderId":"ord_42"}'
timestamp=1700000000
printf '%s' "$timestamp.$body" | openssl dgst -sha256 -hmac "$HOOKCASE_SECRET"
```

That command can produce a valid HMAC. The surrounding hand-written JSON and shell need additional conventions and checks for canonical body bytes, bounded timestamp and body, header injection/forbidden names, fixture schema, deterministic IDs, exact header/signature agreement, and stable validation diagnostics. Hookcase packages that narrow contract in one reproducible artifact; it does not claim `openssl`, JSON, or shell cannot be composed into an equivalent larger workflow.

## Verification

The authoritative runner compiles and executes every `tests/*.test.ts` file:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests/*.test.ts
bun run build
HOOKCASE_DEMO_SECRET=ci-demo bun run src/cli.ts demo
```

The suite covers creation/checking, a known HMAC vector, malformed and duplicate JSON, bad signatures, timestamp bounds, header injection, body bounds, forbidden headers, deterministic diff, secret non-persistence/output, CLI exit codes, and the demo summary. CI repeats the same checks on push and pull request.

## Limitations, dropped unknowns, and reopen trigger

Limitations: POST and JSON only; no provider-specific signature dialects; no live delivery; no network replay; no nonce store; no timestamp freshness policy beyond the documented absolute bounds; no encrypted secret store; and no schema inference.

Dropped unknowns: whether to support additional methods, binary bodies, query strings, provider-specific headers, alternate HMAC algorithms, or a library API. They are intentionally outside this first contract.

Reopen this scope only when a concrete fixture or integration test needs one of those capabilities and can supply a reproducible contract example plus a test that preserves deterministic output and secret non-persistence.
