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

read_manifest() {
  local manifest_path="$1"

  if [[ ! -f "$manifest_path" ]]; then
    echo "manifest not found: ${manifest_path}" >&2
    return 1
  fi

  if ! jq -e '.' "$manifest_path" >/dev/null 2>&1; then
    echo "manifest is not valid JSON: ${manifest_path}" >&2
    return 1
  fi

  local actual_count
  actual_count=$(jq '.tasks | length' "$manifest_path")

  if ! jq -e '
    .version == 1 and
    .task_count == (.tasks | length) and
    (.tasks | type == "array") and
    ([ .tasks[].n ] == [ range(1; (.task_count + 1)) ]) and
    ([ .tasks[].title | type == "string" and length > 0 ] | all)
  ' "$manifest_path" >/dev/null 2>&1; then
    echo "manifest validation failed" >&2
    return 1
  fi

  MANIFEST_TASKS=$(jq -r '.tasks[].title' "$manifest_path")
  MANIFEST_COUNT=$actual_count
  return 0
}

_extract_declared_count() {
  local plan_file="$1"
  local count
  count=$(_strip_fenced < "$plan_file" | awk '
    /^#{2,3} Task [0-9]+:/ { found = 1 }
    !found && /<!--[[:space:]]*task-count:[[:space:]]*[0-9]+/ {
      val = $0
      sub(/.*task-count:[[:space:]]*/, "", val)
      sub(/[^0-9].*/, "", val)
    }
    found { exit }
    END { if (val != "") print val }
  ' || true)
  echo "${count:-}"
}

_check_sequential_numbers() {
  local plan_file="$1"
  local numbers
  numbers=$(_strip_fenced < "$plan_file" | grep -oP '^#{2,3} Task \K\d+(?=:)' 2>/dev/null || true)

  if [[ -z "$numbers" ]]; then
    echo ""
    return 0
  fi

  local original expected i
  original=$(echo "$numbers" | tr '\n' ' ')
  local count
  count=$(echo "$numbers" | wc -l | tr -d ' ')

  expected=""
  for ((i = 1; i <= count; i++)); do
    expected+="$i "
  done

  if [[ "$original" != "$expected" ]]; then
    local joined
    joined=$(echo "$numbers" | tr '\n' ',' | sed 's/,$//')
    echo "task numbers are not sequential: found [${joined}], expected 1..${count}"
    return 1
  fi

  echo ""
  return 0
}

_check_duplicate_titles() {
  local task_list="$1"
  local duplicates
  duplicates=$(echo "$task_list" | awk '{ t=tolower($0); titles[t]++; if (titles[t] == 2) print t }')

  if [[ -n "$duplicates" ]]; then
    local all_dups=""
    local dup
    while IFS= read -r dup; do
      [[ -z "$dup" ]] && continue
      local original_casing
      original_casing=$(echo "$task_list" | grep -Fixm 1 "$dup" || true)
      local count
      count=$(echo "$task_list" | grep -cFix "$dup" || true)
      all_dups+="'${original_casing}' appears ${count} times; "
    done <<< "$duplicates"
    echo "duplicate task titles detected: ${all_dups}"
    return 1
  fi

  echo ""
  return 0
}

_check_manifest_against_prose() {
  local plan_file="$1"
  local manifest_path="$2"

  local errors=""

  local seq_result
  seq_result=$(_check_sequential_numbers "$plan_file")
  local seq_rc=$?
  if [[ $seq_rc -ne 0 ]]; then
    errors="${seq_result}"
  fi

  local missing_from_prose=""
  local task_nums
  task_nums=$(jq -r '.tasks[].n' "$manifest_path")

  local n
  while IFS= read -r n; do
    local found
    found=$(_strip_fenced < "$plan_file" | awk -v tn="$n" '
      $0 ~ "^#{2,3} Task " tn ":" { print "1"; exit }
    ')
    if [[ -z "$found" ]]; then
      if [[ -n "$missing_from_prose" ]]; then
        missing_from_prose+=", "
      fi
      missing_from_prose+="Task ${n}"
    fi
  done <<< "$task_nums"

  if [[ -n "$missing_from_prose" ]]; then
    if [[ -n "$errors" ]]; then
      errors+="; "
    fi
    errors+="manifest tasks missing from plan.md prose: ${missing_from_prose}"
  fi

  local extra_in_prose=""
  local prose_nums
  prose_nums=$(_strip_fenced < "$plan_file" | grep -oP '^#{2,3} Task \K\d+(?=:)' 2>/dev/null || true)

  if [[ -n "$prose_nums" ]]; then
    local manifest_nums_csv
    manifest_nums_csv=$(jq -r '.tasks[].n' "$manifest_path" | tr '\n' ',' | sed 's/,$//')
    while IFS= read -r pn; do
      [[ -z "$pn" ]] && continue
      if ! echo ",${manifest_nums_csv}," | grep -q ",${pn},"; then
        if [[ -n "$extra_in_prose" ]]; then
          extra_in_prose+=", "
        fi
        extra_in_prose+="Task ${pn}"
      fi
    done <<< "$prose_nums"
  fi

  if [[ -n "$extra_in_prose" ]]; then
    if [[ -n "$errors" ]]; then
      errors+="; "
    fi
    errors+="prose tasks not in manifest: ${extra_in_prose}"
  fi

  if [[ -n "$errors" ]]; then
    echo "$errors"
    return 1
  fi

  return 0
}

_check_fixture_titles() {
  local task_list="$1"
  local fixture_patterns=("Phantom" "Real task" "Make CI green" "Fix failing tests" "Some task" "First task" "Example task" "TODO task")
  local warnings=""

  local title
  while IFS= read -r title; do
    [[ -z "$title" ]] && continue
    local lower_title
    lower_title=$(echo "$title" | tr '[:upper:]' '[:lower:]')
    local pattern
    for pattern in "${fixture_patterns[@]}"; do
      local lower_pattern
      lower_pattern=$(echo "$pattern" | tr '[:upper:]' '[:lower:]')
      if [[ "$lower_title" == *"$lower_pattern"* ]]; then
        warnings+="title '${title}' matches fixture pattern '${pattern}'; "
        break
      fi
    done
  done <<< "$task_list"

  echo "${warnings}"
  return 0
}

validate_task_list() {
  local plan_file="$1"
  local parsed_count="$2"
  local plan_dir
  plan_dir=$(dirname "$plan_file")
  local manifest_path="${plan_dir}/task-manifest.json"

  if [[ -f "$manifest_path" ]]; then
    MANIFEST_TASKS=""
    MANIFEST_COUNT=0
    if read_manifest "$manifest_path"; then
      if [[ "$MANIFEST_COUNT" -ne "$parsed_count" ]]; then
        echo "parsed ${parsed_count} tasks but manifest declares ${MANIFEST_COUNT} — task extraction is wrong"
        return 1
      fi

      local dup_result
      dup_result=$(_check_duplicate_titles "$MANIFEST_TASKS")
      local dup_rc=$?
      if [[ $dup_rc -ne 0 ]]; then
        echo "$dup_result"
        return 1
      fi

      local fixture_warnings
      fixture_warnings=$(_check_fixture_titles "$MANIFEST_TASKS")
      if [[ -n "$fixture_warnings" ]]; then
        emit_event "implement" "warn" "sanity_check.fixture_title" \
          "fixture-like task titles detected: ${fixture_warnings}"
      fi

      local prose_result
      prose_result=$(_check_manifest_against_prose "$plan_file" "$manifest_path")
      local prose_rc=$?
      if [[ $prose_rc -ne 0 ]]; then
        echo "$prose_result"
        return 1
      fi

      emit_event "implement" "info" "sanity_check.passed" \
        "task list sanity check passed (manifest)" manifestVersion="1" manifestCount="$MANIFEST_COUNT"

      echo ""
      return 0
    fi
  fi

  local declared
  declared=$(_extract_declared_count "$plan_file")

  if [[ -n "$declared" ]]; then
    if [[ "$declared" -ne "$parsed_count" ]]; then
      echo "parsed ${parsed_count} tasks but plan declares ${declared} — task extraction is wrong"
      return 1
    fi
  else
    emit_event "implement" "warn" "sanity_check.no_declared_count" \
      "no task-manifest.json and no task-count comment — falling back to sequential/dup checks"
  fi

  local seq_result
  seq_result=$(_check_sequential_numbers "$plan_file")
  local seq_rc=$?
  if [[ $seq_rc -ne 0 ]]; then
    echo "$seq_result"
    return 1
  fi

  local task_list
  task_list=$(parse_tasks "$plan_file")

  local dup_result
  dup_result=$(_check_duplicate_titles "$task_list")
  local dup_rc=$?
  if [[ $dup_rc -ne 0 ]]; then
    echo "$dup_result"
    return 1
  fi

  local fixture_warnings
  fixture_warnings=$(_check_fixture_titles "$task_list")
  if [[ -n "$fixture_warnings" ]]; then
    emit_event "implement" "warn" "sanity_check.fixture_title" \
      "fixture-like task titles detected: ${fixture_warnings}"
  fi

  emit_event "implement" "info" "sanity_check.passed" \
    "task list sanity check passed" declaredCount="${declared:-none}" parsedCount="$parsed_count"

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
  local manifest_path="${ISSUES_DIR}/task-manifest.json"
  MANIFEST_TASKS=""
  MANIFEST_COUNT=0
  if [[ -f "$manifest_path" ]] && read_manifest "$manifest_path"; then
    task_count=$MANIFEST_COUNT
  else
    task_count=$(_strip_fenced < "$plan_file" | awk '/^#{2,3} Task [0-9]+:/ {n++} END{print n+0}')
  fi

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

  local task_count
  local manifest_path="${ISSUES_DIR}/task-manifest.json"
  MANIFEST_TASKS=""
  MANIFEST_COUNT=0
  if [[ -f "$manifest_path" ]] && read_manifest "$manifest_path"; then
    task_count=$MANIFEST_COUNT
  else
    task_count=$(_strip_fenced < "${ISSUES_DIR}/plan.md" | awk '/^#{2,3} Task [0-9]+:/ {n++} END{print n+0}')
  fi

  if [[ $first_incomplete -gt $task_count ]]; then
    if [[ -f "$manifest_path" ]]; then
      local prose_result
      prose_result=$(_check_manifest_against_prose "${ISSUES_DIR}/plan.md" "$manifest_path")
      if [[ $? -ne 0 ]]; then
        warn "manifest/prose agreement check failed at resume: ${prose_result}"
        echo "implement"
        return
      fi
    fi
    echo "validate"
    return
  fi

  local status
  status=$(get_task_completion_status "$first_incomplete")

  case "$status" in
    complete)       echo "validate" ;;
    implementing)   echo "implement" ;;
    pending)        echo "implement" ;;
    review-needed)  echo "spec-review" ;;
    *)              echo "implement" ;;
  esac
}

