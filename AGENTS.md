# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace currently has three runnable modules and one reserved application location:

- `packages/core`: models, protocol adapters, and the curated OmniRoute subset shared by PolyQuota and GraphAgent.
- `packages/polyquota-ui`: PolyQuota-only Vue 3 components, styles, fixtures, and browser tests.
- `apps/polyquota`: PolyQuota Electron main/preload code and NSIS packaging.
- `apps/graph-agent`: a documentation-only placeholder; do not infer its future runtime or UI structure from PolyQuota.

Tests live in each runnable module's `test/` directory as `*.test.ts`; keep test helpers and fixtures there as well. Shared TypeScript settings are in `tsconfig.base.json`. Product and shared documentation is indexed by `docs/README.md`. All repositories under `references/` are reference inputs, not runtime dependencies. Initialize them with `git submodule update --init --recursive`.

## Build, Test, and Development Commands

Use Node.js 22.12 or newer and pnpm 10. When Node 18/20 is the system default, prepend the configured Node 24 installation:

```powershell
$env:Path = "$env:NODE24_HOME;$env:Path"
```

- `pnpm install`: install locked dependencies.
- `pnpm dev`: build prerequisites and launch Electron.
- `pnpm typecheck`: check TypeScript and Vue across all modules.
- `pnpm test`: run all Vitest suites once.
- `pnpm build`: build core, UI, and desktop in order.
- `pnpm package`: create the NSIS installer in `apps/polyquota/release/`.
- `pnpm format:check`: verify formatting without edits.

## Coding Style & Naming Conventions

Use UTF-8, LF endings, two-space indentation, and a final newline. Prettier enforces double quotes, trailing commas, and a 100-character width. Keep TypeScript strict; avoid `any` and keep Electron APIs out of `packages/core`. Use PascalCase for Vue components and types, camelCase for functions and variables, and kebab-case for documentation files.

## Testing Guidelines

Use Vitest and name tests `*.test.ts`. Add tests to the changed module's `test/` directory; do not place test-only code under `src/`. Core tests must avoid Electron and live network access. Before submitting, run `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; also run `pnpm package` for Electron, native-module, or packaging changes.

## Commit & Pull Request Guidelines

Keep commit subjects short; any language is acceptable. Prefer `feat:`, `fix:`, `docs:`, or `chore:` followed by a concise summary. The architecture is still evolving, so module scopes such as `feat(core):` are optional. Keep each commit coherent. Pull requests should state intent, affected modules, validation results, linked issues, and risks. Include screenshots for UI changes and call out credentials, IPC, SQLite migrations, Electron versions, or vendor-derived protocol changes.

## Security & Vendor Boundaries

Never log or expose tokens through UI or IPC. Store authorization secrets only through the documented `safeStorage` and SQLite boundary. Do not import runtime code from any repository under `references/`; changes to the curated vendor subset must retain source traceability and update its baseline tests or documentation.
