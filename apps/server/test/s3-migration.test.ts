import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { PROJECT_SCHEMA_VERSION } from '@storyscript/contracts';
import { LATEST_VERSION, migrate, MIGRATIONS, userVersion } from '../src/db/migrations/index.ts';
import { openDb, type DbPort } from '../src/db/port.ts';
import { listEntities } from '../src/db/repos/entity.ts';

/**
 * Migration 3 (S3/S3b): the style table, the rebuilt draft table (kinds
 * style and polish), and entity.actor_name back-filled from performers who
 * alone play a character.
 */

let root: string;
let db: DbPort;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ssm-m3mig-'));
  db = openDb(join(root, 'p.sqlite'));
  await migrate(db, { backupDir: join(root, 'rc'), migrations: MIGRATIONS.filter((m) => m.version <= 2) });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const ent = (id: string, alias: string, name: string, type = 'character') =>
  db.run(`INSERT INTO entity (id, type, alias, name, aliases_json, origin, confirmed) VALUES (?, ?, ?, ?, '[]', 'manual', 1)`, id, type, alias, name);
const performer = (id: string, name: string, cast: string[], type = 'performer') =>
  db.run(`INSERT INTO resource (id, type, name, windows_json, cast_character_ids_json, confirmed) VALUES (?, ?, ?, '[]', ?, 1)`, id, type, name, JSON.stringify(cast));

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('v2 → v3: actor names back-filled only where one performer plays the part', async () => {
  expect(userVersion(db)).toBe(2);
  ent(ID(1), 'c1', '林川');
  ent(ID(2), 'c2', '苏禾');
  ent(ID(3), 'c3', '路人');
  ent(ID(4), 'l1', '天台', 'location');
  performer(ID(11), '周远', [ID(1)]);
  // 苏禾 is played by two people (child and adult): left for the user
  performer(ID(12), '孙晴', [ID(2)]);
  performer(ID(13), '沈乐', [ID(2)]);
  // a location resource never names an actor
  performer(ID(14), '学校天台', [ID(4)], 'location');
  db.run(
    `INSERT INTO shot_draft (id, kind, scope_json, prompt_version, status, created_at) VALUES (?, 'breakdown', '{}', 'breakdown-v1', 'pending', '2026-09-29T00:00:00.000Z')`,
    ID(21),
  );

  const r = await migrate(db, { backupDir: join(root, 'rc') });
  expect(r.applied).toEqual(['003_style_cast']);
  expect(userVersion(db)).toBe(3);
  expect(LATEST_VERSION).toBe(PROJECT_SCHEMA_VERSION);

  const byName = Object.fromEntries(listEntities(db).map((e) => [e.name, e.actor_name]));
  expect(byName).toEqual({ 林川: '周远', 苏禾: null, 路人: null, 天台: null });

  // drafts survived the rebuild, and the new kinds are accepted
  expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shot_draft')?.n).toBe(1);
  db.run(`INSERT INTO shot_draft (id, kind, scope_json, prompt_version, status, created_at) VALUES (?, 'polish', '{}', 'polish-v1', 'pending', '2026-09-29T00:00:00.000Z')`, ID(22));
  db.run(`INSERT INTO shot_draft (id, kind, scope_json, prompt_version, status, created_at) VALUES (?, 'style', '{}', 'style-research-v1', 'pending', '2026-09-29T00:00:00.000Z')`, ID(23));
  expect(() =>
    db.run(`INSERT INTO shot_draft (id, kind, scope_json, prompt_version, status, created_at) VALUES (?, 'nope', '{}', 'x', 'pending', '2026-09-29T00:00:00.000Z')`, ID(24)),
  ).toThrow(/CHECK/);
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_shot_draft_kind_status'")?.n).toBe(1);

  // the style table exists and refuses built-in rows
  expect(() =>
    db.run(
      `INSERT INTO style (id, name, summary, grammar, bias_json, gear, low_budget, origin, created_at, updated_at) VALUES ('x', 'n', '', 'g', '{}', '', '', 'builtin', 't', 't')`,
    ),
  ).toThrow(/CHECK/);
});
