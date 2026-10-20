# Backend type placement

Use this directory for shared backend types that do not belong to one runtime
module.

## Rules

1. Keep types beside their runtime module when possible. For example,
   `backend/lifecycle/flight-lifecycle.ts` compiles to
   `dist/backend/lifecycle/flight-lifecycle.js`.
2. Do not create a parallel `backend-ts/` tree.
3. Put only broadly shared declarations here, such as ambient declarations,
   helper types, and `.d.ts` shims for untyped modules.
4. Keep validation with the runtime code. Types do not replace sanitizers,
   schema validation, or input and output guards.
5. Put generated declarations in `backend/types/generated/`. Build them with
   `npm run build:backend:types`. That command runs a fresh `tsc -b` build: it first emits
   `packages/telemetry-types` declarations through the project reference in
   `tsconfig.backend.declarations.json`, so backend type-only imports from that
   package resolve to declarations rather than source outside `rootDir`.
   After compilation succeeds, it removes generated `.d.ts` files whose source
   modules are no longer in the compiler project. Handwritten shims are outside
   that cleanup. Commit the regenerated output with the source change that caused it.
6. Build runnable JavaScript in `dist/backend/` with
   `npm run build:backend:runtime`.
7. Stage related runtime assets beside the compiled backend. The current roots
   are `dist/shared/` and `dist/frontend/`.
8. Check backend tests and support files with
   `npm run typecheck:backend:tests`. Unit tests live in `backend/tests/` and
   compile to `dist/backend/tests/`; shared integration tests live in
   `tests/backend/` and compile to `dist/tests/backend/`. The production
   typecheck and declaration build exclude these test folders.

## Why

The backend is organized by feature. Keeping source and types together makes
imports and ownership clear without creating a second source tree.

Current layout:

- `backend/` contains TypeScript source.
- `dist/backend/` contains runnable JavaScript.
- `backend/types/generated/` contains generated declarations.

This folder's ambient declarations and generated output have different owners
and build rules. The current handwritten shim is `ws.d.ts`;
do not edit files under `generated/` to repair a runtime type. Change the owning
source and use the declaration build. Review generated changes before staging
them; declaration output is a developer aid and does not replace the runtime
build or dedicated test typecheck.

See [the test layout](../../docs/DEVELOPMENT-TOOLS.md#test-layout) and
[architecture](../../architecture.md) for the broader boundaries.
