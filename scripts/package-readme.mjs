// The README shipped in the npm package: the repo README with relative links
// made absolute, so the images and doc links also work on the npm page
// (images → raw files on GitHub, other links → the GitHub page).

/** "git+https://github.com/OWNER/REPO.git" → { blob, raw } bases on the main branch. */
export function githubBases(repositoryUrl, branch = 'main') {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/.exec(repositoryUrl);
  if (!m) throw new Error(`not a GitHub repository URL: ${repositoryUrl}`);
  const [, owner, repo] = m;
  return {
    blob: `https://github.com/${owner}/${repo}/blob/${branch}`,
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
  };
}

const RELATIVE = String.raw`(?!https?:|mailto:|#|\/)([^)\s]+)`;

/** Relative markdown images and links → absolute GitHub URLs. */
export function packageReadme(markdown, repositoryUrl) {
  const { blob, raw } = githubBases(repositoryUrl);
  return markdown
    .replace(new RegExp(String.raw`!\[([^\]]*)\]\(${RELATIVE}\)`, 'g'), (_, alt, path) => `![${alt}](${raw}/${path})`)
    .replace(new RegExp(String.raw`(^|[^!])\[([^\]]*)\]\(${RELATIVE}\)`, 'gm'), (_, pre, text, path) => `${pre}[${text}](${blob}/${path})`);
}
