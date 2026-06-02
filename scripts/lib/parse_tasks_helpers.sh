#!/usr/bin/env bash
# scripts/lib/parse_tasks_helpers.sh
# Task parsing helpers for the issue-to-PR orchestrator.
# Sourced by ai-run-issue-v2 and its bats tests.

_strip_fenced() {
  awk '
    /^[[:space:]]*```/ { in_fence = !in_fence; next }
    !in_fence { print }
  '
}

_extract_declared_count() {
  local plan_file="$1"
  local count
  count=$(grep -oP '<!-- task-count: \K[0-9]+' "$plan_file" 2>/dev/null | head -1)
  echo "${count:-}"
}

_check_sequential_numbers() {
  local plan_file="$1"
  local numbers
  numbers=$(_strip_fenced < "$plan_file" | grep -oP '(?<=^#{2,3} Task )\d+' 2>/dev/null || true)

  if [[ -z "$numbers" ]]; then
    echo ""
    return 0
  fi

  local sorted expected i
  sorted=$(echo "$numbers" | sort -n | tr '\n' ' ')
  local count
  count=$(echo "$numbers" | wc -l | tr -d ' ')

  expected=""
  for ((i = 1; i <= count; i++)); do
    expected+="$i "
  done

  if [[ "$sorted" != "$expected" ]]; then
    local joined
    joined=$(echo "$numbers" | tr '\n' ',' | sed 's/,$//')
    echo "task numbers are not sequential: found [${joined}], expected 1..${count}"
    return 1
  fi

  echo ""
  return 0
}

find_first_incomplete_task() {
  local plan_file="${ISSUES_DIR}/plan.md"
  if [[ ! -f "$plan_file" ]]; then
    echo "0"
    return
  fi

  local task_count
  task_count=$(_strip_fenced < "$plan_file" | awk '/^#{2,3} Task [0-9]+:/ {n++} END{print n+0}')

  if [[ "$task_count" -eq 0 ]]; then
    echo "0"
    return
  fi

  local n=1
  while [[ $n -le "$task_count" ]]; do
    local status
    status=$(get_task_completion_status "$n")
    if [[ "$status" != "complete" ]]; then
      echo "$n"
      return
    fi
    n=$((n + 1))
  done

  echo "$((task_count + 1))"
}

detect_resume_point() {
  local first_incomplete
  first_incomplete=$(find_first_incomplete_task)

  if [[ "$first_incomplete" -eq 0 ]]; then
    echo "read_issue"
    return
  fi

  local status
  status=$(get_task_completion_status "$first_incomplete")

  case "$status" in
    complete)
      local task_count
      task_count=$(_strip_fenced < "${ISSUES_DIR}/plan.md" | awk '/^#{2,3} Task [0-9]+:/ {n++} END{print n+0}')
      if [[ $first_incomplete -gt $task_count ]]; then
        echo "validate"
      else
        echo "implement"
      fi
      ;;
    implementing)    echo "implement" ;;
    pending)        echo "implement" ;;
    review-needed)  echo "spec-review" ;;
    *)              echo "implement" ;;
  esac
}

parse_tasks() {
  local plan_file="$1"
  _strip_fenced < "$plan_file" | grep -E "^#{2,3} Task [0-9]+:" 2>/dev/null | sed -E "s/^#{2,3} Task [0-9]+: //" || true
}

extract_task_text() {
  local plan_file="$1"
  local task_title="$2"

  local title_file
  title_file=$(mktemp)

  printf '%s' "$task_title" > "$title_file"

  local line_num
  line_num=$(awk -v title_file="$title_file" '
    BEGIN { getline title < title_file; close(title_file) }
    /^[[:space:]]*```/ { in_fence = !in_fence; next }
    !in_fence && index($0, title) > 0 { print NR; exit }
  ' "$plan_file")

  if [[ -z "$line_num" ]]; then
    rm -f "$title_file"
    return 1
  fi

  tail -n +"$line_num" "$plan_file" | awk -v title_file="$title_file" '
    BEGIN {
      while ((getline line < title_file) > 0) { title = line }
      close(title_file)
      buf_idx = 0
    }
    /^[[:space:]]*```/ { in_fence = !in_fence }
    NF == 0 { next }
    index($0, title) > 0 { in_task=1; next }
    !in_fence && /^## / {
      if (in_task) {
        for (i = 1; i <= buf_idx; i++) print buf[i]
        exit
      }
    }
    in_task { buf[++buf_idx] = $0 }
  '

  rm -f "$title_file"
}

extract_task_commit_msg() {
  local plan_file="$1"
  local task_title="$2"
  local fallback_msg="$3"

  local title_file
  title_file=$(mktemp)

  printf '%s' "$task_title" > "$title_file"

  local line_num
  line_num=$(awk -v title_file="$title_file" '
    BEGIN { getline title < title_file; close(title_file) }
    /^[[:space:]]*```/ { in_fence = !in_fence; next }
    !in_fence && index($0, title) > 0 { print NR; exit }
  ' "$plan_file")

  if [[ -z "$line_num" ]]; then
    rm -f "$title_file"
    echo "$fallback_msg"
    return
  fi

  local next_task_line
  next_task_line=$(awk -v start="$line_num" '
    /^[[:space:]]*```/ { in_fence = !in_fence; next }
    NR > start && !in_fence && /^#{2,3} Task [0-9]+:/ { print NR; exit }
  ' "$plan_file")

  local commit_msg
  if [[ -n "$next_task_line" ]]; then
    commit_msg=$(sed -n "${line_num},$((next_task_line - 1))p" "$plan_file" | grep -oP 'git commit -m "\K[^"]+' | tail -1)
  else
    commit_msg=$(tail -n +"$line_num" "$plan_file" | grep -oP 'git commit -m "\K[^"]+' | tail -1)
  fi

  rm -f "$title_file"

  if [[ -n "$commit_msg" ]]; then
    echo "$commit_msg"
  else
    echo "$fallback_msg"
  fi
}
