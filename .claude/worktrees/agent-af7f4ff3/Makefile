.PHONY: build lint lint-fix format typecheck test check clean

build:
	bun run build

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

clean:
	rm -rf dist node_modules
