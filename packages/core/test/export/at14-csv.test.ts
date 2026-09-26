import type { SourceRange } from '@storyscript/contracts';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { SOURCE_RANGE_COLUMNS, parseCsv, sourceRangeColumns, sourceRangeFromColumns, toCsv } from '../../src/export/csv.ts';

const cols = (...keys: string[]) => keys.map((key) => ({ key, header: key }));

describe('AT-14 (CSV part): no formula execution', () => {
  test.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
  ])('string %j is neutralised', (value, cell) => {
    const csv = toCsv([{ v: value }], cols('v'));
    expect(csv).toBe(`v\r\n${cell}\r\n`);
    expect(parseCsv(csv)[1]).toEqual([`'${value}`]);
  });

  test('a leading CR is neutralised and quoted', () => {
    const csv = toCsv([{ v: '\r=1' }], cols('v'));
    expect(csv).toBe(`v\r\n"'\r=1"\r\n`);
    expect(parseCsv(csv)[1]).toEqual(["'\r=1"]);
  });

  test('numbers are written as numbers, even negative ones; strings in the middle are untouched', () => {
    expect(toCsv([{ a: -5, b: 3.25, c: 'a=b', d: ' =x' }], cols('a', 'b', 'c', 'd'))).toBe('a,b,c,d\r\n-5,3.25,a=b, =x\r\n');
  });

  test('null/undefined → empty; booleans; non-finite numbers → empty', () => {
    expect(toCsv([{ a: null, b: undefined, c: true, d: Number.NaN }], cols('a', 'b', 'c', 'd'))).toBe('a,b,c,d\r\n,,true,\r\n');
  });

  test('headers are escaped too', () => {
    expect(toCsv([], [{ key: 'x', header: '=evil' }])).toBe("'=evil\r\n");
  });
});

describe('Chinese text, delimiters and BOM', () => {
  const rows = [
    { code: '1A', note: '内景，咖啡馆——日', dialog: '他说："走吧。"\n她没回头。' },
    { code: '12', note: '外景 街道, 夜', dialog: '' },
  ];
  const columns = [
    { key: 'code', header: '镜号' },
    { key: 'note', header: '备注' },
    { key: 'dialog', header: '对白' },
  ];

  test('quotes commas, quotes and newlines; round-trips exactly', () => {
    const csv = toCsv(rows, columns);
    expect(csv).toBe('镜号,备注,对白\r\n1A,内景，咖啡馆——日,"他说：""走吧。""\n她没回头。"\r\n12,"外景 街道, 夜",\r\n');
    expect(parseCsv(csv)).toEqual([['镜号', '备注', '对白'], ...rows.map((r) => [r.code, r.note, r.dialog])]);
  });

  test('BOM is optional and ignored by the reader', () => {
    const withBom = toCsv(rows, columns, { bom: true });
    expect(withBom.charCodeAt(0)).toBe(0xfeff);
    expect(toCsv(rows, columns).charCodeAt(0)).not.toBe(0xfeff);
    expect(parseCsv(withBom)).toEqual(parseCsv(toCsv(rows, columns)));
  });

  test('reader accepts LF-only and missing final newline', () => {
    expect(parseCsv('a,b\n1,"x\ny"')).toEqual([
      ['a', 'b'],
      ['1', 'x\ny'],
    ]);
  });

  test('property: any strings not starting with a formula character round-trip', () => {
    const safe = fc.string({ unit: 'binary' }).filter((s) => !/^[=+\-@\t\r]/.test(s));
    fc.assert(
      fc.property(fc.array(fc.tuple(safe, safe), { minLength: 1, maxLength: 5 }), (pairs) => {
        const csv = toCsv(
          pairs.map(([a, b]) => ({ a, b })),
          cols('a', 'b'),
        );
        expect(parseCsv(csv).slice(1)).toEqual(pairs);
      }),
      { numRuns: 300 },
    );
  });
});

describe('source_range as five integer columns', () => {
  const columns = SOURCE_RANGE_COLUMNS.map((key) => ({ key, header: key }));
  const roundTrip = (range: SourceRange): SourceRange | null => {
    const [header, row] = parseCsv(toCsv([sourceRangeColumns(range)], columns, { bom: true }));
    return sourceRangeFromColumns(Object.fromEntries(header!.map((h, i) => [h, row![i]])));
  };

  test('fixed cases incl. negative PTS and values next to MAX_SAFE_INTEGER', () => {
    const cases: SourceRange[] = [
      { stream_index: 0, in_pts: 90000, out_pts: 450000, time_base_num: 1, time_base_den: 90000 },
      { stream_index: 2, in_pts: -1024, out_pts: 0, time_base_num: 1001, time_base_den: 30000 },
      { stream_index: 1, in_pts: Number.MAX_SAFE_INTEGER - 1, out_pts: Number.MAX_SAFE_INTEGER, time_base_num: 1, time_base_den: 1 },
      { stream_index: 0, in_pts: -Number.MAX_SAFE_INTEGER, out_pts: -Number.MAX_SAFE_INTEGER + 1, time_base_num: 1, time_base_den: 48000 },
    ];
    for (const r of cases) expect(roundTrip(r)).toEqual(r);
    expect(toCsv([sourceRangeColumns(cases[1]!)], columns)).toBe(
      'stream_index,in_pts,out_pts,time_base_num,time_base_den\r\n2,-1024,0,1001,30000\r\n',
    );
  });

  test('property: lossless for any safe-integer range', () => {
    const pts = fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER - 1 });
    fc.assert(
      fc.property(pts, fc.integer({ min: 1, max: 1_000_000 }), fc.nat(64), fc.integer({ min: 1, max: 1_000_000 }), (inPts, len, stream, den) => {
        const range = {
          stream_index: stream,
          in_pts: inPts,
          out_pts: Math.min(Number.MAX_SAFE_INTEGER, inPts + len),
          time_base_num: 1,
          time_base_den: den,
        };
        expect(roundTrip(range)).toEqual(range);
      }),
      { numRuns: 500 },
    );
  });

  test('reader refuses rounded, fractional or unsafe cells instead of guessing', () => {
    const base = { stream_index: '0', in_pts: '0', out_pts: '10', time_base_num: '1', time_base_den: '25' };
    expect(sourceRangeFromColumns(base)).toEqual({ stream_index: 0, in_pts: 0, out_pts: 10, time_base_num: 1, time_base_den: 25 });
    expect(sourceRangeFromColumns({ ...base, in_pts: '1.5' })).toBeNull();
    expect(sourceRangeFromColumns({ ...base, in_pts: '9007199254740993' })).toBeNull();
    expect(sourceRangeFromColumns({ ...base, in_pts: '1e3' })).toBeNull();
    expect(sourceRangeFromColumns({ ...base, in_pts: "'-5" })).toBeNull();
    expect(sourceRangeFromColumns({ ...base, out_pts: undefined })).toBeNull();
  });
});
