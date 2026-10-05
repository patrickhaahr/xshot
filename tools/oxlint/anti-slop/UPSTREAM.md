# Anti-slop provenance

- Installed from: `/home/ph/.agents/skills/install-anti-slop/assets/anti-slop/`, using the skill's `scripts/install.mjs` on 2026-10-05.
- Source repository and commit: unknown. The supplied skill assets contain no top-level revision record and are not in a Git checkout; no upstream HEAD or package version is substituted for their identity.
- Pristine snapshot: all files in this directory except this top-level `UPSTREAM.md` were copied verbatim. A recursive comparison against the supplied assets confirmed identical contents after project checks.
- Snapshot SHA-256: `6a5e9b6e859ea6668a06dd49fc158056c36617d50685a49ac2394ea9ab2be340`.
  To reproduce, recursively traverse directory entries sorted by name using JavaScript string comparison, and hash each file's relative POSIX path, a NUL byte, its raw contents, and a NUL byte. Exclude this top-level provenance file.
- Installed generic entry point: `tools/oxlint/anti-slop/index.ts`.
- Bundled, inactive Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`. XShot has no direct Effect dependency.
- Runtime dependency: `@oxlint/plugins` pinned to `1.86.0`, matching Oxlint.
- Intentional deviations: none in copied assets. XShot adds this provenance record and excludes the vendored directory from linting and formatting.

The nested `vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md` are retained verbatim. That provenance record identifies the Stylistic source revision and its existing Oxlint adaptations.

The supplied snapshot contains no anti-slop test files; none were removed during installation. Verification uses XShot's `devenv shell -- just check` (format, type-aware lint, typecheck, test command, and build). At installation it passed, with no existing project tests discovered.