parse_tasks() {
  local plan_file="$1"
  local plan_dir
  plan_dir=$(dirname "$plan_file")
  local manifest_path="${plan_dir}/task-manifest.json"

  if [[ -f "$manifest_path" ]]; then
    MANIFEST_TASKS=""
    MANIFEST_COUNT=0
    if read_manifest "$manifest_path"; then
      echo "$MANIFEST_TASKS"
      return 0
    fi
  fi

  _strip_fenced < "$plan_file" | grep -E "^#{2,3} Task [0-9]+:" 2>/dev/null | sed -E "s/^#{2,3} Task [0-9]+: //" || true
}

extract_task_text() {
  local plan_file="$1"
  local task_title="$2"
  local task_num="${3:-}"

  local line_num
  local used_num_lookup=0

  if [[ -n "$task_num" ]]; then
    line_num=$(awk -v tn="$task_num" '
      /^[[:space:]]*```/ { in_fence = !in_fence; next }
      !in_fence && $0 ~ "^#{2,3} Task " tn ":" { print NR; exit }
    ' "$plan_file")
    used_num_lookup=1
  fi

  if [[ -z "$line_num" ]]; then
    used_num_lookup=0
    local title_file
    title_file=$(mktemp)
    printf '%s' "$task_title" > "$title_file"
    line_num=$(awk -v title_file="$title_file" '
      BEGIN { getline title < title_file; close(title_file) }
      /^[[:space:]]*```/ { in_fence = !in_fence; next }
      !in_fence && index($0, title) > 0 { print NR; exit }
    ' "$plan_file")
    rm -f "$title_file"
  fi

  if [[ -z "$line_num" ]]; then
    return 1
  fi

  if [[ "$used_num_lookup" -eq 1 ]]; then
    tail -n +"$line_num" "$plan_file" | awk -v tn="$task_num" '
      /^[[:space:]]*```/ { in_fence = !in_fence }
      NF == 0 { next }
      !in_fence && $0 ~ "^#{2,3} Task " tn ":" { in_task=1; next }
      !in_fence && /^#{2,3} Task [0-9]+:/ {
        if (in_task) { exit }
      }
      in_task { print }
    '
  else
    local title_file2
    title_file2=$(mktemp)
    printf '%s' "$task_title" > "$title_file2"
    tail -n +"$line_num" "$plan_file" | awk -v title_file="$title_file2" '
      BEGIN {
        while ((getline line < title_file) > 0) { title = line }
        close(title_file)
        buf_idx = 0
      }
      /^[[:space:]]*```/ { in_fence = !in_fence }
      NF == 0 { next }
      index($0, title) > 0 { in_task=1; next }
      !in_fence && /^#{2,3} Task [0-9]+:/ {
        if (in_task) {
          for (i = 1; i <= buf_idx; i++) print buf[i]
          exit
        }
      }
      in_task { buf[++buf_idx] = $0 }
    '
    rm -f "$title_file2"
  fi
}

