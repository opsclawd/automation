import type { GovernanceFinding, RecognizedCandidateKind } from './types.js';

const DISPOSITION_PATTERN = /^(?:GO|NO-GO|APPROVE|APPROVED|PROMOTE|PROMOTED|REJECT|REJECTED)$/i;

const SHA40_PATTERN = /^[0-9a-f]{40}$/i;

const RATIO_PATTERN = /^([0-9]+)\s*\/\s*([0-9]+)$/;

const PERCENT_PATTERN = /^([0-9]{1,3})%$/;

const STANDARD_PLACEHOLDERS = new Set([
  'TODO',
  'TBD',
  'UNVALIDATED',
  'PENDING',
  'NOT_PERFORMED',
  'NONE',
  'N/A',
  'NA',
  '[UNASSIGNED]',
  'UNASSIGNED',
  'NULL',
  '',
]);

export function isPlaceholderValue(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (trimmed === '') return true;
  if (/^<[^>]+>$/.test(trimmed)) return true;
  return STANDARD_PLACEHOLDERS.has(trimmed.toUpperCase());
}

export function isRecognizedCandidatePath(path: string): RecognizedCandidateKind | null {
  const normalized = path.replace(/\\/g, '/');
  const filename = normalized.split('/').pop() ?? '';
  if (/template/i.test(filename)) {
    return null;
  }
  if (/(?:^|\/)[^/]*candidate[-_]validation[-_]report[^/]*\.md$/i.test(normalized)) {
    return 'candidate_validation_report';
  }
  if (/(?:^|\/)[^/]*audit[-_]closeout[^/]*\.json$/i.test(normalized)) {
    return 'audit_closeout';
  }
  return null;
}

export function findDuplicateJsonKeys(raw: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<{ isObject: boolean; keys: Set<string> }> = [];
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const char = raw[i];
    if (char === '{') {
      stack.push({ isObject: true, keys: new Set<string>() });
      i++;
    } else if (char === '}') {
      stack.pop();
      i++;
    } else if (char === '[') {
      stack.push({ isObject: false, keys: new Set<string>() });
      i++;
    } else if (char === ']') {
      stack.pop();
      i++;
    } else if (char === '"') {
      let str = '';
      i++;
      while (i < len) {
        const curr = raw[i];
        if (curr === undefined) break;
        if (curr === '\\') {
          const next = raw[i + 1];
          if (next !== undefined) {
            str += curr + next;
            i += 2;
            continue;
          }
        }
        if (curr === '"') {
          i++;
          break;
        }
        str += curr;
        i++;
      }
      let j = i;
      while (j < len && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) {
        j++;
      }
      if (j < len && raw[j] === ':') {
        const top = stack[stack.length - 1];
        if (top && top.isObject) {
          let keyName = str;
          try {
            keyName = JSON.parse(`"${str}"`);
          } catch {
            // use raw str if JSON.parse fails
          }
          if (top.keys.has(keyName)) {
            duplicates.push(keyName);
          } else {
            top.keys.add(keyName);
          }
        }
        i = j + 1;
      }
    } else {
      i++;
    }
  }
  return duplicates;
}

function cleanFormatting(str: string): string {
  return str.replace(/^[*_`]+|[*_`]+$/g, '').trim();
}

function stripFencedCodeBlocks(content: string): string[] {
  const lines = content.split('\n');
  let inCodeBlock = false;
  return lines.map((line) => {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return '';
    }
    if (inCodeBlock) {
      return '';
    }
    return line;
  });
}

