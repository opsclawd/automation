const [expectedRepository, mode = 'check', marker = 'TAIL_MARKER'] = process.argv.slice(2);

if (process.env.GITHUB_REPOSITORY !== expectedRepository) {
  console.error('repository_mismatch');
  process.exit(41);
}

if (process.env.AI_SDLC_INHERITED_SENTINEL !== 'sentinel-preserved') {
  console.error('inherited_sentinel_missing');
  process.exit(42);
}

if (mode === 'check') {
  console.log(`Repository=${process.env.GITHUB_REPOSITORY}`);
  console.log(`Sentinel=${process.env.AI_SDLC_INHERITED_SENTINEL}`);
  process.exit(0);
}

if (mode === 'fail-stdout') {
  const payload = 'HEAD_ONLY_' + marker + '\n' + 'X'.repeat(65537) + '\nTAIL_' + marker;
  console.log(payload);
  process.exit(43);
}

if (mode === 'fail-stderr') {
  const payload = 'HEAD_ONLY_' + marker + '\n' + 'X'.repeat(65537) + '\nTAIL_' + marker;
  console.error(payload);
  process.exit(43);
}

console.error(`unknown_mode: ${mode}`);
process.exit(44);
