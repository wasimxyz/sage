.PHONY: setup check check-native-sdk-version test fe-build build dev eval eval-upload eval-viewer-build eval-viewer-dev eval-viewer-start package package-archive

# `native build` / `native test` drive this repo's ejected build.zig.
# Pass the global CLI only when it is actually installed; otherwise
# build.zig reads NATIVE_SDK_PATH or asks `npm root -g` itself.
NATIVE_SDK_PATH ?= $(shell npm root -g 2>/dev/null)/@native-sdk/cli
NATIVE_SDK_FLAG := $(if $(wildcard $(NATIVE_SDK_PATH)/src/root.zig),-Dnative-sdk-path="$(NATIVE_SDK_PATH)",)

# ReleaseSafe protects integer operations in shipped/native build binaries.
# Override for local performance experiments with NATIVE_OPTIMIZE=ReleaseFast.
NATIVE_OPTIMIZE ?= ReleaseSafe

# Memory is a build-and-release option, not a user-facing setting. Enable it
# with `SAGE_MEMORY=true make dev|build|package`.
SAGE_MEMORY ?= false
MEMORY_FLAG := -Dmemory=$(SAGE_MEMORY)

# The pinned Native SDK CLI. CI installs exactly this version, and the
# record lives in the repo so the build is reproducible.
NATIVE_SDK_VERSION := $(shell cat .native-sdk-version 2>/dev/null)

setup:
	npm --prefix frontend install
	npm --prefix agent install
	npm --prefix eval-viewer install

# Fail before compiling if the global CLI is not the pinned version.
check-native-sdk-version:
	@installed="$$(native --version 2>/dev/null | cut -d' ' -f2)"; \
	if [ "$$installed" != "$(NATIVE_SDK_VERSION)" ]; then \
		echo "Native SDK CLI is $${installed:-missing}, expected $(NATIVE_SDK_VERSION). Install it with: npm install -g @native-sdk/cli@$(NATIVE_SDK_VERSION)"; \
		exit 1; \
	fi

check: check-native-sdk-version
	native check
	npm --prefix frontend run check
	npm --prefix frontend run typecheck

test:
	native test $(NATIVE_SDK_FLAG) $(MEMORY_FLAG)
	npm --prefix frontend run test
	npm --prefix agent run test:evals
	npm --prefix agent run test:scripts
	npm --prefix agent run test:world
	npm --prefix eval-viewer test
	sh scripts/eval-env.test.sh
	node --test --experimental-strip-types security-tests/*.test.ts
	sh security-tests/eval-leftover-automation.sh
	sh security-tests/eval-server-token.sh
	sh security-tests/eval-ignores-data-dir.sh
	sh security-tests/agent-dev-modules.sh

eval:
	sh scripts/eval-run.sh $(ARGS)

eval-upload:
	sh scripts/eval-upload.sh

eval-viewer-build:
	npm --prefix eval-viewer run build

eval-viewer-dev:
	npm --prefix eval-viewer run dev

eval-viewer-start:
	npm --prefix eval-viewer run start

fe-build:
	npm --prefix frontend run build

build: fe-build
	native build $(NATIVE_SDK_FLAG) $(MEMORY_FLAG) -Doptimize=$(NATIVE_OPTIMIZE)

dev:
	@agent_pid=""; \
	if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:2000/eve/v1/health; then \
		echo "Chat agent already running on port 2000"; \
	else \
		echo "Starting Chat agent on port 2000"; \
		npm --prefix agent install; \
		npm --prefix agent run dev & \
		agent_pid=$$!; \
		i=0; \
		while [ $$i -lt 50 ]; do \
			if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:2000/eve/v1/health; then \
				break; \
			fi; \
			i=$$((i + 1)); \
			sleep 0.1; \
		done; \
	fi; \
	trap 'if [ -n "$$agent_pid" ]; then kill $$agent_pid 2>/dev/null; pkill -P $$agent_pid 2>/dev/null; fi' EXIT INT TERM; \
	SAGE_DEV_EVE_WORKFLOW_DIR="$(CURDIR)/agent/.eve/.workflow-data" native dev $(NATIVE_SDK_FLAG) $(MEMORY_FLAG)

package:
	npm --prefix frontend run build
	npm --prefix agent install --omit=dev
	npm --prefix agent run build
	native build $(NATIVE_SDK_FLAG) $(MEMORY_FLAG) -Doptimize=$(NATIVE_OPTIMIZE)
	native package --target macos --binary zig-out/bin/Sage
	sh scripts/copy-agent-into-app.sh zig-out/package/Sage.app

package-archive: package
	sh scripts/archive-packaged-app.sh

precommit:
	make check
	make test
	make package
