.PHONY: build-ApiFunction

build-ApiFunction:
	mkdir -p "$(ARTIFACTS_DIR)"
	./node_modules/.bin/esbuild apps/aws-lambda/src/handler.ts \
		--bundle \
		--platform=node \
		--target=node22 \
		--format=cjs \
		--sourcemap \
		--outfile="$(ARTIFACTS_DIR)/handler.js"
