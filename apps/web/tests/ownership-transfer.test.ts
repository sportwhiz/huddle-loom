import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transferBoardOwnership, transferWorkbookOwnership } from '../src/collaboration.server';
import type { Principal } from '../src/collaboration-types';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const at = new Date().toISOString();
const principal = (id: string) => ({ id, authVersion: 1 } as Principal);

// Run the real service statements and migrations against SQLite, preserving
// D1's batch transaction behavior and allowing a competing commit after reads.
function fixtureDatabase(db: DatabaseSync, beforeBatch: () => void) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => prepare(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    execute: () => {
      const results = db.prepare(sql).all(...values);
      return { success: true, results, meta: { changes: Number(db.prepare('SELECT changes() AS n').get()!.n) } };
    },
  });
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      beforeBatch();
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe('resource ownership transfers', () => {
  let db: DatabaseSync;
  let database: D1Database;
  let competingCommit: () => void;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort())
      db.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
    for (const id of ['owner', 'recipient', 'third']) {
      db.prepare("INSERT INTO users(id,issuer,subject,email,display_name,color,created_at,updated_at) VALUES (?,'fixture',?,?,?,'#4262ff',?,?)").run(id,id,`${id}@example.invalid`,id,at,at);
      db.prepare("INSERT INTO account_security(user_id,status,created_at,updated_at) VALUES (?,'active',?,?)").run(id,at,at);
    }
    db.exec("UPDATE installation SET state = 'ready'");
    db.prepare("INSERT INTO workbooks(id,title,created_at) VALUES ('workbook','Workbook',?)").run(at);
    db.prepare("INSERT INTO boards(id,workbook_id,title,created_at,updated_at,created_by) VALUES ('board','workbook','Board',?,?,'owner')").run(at,at);
    for (const type of ['board', 'workbook'])
      for (const id of ['owner', 'recipient', 'third'])
        db.prepare("INSERT INTO resource_grants(resource_type,resource_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(type,type,id,id === 'owner' ? 'owner' : 'editor',at,at);
    db.prepare("INSERT INTO asset_references(board_id,asset_key,uploaded_by,created_at,byte_size) VALUES ('board','image','third',?,60)").run(at);
    competingCommit = () => {};
    database = fixtureDatabase(db, () => competingCommit());
  });
  afterEach(() => db.close());

  const transfer = (type: 'board' | 'workbook', target = 'recipient') =>
    type === 'board'
      ? transferBoardOwnership(database, type, principal('owner'), target)
      : transferWorkbookOwnership(database, type, principal('owner'), target);
  const owners = (type: string) => db.prepare("SELECT user_id FROM resource_grants WHERE resource_type = ? AND role = 'owner' ORDER BY user_id").all(type).map(row => row.user_id);
  const allocation = () => db.prepare("SELECT created_by FROM boards WHERE id = 'board'").get()!.created_by;
  const guardCount = () => db.prepare('SELECT COUNT(*) AS n FROM resource_ownership_transfers').get()!.n;

  it('moves board and storage accounting to the recipient, preserving uploader provenance', async () => {
    await transfer('board');
    expect(owners('board')).toEqual(['recipient']);
    expect(allocation()).toBe('recipient');
    expect(db.prepare("SELECT role FROM resource_grants WHERE resource_type = 'board' AND user_id = 'owner'").get()!.role).toBe('editor');
    expect(db.prepare('SELECT b.created_by, SUM(a.byte_size) AS bytes FROM asset_references a JOIN boards b ON b.id = a.board_id GROUP BY b.created_by').all()).toEqual([{ created_by: 'recipient', bytes: 60 }]);
    expect(db.prepare('SELECT uploaded_by FROM asset_references').get()!.uploaded_by).toBe('third');
    expect(db.prepare("SELECT actor_id, target_id, metadata FROM security_audit WHERE action = 'board.ownership_transferred'").get()).toEqual({ actor_id: 'owner', target_id: 'board', metadata: '{"recipientId":"recipient"}' });
    expect(guardCount()).toBe(0);
  });

  it.each(['board', 'storage'] as const)('rolls back ownership and audit when the recipient exceeds their %s quota', async quota => {
    if (quota === 'board') db.exec('UPDATE installation SET user_board_limit = 0');
    else db.exec('UPDATE installation SET user_storage_limit = 59');
    await expect(transfer('board')).rejects.toThrow(quota === 'board' ? 'USER_BOARD_LIMIT' : 'USER_STORAGE_LIMIT');
    expect(owners('board')).toEqual(['owner']);
    expect(allocation()).toBe('owner');
    expect(db.prepare('SELECT COUNT(*) AS n FROM security_audit').get()!.n).toBe(0);
    expect(guardCount()).toBe(0);
  });

  it('allows a transfer at the storage limit', async () => {
    db.exec('UPDATE installation SET user_storage_limit = 60');
    await transfer('board');
    expect(allocation()).toBe('recipient');
  });

  it('keeps child boards with their direct owners when a workbook is transferred', async () => {
    await transfer('workbook');
    expect(owners('workbook')).toEqual(['recipient']);
    expect(owners('board')).toEqual(['owner']);
    expect(allocation()).toBe('owner');
  });

  it.each(['board', 'workbook'] as const)('allows only one concurrent %s transfer to commit', async type => {
    const results = await Promise.allSettled([transfer(type), transfer(type, 'third')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(owners(type)).toHaveLength(1);
    expect(owners(type)).not.toContain('owner');
    expect(guardCount()).toBe(0);
  });

  it.each(['board', 'workbook'] as const)('rejects a %s recipient removed after the permission reads', async type => {
    competingCommit = () => db.prepare("DELETE FROM resource_grants WHERE resource_type = ? AND user_id = 'recipient'").run(type);
    await expect(transfer(type)).rejects.toThrow('OWNERSHIP_TRANSFER_CONFLICT');
    expect(owners(type)).toEqual(['owner']);
    expect(allocation()).toBe('owner');
    expect(guardCount()).toBe(0);
  });

  it.each(['suspension', 'revocation', 'recovery'] as const)('rejects an account %s committed after permission reads', async change => {
    competingCommit = () => db.exec(change === 'suspension'
      ? "UPDATE account_security SET status = 'suspended' WHERE user_id = 'recipient'"
      : change === 'recovery'
        ? "UPDATE account_security SET recovery_required = 1 WHERE user_id = 'recipient'"
        : "UPDATE account_security SET auth_version = auth_version + 1 WHERE user_id = 'owner'");
    await expect(transfer('board')).rejects.toThrow('ACCOUNT_UNAVAILABLE');
    expect(owners('board')).toEqual(['owner']);
    expect(allocation()).toBe('owner');
  });

  it('rolls back both ownership and accounting if the audit write fails', async () => {
    db.exec("CREATE TRIGGER failed_transfer_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(transfer('board')).rejects.toThrow('injected failure');
    expect(owners('board')).toEqual(['owner']);
    expect(allocation()).toBe('owner');
    expect(guardCount()).toBe(0);
  });
});
