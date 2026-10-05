import type { Database, SqlValue } from 'sql.js';

// Keep the same SQL, validation and task rules as the server edition.
export class BrowserDatabase {
  dirty = false;
  constructor(readonly sqlite: Database) {}
  prepare(sql: string) { return new BrowserStatement(this, sql); }
  async batch(statements: BrowserStatement[]) {
    this.sqlite.run('BEGIN');
    try {
      const results = statements.map(statement => statement.execute(true));
      this.sqlite.run('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.run('ROLLBACK');
      throw error;
    }
  }
}

class BrowserStatement {
  private values: SqlValue[] = [];
  constructor(private database: BrowserDatabase, private sql: string) {}
  bind(...values: SqlValue[]) {
    const bound = new BrowserStatement(this.database, this.sql);
    bound.values = values;
    return bound;
  }
  execute(write = false) {
    const statement = this.database.sqlite.prepare(this.sql);
    const results: Record<string, SqlValue>[] = [];
    try {
      statement.bind(this.values);
      while (statement.step()) results.push(statement.getAsObject());
    } finally { statement.free(); }
    if (write) this.database.dirty = true;
    return { success: true, results, meta: { changes: this.database.sqlite.getRowsModified() } };
  }
  async first(column?: string) {
    const row = this.execute().results[0];
    return row ? column ? row[column] : row : null;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(true); }
}
