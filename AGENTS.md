# Hookcase contributor instructions

- Keep runtime dependencies at zero; use Bun and the standard library.
- Preserve the documented fixture contract and stable exit codes.
- Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test tests/*.test.ts`, `bun run build`, and `bun run demo` before publishing changes.
- Never put a webhook secret in a fixture, test output, example, commit, or log.
