import { describe, expect, test } from 'vitest';
import type { Resource } from '@storyscript/contracts';
import { castBlockLines, castSyncHash, planCastSync, readCastList, splitActorNames, type CastCharacter } from '../../src/index.ts';

/** S3b: the cast list at the top of a script, and the plan sync it drives. All names are made up. */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const chars: CastCharacter[] = [
  { id: ID(1), name: '林川', aliases: ['林川长大后'], actor_name: null },
  { id: ID(2), name: '苏禾', aliases: [], actor_name: null },
  { id: ID(3), name: '顾先生的父亲', aliases: ['父亲'], actor_name: null },
  { id: ID(4), name: '教导主任', aliases: [], actor_name: null },
  { id: ID(5), name: '校医', aliases: [], actor_name: null },
  { id: ID(6), name: '老师', aliases: [], actor_name: null },
  { id: ID(7), name: '裴明远', aliases: [], actor_name: '周远' },
];

// the shape of a real student script: 演员：角色：简介, a blank-ish header, then the body
const PRE = [
  '人物：',
  '周远：裴明远：主角，一个把哲学读歪了的人',
  '孙晴：林川：小孩子，聪明，喜欢听讲座',
  '沈乐：林川长大后',
  '陈一：苏禾：有钱有势的人',
  '安老师：顾先生的母亲',
  '许老师加上另一位老师：教导主任，校医',
  '白溪：阅览室的老师',
  '剧本：',
];

describe('cast block', () => {
  test('lines between the header and 剧本：', () => {
    expect(castBlockLines(PRE)).toEqual(PRE.slice(1, -1));
  });

  test('without a header, only the lines that say 饰', () => {
    expect(castBlockLines(['片名：远方', '林川（孙晴 饰）', '一个关于远方的故事。'])).toEqual(['林川（孙晴 饰）']);
  });

  test('splitActorNames', () => {
    expect(splitActorNames(' 周远、孙晴 / 沈乐，周远 ')).toEqual(['周远', '孙晴', '沈乐']);
  });
});

describe('readCastList', () => {
  const got = readCastList(PRE, chars);
  const by = (label: string) => got.find((s) => s.character_label === label);

  test('演员：角色：简介 — the character side is found from the roster', () => {
    expect(by('林川')).toMatchObject({ actor_name: '孙晴', entity_id: ID(1), match: 'exact', split_alias: null, current: false });
    expect(by('苏禾')).toMatchObject({ actor_name: '陈一', entity_id: ID(2), match: 'exact' });
  });

  test('an alias played by someone else becomes its own character', () => {
    expect(by('林川长大后')).toMatchObject({ actor_name: '沈乐', entity_id: ID(1), match: 'alias', split_alias: '林川长大后' });
  });

  test('two characters on one line', () => {
    expect(by('教导主任')).toMatchObject({ actor_name: '许老师加上另一位老师', entity_id: ID(4) });
    expect(by('校医')).toMatchObject({ actor_name: '许老师加上另一位老师', entity_id: ID(5) });
  });

  test('near matches, and kinship words never match across', () => {
    expect(by('阅览室的老师')).toMatchObject({ actor_name: '白溪', entity_id: ID(6), match: 'near' });
    // 母亲 ≠ 父亲: no character, but the list's orientation still says who the actor is
    expect(by('顾先生的母亲')).toMatchObject({ actor_name: '安老师', entity_id: null, match: 'none' });
  });

  test('a character that already has this actor is marked current', () => {
    expect(by('裴明远')).toMatchObject({ actor_name: '周远', current: true });
  });

  test('other shapes: 角色（演员 饰）, 演员 饰 角色, 角色——演员, 角色：演员', () => {
    const lines = ['人物表', '林川（孙晴 饰）', '陈一 饰 苏禾（高二学生）', '教导主任——许老师', '校医：白溪', '正文'];
    const s = readCastList(lines, chars);
    expect(s.map((x) => [x.character_label, x.actor_name, x.match])).toEqual([
      ['林川', '孙晴', 'exact'],
      ['苏禾', '陈一', 'exact'],
      ['教导主任', '许老师', 'exact'],
      ['校医', '白溪', 'exact'],
    ]);
  });

  test('descriptions are not actors; a script without a cast list gives nothing', () => {
    expect(readCastList(['人物：', '林川：高二学生，沉默寡言', '苏禾：林川的同桌，爱笑'], chars)).toEqual([]);
    expect(readCastList(['1. 内景 教室 日', '林川走进教室。'], chars)).toEqual([]);
  });
});

describe('planCastSync', () => {
  const res = (id: number, type: Resource['type'], name: string, cast: number[] = []): Resource => ({
    id: ID(id),
    type,
    name,
    windows: [],
    cast_character_ids: cast.map(ID),
    confirmed: true,
  });

  test('new actors, merged when one plays two parts; a part moves from its old performer', () => {
    const changes = planCastSync({
      characters: [
        { id: ID(1), name: '林川', actor_name: '孙晴' },
        { id: ID(2), name: '苏禾', actor_name: '陈一' },
        { id: ID(4), name: '教导主任', actor_name: '许老师' },
        { id: ID(5), name: '校医', actor_name: '许老师' },
        { id: ID(6), name: '老师', actor_name: null },
      ],
      locations: [],
      resources: [res(11, 'performer', '陈一', [2]), res(12, 'performer', '旧演员', [1, 6])],
    });
    expect(changes.map((c) => [c.kind, c.resource_name, c.entity_name, c.from_resource_name])).toEqual([
      ['move_cast', '孙晴', '林川', '旧演员'],
      ['create_performer', '许老师', '教导主任', null],
      ['create_performer', '许老师', '校医', null],
    ]);
    expect(changes[0]!.resource_id).toBeNull();
  });

  test('an existing performer of the same name gains the part', () => {
    const [c] = planCastSync({ characters: [{ id: ID(1), name: '林川', actor_name: ' 孙晴 ' }], locations: [], resources: [res(11, 'performer', '孙晴')] });
    expect(c).toMatchObject({ kind: 'add_cast', resource_id: ID(11), entity_id: ID(1) });
  });

  test('locations: covered ones stay, same-name resources gain them, the rest are created', () => {
    const changes = planCastSync({
      characters: [],
      locations: [
        { id: ID(31), name: '天台' },
        { id: ID(32), name: '走廊' },
        { id: ID(33), name: '阅览室' },
      ],
      resources: [res(41, 'location', '学校天台', [31]), res(42, 'location', '走廊')],
    });
    expect(changes.map((c) => [c.kind, c.resource_name])).toEqual([
      ['add_cast', '走廊'],
      ['create_location', '阅览室'],
    ]);
  });

  test('in sync → no changes; the hash is stable', () => {
    const input = { characters: [{ id: ID(1), name: '林川', actor_name: '孙晴' }], locations: [], resources: [res(11, 'performer', '孙晴', [1])] };
    expect(planCastSync(input)).toEqual([]);
    const other = { ...input, resources: [] };
    expect(castSyncHash(planCastSync(other))).toBe(castSyncHash(planCastSync(other)));
  });
});

describe('call sheet performer label', () => {
  test('actor with the parts they play; unknown characters drop out', async () => {
    const { performerLabel } = await import('../../src/index.ts');
    const names = new Map([[ID(1), '林川'], [ID(2), '苏禾']]);
    expect(performerLabel({ name: '周远', cast_character_ids: [ID(1), ID(2), ID(9)] }, names)).toBe('周远（饰 林川、苏禾）');
    expect(performerLabel({ name: '周远', cast_character_ids: [] }, names)).toBe('周远');
  });
});
