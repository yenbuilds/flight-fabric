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
   `npm run build:backend:types`.
6. Build runnable JavaScript in `dist/backend/` with
   `npm run build:backend:runtime`.
7. Stage related runtime assets beside the compiled backend. The current roots
   are `dist/shared/` and `dist/frontend/`.
8. Check backend tests and support files with
   `npm run typecheck:backend:tests`. They may also compile into
   `dist/backend/` for tests that run against built code.

## Why

The backend is organized by feature. Keeping source and types together makes
imports and ownership clear without creating a second source tree.

Current layout:

- `backend/` contains TypeScript source.
- `dist/backend/` contains runnable JavaScript.
- `backend/types/generated/` contains generated declarations.
