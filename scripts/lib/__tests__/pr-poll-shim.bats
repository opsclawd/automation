#!/usr/bin/env bats

@test "ai-pr-review-poll prints usage when no PR given" {
  run scripts/ai-pr-review-poll
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "ai-pr-review-poll exits 1 when OWNER_REPO unset and gh unavailable" {
  # Create a temporary directory with a fake gh that always fails, then
  # put it first on PATH so the shim picks it up instead of the real gh.
  tmpdir=$(mktemp -d)
  cat > "$tmpdir/gh" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
  chmod +x "$tmpdir/gh"

  run env PATH="$tmpdir:$PATH" OWNER_REPO= scripts/ai-pr-review-poll 42
  rm -rf "$tmpdir"

  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine owner/repo"* ]]
}
