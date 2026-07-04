const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const findSqlite = (dir) => {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git') {
        findSqlite(fullPath);
      }
    } else if (file.endsWith('.sqlite')) {
      console.log('Found SQLite:', fullPath);
      const db = new Database(fullPath);
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log('Tables:', tables.map(t => t.name).join(', '));
        if (tables.some(t => t.name === 'pr_review_comments')) {
           const comments = db.prepare("SELECT * FROM pr_review_comments").all();
           console.log('PR Comments:', JSON.stringify(comments, null, 2));
        }
      } catch (e) {
        console.error('Error reading', fullPath, e.message);
      }
    }
  }
};

try {
  findSqlite('/app');
} catch (e) {}
