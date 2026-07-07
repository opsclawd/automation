const Database = require('better-sqlite3');
const { createHash } = require('crypto');
const db = new Database(':memory:');
db.function('sha256_buffer', (val) => createHash('sha256').update(val).digest());
db.function('sha256_hex', (val) => createHash('sha256').update(val).digest('hex'));
const res1 = db.prepare("SELECT lower(hex(sha256_buffer('test'))) as res").get();
const res2 = db.prepare("SELECT lower(hex(sha256_hex('test'))) as res").get();
console.log('buffer:', res1.res);
console.log('hex:', res2.res);
