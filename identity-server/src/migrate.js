require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('./db');

(async () => {
  try {
    for (const file of ['001_users.sql', '002_audit.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
      await pool.query(sql);
      console.log(`Applied ${file}`);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
