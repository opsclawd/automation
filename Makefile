SHELL := /usr/bin/env bash

ISSUE ?=
PR ?=

.PHONY: ai-setup-labels ai-pilot ai-pr-comments

ai-setup-labels:
	./scripts/ai-setup-labels.sh

ai-pilot:
	@test -n "$(ISSUE)" || (echo "Usage: make ai-pilot ISSUE=123" && exit 1)
	./scripts/ai-run-issue.sh "$(ISSUE)"

ai-pr-comments:
	@test -n "$(PR)" || (echo "Usage: make ai-pr-comments PR=456" && exit 1)
	./scripts/ai-handle-pr-comments.sh "$(PR)"
