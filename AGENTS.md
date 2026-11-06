# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace has two desktop applications and five shared or product packages:

- `packages/core` (`@astra-conductor/core`): models, protocol adapters, and the curated OmniRoute subset shared by PolyQuota and GraphAgent.
- `packages/credentials` (`@astra-conductor/credentials`): product-independent broker protocol, transfer validation, record leases, and event synchronization.
- `packages/credential-host` (`@astra-conductor/credential-host`): Windows local broker component validation, installation, discovery, and authenticated connections; no Electron or product UI dependency.
- `packages/polyquota-contract` (`@astra-conductor/polyquota-contract`): the PolyQuota IPC contract (DTOs, service interface, channels, runtime validation) shared by the renderer, preload, and main process.
- `packages/polyquota-ui` (`@astra-conductor/polyquota-ui`): PolyQuota-only Vue 3 components, styles, fixtures, and browser tests.
- `apps/polyquota` (`@astra-conductor/polyquota`): PolyQuota Electron main/preload code and NSIS packaging.
- `apps/graph-agent` (`@astra-conductor/graph-agent`): independent Electron shell, blank home, and credential-sharing settings/import/refresh. It does not depend on PolyQuota UI or open the PolyQuota database; chat, agent loops, tasks, and tools remain out of scope.

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
- `pnpm test:credential-sharing-loop --publish <complete-publish-directory>`: validate the A6–A8 product sharing loop with isolated profiles, a local self-contained broker, and fictional credentials.
- `pnpm format:check`: verify formatting without edits.

## Coding Style & Naming Conventions

Use UTF-8, LF endings, two-space indentation, and a final newline. Prettier enforces double quotes, trailing commas, and a 100-character width. Keep TypeScript strict; avoid `any` and keep Electron APIs out of `packages/core`. Use PascalCase for Vue components and types, camelCase for functions and variables, and kebab-case for documentation files.

## Testing Guidelines

Use Vitest and name tests `*.test.ts`. Add tests to the changed module's `test/` directory; do not place test-only code under `src/`. Core tests must avoid Electron and live network access. Before submitting, run `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; also run `pnpm package` for PolyQuota Electron, native-module, or packaging changes and `pnpm package:graph-agent` for GraphAgent Electron or packaging changes.

## Commit & Pull Request Guidelines

Keep commit subjects short; any language is acceptable. Prefer `feat:`, `fix:`, `docs:`, or `chore:` followed by a concise summary. The architecture is still evolving, so module scopes such as `feat(core):` are optional. Keep each commit coherent. Pull requests should state intent, affected modules, validation results, linked issues, and risks. Include screenshots for UI changes and call out credentials, IPC, SQLite migrations, Electron versions, or vendor-derived protocol changes.

## Security & Vendor Boundaries

Never log or expose tokens through UI or renderer IPC. PolyQuota defaults to its encrypted private SQLite vault; shared mode uses the independent broker through `packages/credentials` and `packages/credential-host`. Follow `docs/common/core/credential-sharing/design.md` and the adjacent `a6-a8-sharing-implementation.md`: shared provider refreshes require a record lease, payloads are request-scoped, and returning to private storage requires an explicit verified snapshot and master-key cleanup. Never make either product open the other's database. The broker is independently built and installed; A9 production download/release integration is not yet implemented. Do not import runtime code from any repository under `references/`; changes to the curated vendor subset must retain source traceability and update its baseline tests or documentation.
