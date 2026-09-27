/**
 * 002 — what kind of place a source root is (S1b):
 *   fs       an absolute folder the local server reads (unchanged meaning)
 *   project  the project folder itself; paths are relative to it, so moving the
 *            folder keeps footage online (abs_path holds the key 'project:')
 *   browser  a folder on a team member's computer that only the browser reads
 *            (hosted server); abs_path holds 'browser:<uuid>', never a real path
 */
export const ROOT_KIND_SQL = `
ALTER TABLE source_root ADD COLUMN kind TEXT NOT NULL DEFAULT 'fs' CHECK (kind IN ('fs', 'project', 'browser'));
`;
