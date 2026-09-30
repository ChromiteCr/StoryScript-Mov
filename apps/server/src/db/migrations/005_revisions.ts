/**
 * 005 — S4a: optimistic concurrency for the things teammates edit at the
 * same time. Characters, resources, setups and style cards get a revision;
 * an update that names an older one is refused (409) instead of silently
 * overwriting a teammate's change.
 */
export const REVISIONS_SQL = `
ALTER TABLE entity ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resource ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE setup ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE style ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
`;
