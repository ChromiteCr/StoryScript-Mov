/** Chinese and ASCII numerals as scripts write them: "12", "１２", "十二", "一百零五". */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Character class of the Chinese numeral characters above plus 十 and 百. */
export const CN_NUMERAL_CHARS = '零〇一二两三四五六七八九十百';

/** "12" / "１２" / "十二" / "一百零五" → number; null when not a numeral. */
export function parseSceneNumeral(s: string): number | null {
  const ascii = s.normalize('NFKC');
  if (/^\d+$/.test(ascii)) return parseInt(ascii, 10);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      cur = d;
      seen = true;
    } else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
      seen = true;
    } else if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + cur : null;
}
