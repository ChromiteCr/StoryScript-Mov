/**
 * Node version gate. Imported by the CLI shim, so it must stay dependency-free
 * and use only syntax/APIs that very old Node releases understand.
 */

/** Keep in sync with package.json "engines". */
export const MIN_NODE = [24, 15, 0] as const;
export const MIN_NODE_TEXT = MIN_NODE.join('.');

export function nodeVersionOk(version: string): boolean {
  const parts = version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_NODE[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

export function nodeUpgradeHelp(current: string): string {
  return [
    `StoryScript-Mov 需要 Node.js ≥ ${MIN_NODE_TEXT}，当前是 ${current}。`,
    '',
    '修复方法（任选其一）：',
    '  Homebrew：brew install node（已安装则 brew upgrade node）',
    '  fnm：     fnm install 24 && fnm use 24',
    '  Volta：   volta install node@24',
    '',
    '注意：如果用 brew install node@24，它是 keg-only 的，不会自动加入 PATH，需要手动添加：',
    '  echo \'export PATH="$(brew --prefix)/opt/node@24/bin:$PATH"\' >> ~/.zshrc && source ~/.zshrc',
    '',
    '装好后用 node --version 确认版本，再重新运行。',
  ].join('\n');
}
