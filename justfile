entries := "src/background.ts src/page.ts"

default:
    @just --list

install:
    bun install --frozen-lockfile

build:
    rm -rf dist
    bun build {{entries}} --outdir dist --target browser
    cp -r static/. dist/

watch: build
    bun build {{entries}} --outdir dist --target browser --watch

test:
    bun test --pass-with-no-tests

lint:
    bunx oxlint --type-aware --deny-warnings

fmt:
    bunx oxfmt --write .

typecheck:
    bunx tsc --noEmit

check: fmt lint typecheck test build
