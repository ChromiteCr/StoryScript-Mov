import { Project } from '@storyscript/contracts';
import type { DbPort } from '../port.ts';

/** project table ↔ contracts Project. Rows are parsed with zod on the way out. */

interface ProjectRow {
  id: string;
  name: string;
  timezone: string;
  default_aspect: string;
  target_duration_s: number | null;
  look_preset_id: string;
  code_format: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, name, timezone, default_aspect, target_duration_s, look_preset_id, code_format, schema_version, created_at, updated_at';

export function projectFromRow(row: ProjectRow): Project {
  return Project.parse(row);
}

export function insertProject(db: DbPort, p: Project): void {
  const v = Project.parse(p);
  db.run(
    `INSERT INTO project (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.id,
    v.name,
    v.timezone,
    v.default_aspect,
    v.target_duration_s,
    v.look_preset_id,
    v.code_format,
    v.schema_version,
    v.created_at,
    v.updated_at,
  );
}

/** The single project row of this database (null if missing). */
export function getProject(db: DbPort): Project | null {
  const row = db.get<ProjectRow>(`SELECT ${COLUMNS} FROM project LIMIT 1`);
  return row ? projectFromRow(row) : null;
}

export function setProjectSchemaVersion(db: DbPort, id: string, version: number, now: string): void {
  db.run('UPDATE project SET schema_version = ?, updated_at = ? WHERE id = ?', version, now, id);
}
