# Contributing

Use Bun. The repository intentionally has no runtime dependencies.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests/*.test.ts
bun run build
```

Keep changes small and deterministic. New contract behavior needs a fixture test and a README update. Do not add network calls, listeners, replay behavior, or secret persistence.
