const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');
const logger = require('../utils/logger');

function runMigrations() {
  const db = getDb();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`Applying migration: ${file}`);

    db.transaction(() => {
      // Split on semicolons but skip PRAGMA statements in transaction
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        if (stmt.toUpperCase().startsWith('PRAGMA')) {
          // PRAGMAs can't run inside transactions, run separately
          continue;
        }
        db.exec(stmt);
      }
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    })();

    // Run PRAGMAs outside transaction
    const pragmas = sql.split(';')
      .map(s => s.trim())
      .filter(s => s.toUpperCase().startsWith('PRAGMA'));
    for (const pragma of pragmas) {
      db.pragma(pragma.replace(/^PRAGMA\s+/i, ''));
    }

    logger.info(`Migration applied: ${file}`);
  }

  logger.info('All migrations up to date');
}

// Allow running directly: node src/db/migrate.js
if (require.main === module) {
  runMigrations();
  console.log('Migrations complete.');
  process.exit(0);
}

module.exports = { runMigrations };
