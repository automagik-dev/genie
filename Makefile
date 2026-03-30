.PHONY: build build-app tauri tauri-dev lint lint-fix format typecheck test check clean

build:
	bun run build

build-app:
	bun run build:app

lint:
	bunx biome check .

lint-fix:
	bunx biome check --write .

format:
	bunx biome format --write .

typecheck:
	bun run typecheck

test:
	bun test

check: lint typecheck test

tauri:
	cd packages/genie-app && bunx tauri build

tauri-dev:
	cd packages/genie-app && bunx tauri dev

clean:
	rm -rf dist node_modules
