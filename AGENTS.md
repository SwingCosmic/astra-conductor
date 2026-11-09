# Repository Guidelines

## Project Structure & Module Organization

[Project architecture](./docs/architecture.md) owns the target workspace layout, permitted dependency directions, Web/Electron business request path, and supported product launch modes. Use its migration table to locate current implementations. Place new features in an existing package, product directory, or subpath. When changing a package boundary, business transport, or launch mode, update the architecture document with the reason and the impact on both products. Link to that decision from implementation plans.

Tests live in each runnable module's `test/` directory as `*.test.ts`; keep test helpers and fixtures there as well. Shared TypeScript settings are in `tsconfig.base.json`. Product and shared documentation is indexed by `docs/README.md`. All repositories under `references/` are reference inputs, not runtime dependencies. Only `references/omniroute` is required for development; initialize it with `git submodule update --init references/omniroute` and fetch the other reference repositories individually only when needed.

## Build, Test, and Development Commands

Use Node.js 22.12 or newer and pnpm 10. When Node 18/20 is the system default, prepend the configured Node 24 installation:

```powershell
$env:Path = "$env:NODE24_HOME;$env:Path"
```

- `pnpm install`: install locked dependencies.
- `pnpm dev`: build prerequisites and launch Electron.
- `pnpm dev:graph-agent`: build prerequisites and launch the independent GraphAgent shell.
- `pnpm typecheck`: check TypeScript and Vue across all modules.
- `pnpm test`: run all Vitest suites once.
- `pnpm build`: build shared packages, PolyQuota UI, and both desktop applications in dependency order.
- `pnpm package`: create the NSIS installer in `apps/polyquota/release/`.
- `pnpm package:graph-agent`: create the independent GraphAgent NSIS installer in `apps/graph-agent/release/`.
- `pnpm test:credential-sharing-loop --publish <complete-publish-directory>`: validate the A6—A8 product sharing loop with isolated profiles, a local self-contained broker, and fictional credentials.
- Add `--usage-performance` to the sharing loop to compare private and shared PolyQuota usage requests and verify broker reads and leases per account.
- `pnpm format:check`: verify formatting without edits.

## Coding Style & Naming Conventions

Use UTF-8, LF endings, two-space indentation, and a final newline. Prettier enforces double quotes, trailing commas, and a 100-character width. Keep TypeScript strict; avoid `any` and keep Electron APIs out of `packages/core`. Use PascalCase for Vue components and types, camelCase for functions and variables, and kebab-case for documentation files.

## Testing Guidelines

Use Vitest and name tests `*.test.ts`. Add tests to the changed module's `test/` directory; do not place test-only code under `src/`. Core tests must avoid Electron and live network access. Before submitting, run `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; also run `pnpm package` for PolyQuota Electron, native-module, or packaging changes and `pnpm package:graph-agent` for GraphAgent Electron or packaging changes.

## Commit & Pull Request Guidelines

Keep commit subjects short; any language is acceptable. Prefer `feat:`, `fix:`, `docs:`, or `chore:` followed by a concise summary. The architecture is still evolving, so module scopes such as `feat(core):` are optional. Keep each commit coherent. Pull requests should state intent, affected modules, validation results, linked issues, and risks. Include screenshots for UI changes and call out credentials, IPC, SQLite migrations, Electron versions, or vendor-derived protocol changes.

## Security & Vendor Boundaries

Never log tokens or expose them in UI state, API responses, renderer events, or IPC replies. PolyQuota defaults to its encrypted private SQLite vault. Shared mode uses the independent broker via the backend SDK and host adapter. Follow [credential sharing design](./docs/common/core/credential-sharing/design.md) and the adjacent A6—A8 implementation record. Raw broker payloads are request-scoped. The backend may cache a validated credential envelope in memory for the active grant and account until expiry approaches or the record changes. Clear cached credentials on loss of access, disconnect, or backend change. Shared provider refreshes require a record lease. Returning to private storage requires an explicit verified snapshot and master-key cleanup. Never make either product open the other's database. The broker is independently built and installed. B4 production download/release integration is pending. Do not import runtime code from any repository under `references/`. Changes to the curated vendor subset must retain source traceability and update its baseline tests or documentation.
