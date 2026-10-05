# XShot

- Read `CONTEXT.md` for domain terminology and `docs/adr/` for decisions before making changes.
- Chromium MV3 extension in vanilla TypeScript, bundled with Bun. No UI framework; plain CSS inside a Shadow DOM for anything injected into a page.
- Use `just` commands rather than invoking Bun directly: `just watch` for development, `just` to list commands.
- Run project commands through `devenv shell -- <command>` to load the development environment, including `git commit` (the pre-commit hook runs `just check`).
- After changes, run `just check` and fix all errors (format, lint, typecheck, tests, build).
- Verify capturing by hand: load `dist/` unpacked in Helium (`chrome://extensions` → Load unpacked).