export function classifyCandidateContent(
  path: string,
  content: string,
  kind: RecognizedCandidateKind,
): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];

  if (kind === 'audit_closeout') {
    // 1. Check for duplicate keys to guard against semantic parser evasion
    const duplicates = findDuplicateJsonKeys(content);
    for (const dup of duplicates) {
      findings.push({
        code: 'DUPLICATE_JSON_KEY',
        severity: 'critical',
        message: `Duplicate JSON member key detected: '${dup}'`,
        path,
        rawMatch: dup,
      });
    }

    // 2. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return findings;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return findings;
    }

    function inspectJsonObject(obj: Record<string, unknown>, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const lowerKey = key.toLowerCase();

        // Affirmative disposition
        if (
          ['decision', 'disposition', 'verdict'].includes(lowerKey) ||
          fullKey.toLowerCase().endsWith('decision')
        ) {
          if (typeof value === 'string' && DISPOSITION_PATTERN.test(value.trim())) {
            findings.push({
              code: 'AFFIRMATIVE_DISPOSITION',
              severity: 'critical',
              message: `Candidate validation artifact contains affirmative/definitive disposition '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Candidate SHA binding
        if (
          ['candidatesha', 'pinnedcandidatesha'].includes(lowerKey) ||
          fullKey.toLowerCase().endsWith('candidatesha')
        ) {
          if (typeof value === 'string' && SHA40_PATTERN.test(value.trim())) {
            findings.push({
              code: 'CANDIDATE_SHA_BINDING',
              severity: 'critical',
              message: `Candidate validation artifact contains concrete candidate SHA binding '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Human / operator sign-off
        if (
          ['signoff', 'reviewingauthority', 'signedby', 'operatorsignoff', 'approvedby'].includes(
            lowerKey,
          )
        ) {
          if (typeof value === 'string' && !isPlaceholderValue(value)) {
            findings.push({
              code: 'HUMAN_SIGN_OFF',
              severity: 'critical',
              message: `Candidate validation artifact contains human/operator sign-off attribution '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Scenario claims
        if (['scenariospassed', 'scenarioscompleted', 'passedscenarios'].includes(lowerKey)) {
          if (typeof value === 'string' && !isPlaceholderValue(value)) {
            const ratioMatch = value.trim().match(RATIO_PATTERN);
            if (ratioMatch) {
              const num = parseInt(ratioMatch[1]!, 10);
              if (num > 0) {
                findings.push({
                  code: 'MEASURED_SCENARIO_CLAIM',
                  severity: 'critical',
                  message: `Candidate validation artifact asserts measured scenario claim '${value}' in '${fullKey}'`,
                  path,
                  rawMatch: `${key}: ${value}`,
                });
              }
            } else if (/^[0-9]+$/.test(value.trim()) && parseInt(value.trim(), 10) > 0) {
              findings.push({
                code: 'MEASURED_SCENARIO_CLAIM',
                severity: 'critical',
                message: `Candidate validation artifact asserts measured scenario claim '${value}' in '${fullKey}'`,
                path,
                rawMatch: `${key}: ${value}`,
              });
            }
          } else if (typeof value === 'number' && value > 0) {
            findings.push({
              code: 'MEASURED_SCENARIO_CLAIM',
              severity: 'critical',
              message: `Candidate validation artifact asserts measured scenario claim '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Quantitative metric claims
        if (
          [
            'requirementcoverage',
            'storyreadiness',
            'syntaxcompliance',
            'historicalimmutability',
            'scenariopassrate',
            'gatecompliance',
          ].includes(lowerKey)
        ) {
          if (typeof value === 'string' && !isPlaceholderValue(value)) {
            if (
              PERCENT_PATTERN.test(value.trim()) ||
              (/^[0-9]+(\.[0-9]+)?$/.test(value.trim()) && parseFloat(value.trim()) > 0)
            ) {
              findings.push({
                code: 'MEASURED_METRIC_CLAIM',
                severity: 'critical',
                message: `Candidate validation artifact asserts quantitative metric claim '${value}' in '${fullKey}'`,
                path,
                rawMatch: `${key}: ${value}`,
              });
            }
          } else if (typeof value === 'number' && value > 0) {
            findings.push({
              code: 'MEASURED_METRIC_CLAIM',
              severity: 'critical',
              message: `Candidate validation artifact asserts quantitative metric claim '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Real-provider claim
        if (['realprovidervalidation', 'realproviderexecution'].includes(lowerKey)) {
          if (value === true) {
            findings.push({
              code: 'REAL_PROVIDER_CLAIM',
              severity: 'critical',
              message: `Candidate validation artifact asserts real-provider execution claim 'true' in '${fullKey}'`,
              path,
              rawMatch: `${key}: true`,
            });
          } else if (
            typeof value === 'string' &&
            !isPlaceholderValue(value) &&
            value.trim().toLowerCase() !== 'false'
          ) {
            findings.push({
              code: 'REAL_PROVIDER_CLAIM',
              severity: 'critical',
              message: `Candidate validation artifact asserts real-provider execution claim '${value}' in '${fullKey}'`,
              path,
              rawMatch: `${key}: ${value}`,
            });
          }
        }

        // Recurse into nested objects
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          inspectJsonObject(value as Record<string, unknown>, fullKey);
        }
      }
    }

    inspectJsonObject(parsed as Record<string, unknown>);
    return findings;
  }

  // Markdown candidate validation report classification
  const lines = stripFencedCodeBlocks(content);

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]!;
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // 1. Checked disposition checkbox: - [x] GO, * [x] APPROVE, etc.
    const checkboxMatch = trimmed.match(
      /^[-*]\s*\[([xX])\]\s*(?:\*\*)?(GO|NO-GO|APPROVE|APPROVED|PROMOTE|PROMOTED|REJECT|REJECTED)\b/i,
    );
    if (checkboxMatch) {
      findings.push({
        code: 'AFFIRMATIVE_DISPOSITION',
        severity: 'critical',
        message: `Candidate validation report contains checked disposition checkbox '${checkboxMatch[0]}'`,
        path,
        line: lineNum,
        rawMatch: checkboxMatch[0],
      });
    }

    // 2. Key-value disposition line: Disposition: GO, Decision: APPROVED, etc.
    const kvDispositionMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?(?:Disposition|Decision|Promotion\s*Decision|Verdict)(?:\*\*)?\s*:\s*(?:\*\*)?(GO|NO-GO|APPROVE|APPROVED|PROMOTE|PROMOTED|REJECT|REJECTED)\b/i,
    );
    if (kvDispositionMatch) {
      findings.push({
        code: 'AFFIRMATIVE_DISPOSITION',
        severity: 'critical',
        message: `Candidate validation report asserts definitive disposition '${kvDispositionMatch[1]}'`,
        path,
        line: lineNum,
        rawMatch: kvDispositionMatch[0],
      });
    }

    // 3. Human / operator sign-off line:
    // Reviewing Authority (Sign-off): opsclawd (operator)
    // Sign-off: Gary
    const signOffMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?(Reviewing\s+Authority(?:\s*\([^)]*\))?|Sign-off|Signed-by|Operator\s+Sign-off|Approving\s+Authority)(?:\*\*)?\s*:\s*(.+)$/i,
    );
    if (signOffMatch) {
      const val = cleanFormatting(signOffMatch[2]!);
      if (!isPlaceholderValue(val)) {
        findings.push({
          code: 'HUMAN_SIGN_OFF',
          severity: 'critical',
          message: `Candidate validation report contains human/operator sign-off attribution '${val}'`,
          path,
          line: lineNum,
          rawMatch: signOffMatch[0],
        });
      }
    }

    // 4. Measured scenario completion claims:
    // Scenarios Passed: 3/3
    const scenarioMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?Scenarios\s+Passed(?:\*\*)?\s*:\s*(.+)$/i,
    );
    if (scenarioMatch) {
      const val = cleanFormatting(scenarioMatch[1]!);
      if (!isPlaceholderValue(val)) {
        const ratioMatch = val.match(RATIO_PATTERN);
        if (ratioMatch) {
          const num = parseInt(ratioMatch[1]!, 10);
          if (num > 0) {
            findings.push({
              code: 'MEASURED_SCENARIO_CLAIM',
              severity: 'critical',
              message: `Candidate validation report asserts measured scenario claim '${val}'`,
              path,
              line: lineNum,
              rawMatch: scenarioMatch[0],
            });
          }
        } else if (/^[0-9]+$/.test(val) && parseInt(val, 10) > 0) {
          findings.push({
            code: 'MEASURED_SCENARIO_CLAIM',
            severity: 'critical',
            message: `Candidate validation report asserts measured scenario claim '${val}'`,
            path,
            line: lineNum,
            rawMatch: scenarioMatch[0],
          });
        }
      }
    }

    // 5. Quantitative metric claims:
    // Requirement Coverage: 100%
    const metricMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?(Requirement\s+Coverage|Story\s+Readiness|Syntax\s+Compliance|Historical\s+Immutability|Scenario\s+Pass\s+Rate|Gate\s+Compliance)(?:\*\*)?\s*:\s*(.+)$/i,
    );
    if (metricMatch) {
      const val = cleanFormatting(metricMatch[2]!);
      if (!isPlaceholderValue(val)) {
        if (PERCENT_PATTERN.test(val) || (/^[0-9]+(\.[0-9]+)?$/.test(val) && parseFloat(val) > 0)) {
          findings.push({
            code: 'MEASURED_METRIC_CLAIM',
            severity: 'critical',
            message: `Candidate validation report asserts quantitative metric claim '${metricMatch[1]}: ${val}'`,
            path,
            line: lineNum,
            rawMatch: metricMatch[0],
          });
        }
      }
    }

    // 6. Real-provider execution assertions:
    // Real-Provider Execution: Completed
    const providerMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?Real[- ]Provider(?:\s+Candidate)?\s+Execution(?:\*\*)?\s*:\s*(.+)$/i,
    );
    if (providerMatch) {
      const val = cleanFormatting(providerMatch[1]!);
      if (!isPlaceholderValue(val) && val.toLowerCase() !== 'false') {
        findings.push({
          code: 'REAL_PROVIDER_CLAIM',
          severity: 'critical',
          message: `Candidate validation report asserts real-provider execution claim '${val}'`,
          path,
          line: lineNum,
          rawMatch: providerMatch[0],
        });
      }
    }

    // 7. Candidate commit SHA binding:
    // Candidate SHA: f3e79a24c18b76df429810a019485bb396e69001
    const shaMatch = trimmed.match(
      /^(?:#{1,6}\s+)?(?:\*\*)?(?:Pinned\s+)?Candidate\s+SHA(?:\*\*)?\s*:\s*(.+)$/i,
    );
    if (shaMatch) {
      const val = cleanFormatting(shaMatch[1]!);
      if (SHA40_PATTERN.test(val)) {
        findings.push({
          code: 'CANDIDATE_SHA_BINDING',
          severity: 'critical',
          message: `Candidate validation report asserts concrete 40-character candidate SHA '${val}'`,
          path,
          line: lineNum,
          rawMatch: shaMatch[0],
        });
      }
    }
  }

  return findings;
}
