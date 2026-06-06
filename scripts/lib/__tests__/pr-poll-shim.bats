#!/usr/bin/env bats

@test "ai-pr-review-poll prints usage when no PR given" {
  run scripts/ai-pr-review-poll
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "ai-pr-review-poll exits 1 when OWNER_REPO unset and gh unavailable" {
  fake_bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/gh" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
  chmod +x "$fake_bin/gh"

  run env PATH="$fake_bin:$PATH" OWNER_REPO= scripts/ai-pr-review-poll 42

  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine owner/repo"* ]]
}