extract_task_commit_msg() {
  local plan_file="$1"
  local task_title="$2"
  local fallback_msg="$3"
  local task_num="${4:-}"

  local line_num

  if [[ -n "$task_num" ]]; then
    line_num=$(awk -v tn="$task_num" '
      /^[[:space:]]*```/ { in_fence = !in_fence; next }
      !in_fence && $0 ~ "^#{2,3} Task " tn ":" { print NR; exit }
    ' "$plan_file")
  fi

  if [[ -z "$line_num" ]]; then
    local title_file
    title_file=$(mktemp)
    printf '%s' "$task_title" > "$title_file"
    line_num=$(awk -v title_file="$title_file" '
      BEGIN { getline title < title_file; close(title_file) }
      /^[[:space:]]*```/ { in_fence = !in_fence; next }
      !in_fence && index($0, title) > 0 { print NR; exit }
    ' "$plan_file")
    rm -f "$title_file"
  fi

  if [[ -z "$line_num" ]]; then
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

  if [[ -n "$commit_msg" ]]; then
    echo "$commit_msg"
  else
    echo "$fallback_msg"
  fi
}

# _lint_task_size: check task-manifest.json for tasks targeting oversized test files.
# Reads thresholds from _TASK_SPLIT_MAX_LINES, _TASK_SPLIT_MAX_CASES, _TASK_SPLIT_BLOCK.
# If blockOversizedTasks is true, exits 1 on the first oversized task.
# Otherwise, emits a warn event per oversized task.
_lint_task_size() {
  local manifest_path="${1:-${ISSUES_DIR}/task-manifest.json}"
  if [[ ! -f "$manifest_path" ]]; then
    return 0
  fi
  local max_lines="${_TASK_SPLIT_MAX_LINES:-500}"
  local max_cases="${_TASK_SPLIT_MAX_CASES:-10}"
  local block="${_TASK_SPLIT_BLOCK:-false}"
  local task_count
  task_count=$(jq '.tasks | length' "$manifest_path" 2>/dev/null || echo 0)
  local i=0
  while [[ $i -lt $task_count ]]; do
    local task_title
    task_title=$(jq -r ".tasks[$i].title // \"\"" "$manifest_path")
    local task_num=$((i + 1))
    local file_count
    file_count=$(jq ".tasks[$i].files | length" "$manifest_path" 2>/dev/null || echo 0)
    if [[ "$file_count" -eq 0 ]]; then
      i=$((i + 1))
      continue
    fi
    local j=0
    while [[ $j -lt $file_count ]]; do
      local file_path
      file_path=$(jq -r ".tasks[$i].files[$j]" "$manifest_path")
      local is_test_file=0
      if [[ "$file_path" =~ \.(test|spec)\.(ts|tsx)$ || "$file_path" =~ \.bats$ ]]; then
        is_test_file=1
      fi
      if [[ $is_test_file -eq 0 ]]; then
        j=$((j + 1))
        continue
      fi
      local resolved_path="${WORKTREE_DIR:-.}/${file_path}"
      if [[ ! -f "$resolved_path" ]]; then
        j=$((j + 1))
        continue
      fi
      local line_count
      line_count=$(wc -l < "$resolved_path" 2>/dev/null || echo 0)
      local test_case_count
      test_case_count=$(grep -cE '^[[:space:]]*(it|test)(\.(skip|only))?\(' "$resolved_path" 2>/dev/null || true)
      local oversized=0
      local reasons=""
      if [[ "$line_count" -gt "$max_lines" ]]; then
        oversized=1
        reasons="line count ${line_count} > threshold ${max_lines}"
      fi
      if [[ "$test_case_count" -gt "$max_cases" ]]; then
        oversized=1
        if [[ -n "$reasons" ]]; then reasons+=", "; fi
        reasons+="test case count ${test_case_count} > threshold ${max_cases}"
      fi
      if [[ $oversized -eq 1 ]]; then
        if [[ "$block" == "true" ]]; then
          echo "FATAL: Task ${task_num} ($(printf '%s' "$task_title")) targets oversized test file ${file_path}: ${reasons}" >&2
          return 1
        else
          emit_event "implement" "warn" "task_size.oversized" \
            "Task ${task_num} ($(printf '%s' "$task_title")) targets oversized test file ${file_path}: ${reasons}" \
            taskNum="$task_num" "taskTitle=${task_title}" "file=${file_path}" \
            "lineCount=${line_count}" "testCaseCount=${test_case_count}" \
            "maxLines=${max_lines}" "maxCases=${max_cases}"
        fi
      fi
      j=$((j + 1))
    done
    i=$((i + 1))
  done
  return 0
}
