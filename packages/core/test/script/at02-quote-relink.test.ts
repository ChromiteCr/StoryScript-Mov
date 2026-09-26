import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { matchQuote, normalizeForMatch, parseScript, quoteIsExact, relinkShots, substringEditDistance } from '../../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'scripts');
const BOOKSHOP = readFileSync(join(FIXTURES, '01-bookshop.txt'), 'utf8');

describe('AT-02/03 quote levels', () => {
  const para = '门铃响了一声。林晓（二十多岁）推门进来，外套肩上还有雨点。她在门口停了一下，像是在确认什么。';

  test('exact after NFKC, whitespace and punctuation unification', () => {
    expect(matchQuote('林晓（二十多岁）推门进来', para).level).toBe('exact');
    expect(matchQuote('林晓(二十多岁) 推门进来, 外套肩上还有雨点.', para).level).toBe('exact');
    expect(matchQuote('请问...这里还收旧书吗?', '林晓：请问……这里还收旧书吗？').level).toBe('exact');
    expect(matchQuote('“好”', '他说：「好」。').level).toBe('exact');
  });

  test('fuzzy within 15% of the quote length', () => {
    // 22 characters, 1 inserted ("带")
    const q = '推门进来，外套肩上还带有雨点。她在门口停了一下';
    const r = matchQuote(q, para);
    expect(r.level).toBe('fuzzy');
    expect(r.distance).toBeGreaterThan(0);
    expect(r.distance).toBeLessThanOrEqual(Math.floor(r.length * 0.15));
  });

  test('rejected when too far off, empty, or invented', () => {
    expect(matchQuote('老周从柜台后站起来迎接她', para).level).toBe('rejected');
    expect(matchQuote('', para).level).toBe('rejected');
    expect(matchQuote('   ', para).level).toBe('rejected');
    // short quotes get no fuzzy budget (floor(0.15 * 5) = 0)
    expect(matchQuote('推门出去', para).level).toBe('rejected');
  });

  test('substring edit distance', () => {
    const d = (a: string, b: string) => substringEditDistance(Array.from(a), Array.from(b));
    expect(d('abc', 'xxabcxx')).toBe(0);
    expect(d('abc', 'xxabxx')).toBe(1);
    expect(d('abc', '')).toBe(3);
    expect(d('', 'abc')).toBe(0);
    expect(normalizeForMatch(' 你好 ，世界 ')).toBe('你好,世界');
  });
});

describe('AT-02 relink after the script changes', () => {
  const v1 = parseScript(BOOKSHOP, 'txt', []);
  const v2 = parseScript(BOOKSHOP.replace('老周：看是什么书。', '老周：先看看是什么书。'), 'txt', []);
  const pid = (text: string) => v1.paragraphs.find((p) => p.text === text)!.id;

  test('changing one line flags only the shot quoting it', () => {
    const shots = [
      { id: 'a', source_anchor: { paragraph_id: pid('老周：看是什么书。'), quote: '老周：看是什么书。' } },
      { id: 'b', source_anchor: { paragraph_id: pid('老周没有抬头。'), quote: '老周没有抬头。' } },
      { id: 'c', source_anchor: { paragraph_id: 'p-013', quote: '他摘下眼镜，用拇指按了按眼角' } },
      { id: 'd', source_anchor: null },
    ];
    const r = relinkShots(shots, v2.paragraphs);
    expect(r.needs_relink).toEqual(['a']);
    expect(r.kept).toEqual([
      { shot_id: 'b', paragraph_id: 'p-007' },
      { shot_id: 'c', paragraph_id: 'p-013' },
    ]);
    expect(r.unanchored).toEqual(['d']);
  });

  test('an inserted paragraph moves the anchor by content, not by id or line', () => {
    const v3 = parseScript(BOOKSHOP.replace('老周没有抬头。', '店里很安静。\n\n老周没有抬头。'), 'txt', []);
    const r = relinkShots([{ id: 'b', source_anchor: { paragraph_id: 'p-007', quote: '老周没有抬头。' } }], v3.paragraphs);
    expect(r.kept).toEqual([{ shot_id: 'b', paragraph_id: 'p-008' }]);
  });

  test('ambiguous quotes are not guessed', () => {
    const paras = [
      { id: 'p-001', text: '他点点头。' },
      { id: 'p-002', text: '她也点点头。' },
    ];
    expect(relinkShots([{ id: 'x', source_anchor: { paragraph_id: 'p-009', quote: '点点头' } }], paras).needs_relink).toEqual(['x']);
    // the same paragraph id wins when it still contains the quote
    expect(relinkShots([{ id: 'x', source_anchor: { paragraph_id: 'p-002', quote: '点点头' } }], paras).kept).toEqual([
      { shot_id: 'x', paragraph_id: 'p-002' },
    ]);
    expect(quoteIsExact('', '任何')).toBe(false);
  });
});
