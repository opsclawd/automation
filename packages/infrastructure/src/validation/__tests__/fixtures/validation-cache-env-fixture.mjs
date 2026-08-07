const [kind] = process.argv.slice(2);
process.stdout.write(`${kind}:TURBO_FORCE=${process.env.TURBO_FORCE ?? '<unset>'}\n`);
