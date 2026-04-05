.PHONY: build build-app tauri tauri-app tauri-dmg tauri-dev lint lint-fix format typecheck test check clean

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

TAURI_APP_DIR := packages/genie-app
TAURI_BUNDLE := $(TAURI_APP_DIR)/src-tauri/target/release/bundle
TAURI_VERSION := $(shell jq -r '.version' $(TAURI_APP_DIR)/src-tauri/tauri.conf.json)
TAURI_ARCH := $(shell uname -m)
TAURI_DMG := Genie_$(TAURI_VERSION)_$(TAURI_ARCH).dmg

tauri: tauri-app tauri-dmg ## Build Tauri .app + .dmg

tauri-app: ## Build Tauri .app only (skip DMG)
	cd $(TAURI_APP_DIR) && cargo tauri build --bundles app

tauri-dmg: ## Package .app into .dmg via hdiutil
	@test -d "$(TAURI_BUNDLE)/macos/Genie.app" || (echo "Run 'make tauri-app' first" && exit 1)
	hdiutil create -volname "Genie" -srcfolder "$(TAURI_BUNDLE)/macos/Genie.app" -ov -format UDZO "$(TAURI_DMG)"
	@echo "✓ $(TAURI_DMG)"

tauri-dev:
	cd packages/genie-app && cargo tauri dev

clean:
	rm -rf dist node_modules
