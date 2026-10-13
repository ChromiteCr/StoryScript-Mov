import { describe, expect, it } from 'vitest';
import { ShotDifficulty, ShotGear, TIP_SHOTS_MAX, type ActorRef, type Plan, type ScheduleBlock, type ShotTip } from '@storyscript/contracts';
import { localToUtc } from '@storyscript/core';
import { AREA_ROOTS, isCoveredKey } from '../src/lib/collab-areas.ts';
import { JOB_KIND_LABEL, tipsSlot } from '../src/lib/jobs.ts';
import { buildLookup, shotsInShootingOrder } from '../src/lib/print-plan.ts';
import { tipsKeys } from '../src/lib/queries-tips.ts';
import {
  DIFFICULTY_LABEL,
  difficultyText,
  GEAR_LABEL,
  gearLabels,
  hardShotIds,
  isStaleTip,
  keySource,
  RULE_SOURCE_TEXT,
  sceneHasAiTips,
  tipsAction,
  tipsAppendix,
  tipsBlockedReason,
  tipsByShot,
  tipsConfirmLines,
  tipsConfirmTitle,
  tipsDoneNotice,
  tipSourceText,
  type TipsConfirmInput,
} from '../src/lib/tips.ts';
import { USAGE_KIND_LABEL } from '../src/lib/usage.ts';
import { shot, uuid } from './fixtures.ts';

// S5c web logic: the tip labels, where a tip comes from, when it is out of
// date, the confirmation before the per-scene job (remote and demo), and the
// call sheet's 附拍摄提示 appendix in shooting order. Pure, no DOM. Names are made up.

const jie: ActorRef = { id: 'a-jie', name: '阿杰', crew_roles: ['导演'], left: false };

const aiTip = (shotId: string, over: Partial<ShotTip> = {}): ShotTip => ({
  shot_id: shotId,
  difficulty: 'medium',
  gear: ['tripod', 'external_mic'],
  tips: ['在门口地面贴胶带标出停步的位置', '先对焦在标记处并锁定'],
  mistake: '门外太亮，开门那一下画面发白',
  source: 'ai',
  stale: false,
  created_at: '2026-10-13T02:32:00.000Z',
  actor: jie,
  prompt_version: 'tips-v1',
  ...over,
});

const ruleTip = (shotId: string, over: Partial<ShotTip> = {}): ShotTip => ({
  shot_id: shotId,
  difficulty: 'easy',
  gear: ['tripod'],
  tips: [],
  mistake: null,
  source: 'rule',
  stale: false,
  created_at: null,
  actor: null,
  prompt_version: null,
  ...over,
});

describe('tips: labels', () => {
  it('every difficulty and gear has a Chinese label', () => {
    for (const d of ShotDifficulty.options) expect(DIFFICULTY_LABEL[d].trim()).not.toBe('');
    for (const g of ShotGear.options) expect(GEAR_LABEL[g].trim()).not.toBe('');
    expect([DIFFICULTY_LABEL.easy, DIFFICULTY_LABEL.medium, DIFFICULTY_LABEL.hard]).toEqual(['易', '中', '难']);
    expect(difficultyText('hard')).toBe('难度：难');
    expect(gearLabels(['tripod', 'external_mic', 'phone_lens'])).toEqual(['三脚架', '外接麦', '手机外接镜头']);
    expect(gearLabels([])).toEqual([]);
  });

  it('the job is called 拍摄提示 in the job list and the usage report', () => {
    expect(JOB_KIND_LABEL.shot_tips).toBe('拍摄提示');
    expect(USAGE_KIND_LABEL.shot_tips).toBe('拍摄提示');
    expect(tipsSlot('scene-1')).toBe('tips:scene-1');
  });

  it('tips refresh with the shots area (shot edits, the shot_tips job)', () => {
    expect(tipsKeys.view).toEqual(['tips']);
    expect(AREA_ROOTS.shots).toContainEqual(['tips']);
    expect(isCoveredKey(tipsKeys.view)).toBe(true);
  });

  it('by shot, and only hard shots get the 难 badge', () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    const view = { tips: [ruleTip(a), aiTip(b, { difficulty: 'hard' }), ruleTip(c, { difficulty: 'hard' })] };
    const map = tipsByShot(view);
    expect(map.get(b)?.source).toBe('ai');
    expect(map.size).toBe(3);
    expect([...hardShotIds(view)].sort()).toEqual([b, c].sort());
    expect(hardShotIds(undefined).size).toBe(0);
    expect(tipsByShot(null).size).toBe(0);
  });
});

describe('tips: the source line', () => {
  const tz = 'Asia/Shanghai';
  const now = new Date('2026-10-13T06:00:00.000Z');

  it('a first guess says so', () => {
    expect(tipSourceText(ruleTip(uuid()), now, tz)).toBe(RULE_SOURCE_TEXT);
    expect(RULE_SOURCE_TEXT).toBe('按镜头字段估计');
  });

  it('the model\'s tips: AI · who and when (the day when it is not today)', () => {
    expect(tipSourceText(aiTip(uuid()), now, tz)).toBe('AI · 阿杰 10:32');
    expect(tipSourceText(aiTip(uuid(), { created_at: '2026-10-11T02:32:00.000Z' }), now, tz)).toBe('AI · 阿杰 10月11日 10:32');
    expect(tipSourceText(aiTip(uuid(), { actor: { ...jie, left: true } }), now, tz)).toBe('AI · 阿杰（已离开） 10:32');
  });

  it('the local app has no actor', () => {
    expect(tipSourceText(aiTip(uuid(), { actor: null }), now, tz)).toBe('AI · 10:32');
    expect(tipSourceText(aiTip(uuid(), { actor: null, created_at: null }), now, tz)).toBe('AI');
  });
});

describe('tips: stale', () => {
  it('only the model\'s tips go stale; the action follows', () => {
    expect(isStaleTip(aiTip(uuid(), { stale: true }))).toBe(true);
    expect(isStaleTip(aiTip(uuid()))).toBe(false);
    // a first guess is worked out on every read: never stale, whatever the flag says
    expect(isStaleTip(ruleTip(uuid(), { stale: true }))).toBe(false);
    expect(isStaleTip(null)).toBe(false);

    expect(tipsAction(aiTip(uuid(), { stale: true }))).toEqual({ stale: true, label: '重新生成本场' });
    expect(tipsAction(aiTip(uuid()))).toEqual({ stale: false, label: 'AI 生成本场拍摄提示' });
    expect(tipsAction(ruleTip(uuid()))).toEqual({ stale: false, label: 'AI 生成本场拍摄提示' });
    expect(tipsAction(undefined).label).toBe('AI 生成本场拍摄提示');
  });

  it('whether the scene already has the model\'s tips', () => {
    const [a, b, other] = [uuid(), uuid(), uuid()];
    const map = tipsByShot({ tips: [ruleTip(a), ruleTip(b), aiTip(other)] });
    expect(sceneHasAiTips([a, b], map)).toBe(false);
    expect(sceneHasAiTips([a, other], map)).toBe(true);
  });

  it('when the button is off', () => {
    const on = { enabled: true, reason: null };
    expect(tipsBlockedReason({ ai: on, shots: 12, running: false })).toBeNull();
    expect(tipsBlockedReason({ ai: { enabled: false, reason: '还没有配置模型' }, shots: 12, running: false })).toBe('还没有配置模型');
    expect(tipsBlockedReason({ ai: { enabled: false, reason: null }, shots: 12, running: false })).toBe('AI 暂时不可用');
    expect(tipsBlockedReason({ ai: on, shots: 12, running: true })).toBe('本场的拍摄提示正在生成');
    expect(tipsBlockedReason({ ai: on, shots: 0, running: false })).toBe('这一场还没有镜头');
    expect(tipsBlockedReason({ ai: on, shots: TIP_SHOTS_MAX, running: false })).toBeNull();
    expect(tipsBlockedReason({ ai: on, shots: TIP_SHOTS_MAX + 1, running: false })).toContain(`超过 ${TIP_SHOTS_MAX} 个`);
  });

  it('after the job: says how many shots got nothing usable', () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    const since = '2026-10-12T02:00:00.000Z';
    const now = { created_at: '2026-10-12T02:00:05.000Z' };
    const all = tipsByShot({ tips: [aiTip(a, now), aiTip(b, now), aiTip(c, { ...now, stale: true })] });
    expect(tipsDoneNotice('1', [a, b, c], all, since)).toBeNull();
    const some = tipsByShot({ tips: [aiTip(a, now), ruleTip(b), ruleTip(c)] });
    expect(tipsDoneNotice('1', [a, b, c], some, since)).toBe('第 1 场的拍摄提示已生成；2 个镜头没有拿到可用的提示，已略去（保留原来的提示或按镜头字段估计）。');
    // a shot left out of a re-run keeps its earlier AI tip: still counted as left out
    const rerun = tipsByShot({ tips: [aiTip(a, now), aiTip(b, now), aiTip(c, { created_at: '2026-10-11T09:00:00.000Z' })] });
    expect(tipsDoneNotice('1', [a, b, c], rerun, since)).toContain('1 个镜头没有拿到可用的提示');
  });
});

describe('tips: the confirmation', () => {
  const base: TipsConfirmInput = { demo: false, host: 'api.example.com', sceneNo: '1', shots: 12, key: 'local', again: false, unsaved: false };
  const text = (o: Partial<TipsConfirmInput>) => tipsConfirmLines({ ...base, ...o }).join('\n');

  it('remote: which service, the scene\'s shots, at most 3 requests', () => {
    const t = text({});
    expect(t).toContain('发送到 api.example.com');
    expect(t).toContain('本场 12 个镜头');
    expect(t).toContain('每步最多外发 3 次');
    expect(t).toContain('不会改动镜头');
    expect(t).not.toContain('回放');
    // the local app has no daily cap: nothing is said about one
    expect(t).not.toContain('上限');
    expect(text({ host: null })).toContain('发送到 你配置的地址');
  });

  it('whose key: the group\'s counts against its daily cap, one\'s own does not', () => {
    expect(keySource(undefined)).toBe('local');
    expect(keySource({ hosted: false, text_model_source: null })).toBe('local');
    expect(keySource({ hosted: true, text_model_source: 'group' })).toBe('group');
    expect(keySource({ hosted: true, text_model_source: 'own' })).toBe('own');
    expect(text({ key: 'group' })).toContain('计入本组的每日上限');
    expect(text({ key: 'own' })).toContain('不计入本组的每日上限');
  });

  it('demo: replays the recorded example, nothing leaves the machine', () => {
    const t = text({ demo: true, key: 'group' });
    expect(t).toContain('回放录好的示例');
    expect(t).toContain('本场 12 个镜头');
    expect(t).toContain('不外发');
    expect(t).not.toContain('发送到');
    expect(t).not.toContain('api.example.com');
    expect(t).not.toContain('每日上限');
  });

  it('again and unsaved edits', () => {
    expect(tipsConfirmTitle(false)).toBe('AI 生成本场拍摄提示');
    expect(tipsConfirmTitle(true)).toBe('重新生成本场拍摄提示');
    expect(text({ again: true })).toContain('替换本场现有的 AI 提示');
    expect(text({ again: false })).not.toContain('替换');
    expect(text({ unsaved: true })).toContain('按已保存的内容生成');
    expect(text({ unsaved: false })).not.toContain('未保存');
  });
});

describe('tips: the call sheet appendix', () => {
  const TZ = 'Asia/Shanghai';
  const DAY = '2026-10-05';
  const L = (t: string) => localToUtc(DAY, t, TZ, 0);
  const SCENE1 = uuid();
  const SCENE2 = uuid();
  const s1 = shot({ scene_id: SCENE1, code: '001' });
  const s2 = shot({ scene_id: SCENE1, code: '002' });
  const s3 = shot({ scene_id: SCENE1, code: '003' });
  const s4 = shot({ scene_id: SCENE2, code: '001' });
  const gone = uuid(); // in the plan, no longer in the project

  const block = (bid: string, kind: ScheduleBlock['kind'], start: string, end: string, shotIds: string[]): ScheduleBlock => ({
    id: bid,
    kind,
    setup_id: null,
    shot_ids: shotIds,
    resource_ids: [],
    start_utc: start,
    end_utc: end,
    locked: false,
  });

  // scene 2 shoots first, then 003 before 001 and 002; a setup block carries no shots
  const plan: Pick<Plan, 'result'> = {
    result: {
      outcome: 'feasible',
      order: [],
      blocks: [
        block('b2', 'shoot', L('11:00'), L('12:00'), [s3.id, s1.id, gone, s2.id]),
        block('b0', 'setup', L('08:30'), L('09:00'), []),
        block('b1', 'shoot', L('09:00'), L('10:00'), [s4.id]),
      ],
      unplaced: [],
      contradictions: [],
      violations: [],
      algorithm_version: 'x',
      validator_version: 'y',
    },
  };
  const lookup = buildLookup({
    timezone: TZ,
    date: DAY,
    setups: [],
    shots: [s1, s2, s3, s4],
    resources: [],
    scenes: [
      { id: SCENE1, display_no: '1' },
      { id: SCENE2, display_no: '2' },
    ],
  });
  const tips = tipsByShot({
    tips: [
      aiTip(s1.id, { difficulty: 'easy', gear: [] }),
      // rule-only: left out of the appendix and counted
      ruleTip(s2.id),
      aiTip(s3.id, { difficulty: 'hard', gear: ['gimbal', 'external_mic'], tips: ['甲', '乙', '丙'], stale: true }),
      aiTip(s4.id),
    ],
  });

  it('follows the call sheet\'s shooting order, with the model\'s tips only', () => {
    const order = shotsInShootingOrder(plan);
    expect(order).toEqual([s4.id, s3.id, s1.id, gone, s2.id]);
    const { rows, without } = tipsAppendix(order, lookup, tips);
    expect(rows.map((r) => r.ref)).toEqual(['2-001', '1-003', '1-001']);
    expect(without).toBe(1);
    expect(rows[1]).toEqual({
      shot_id: s3.id,
      ref: '1-003',
      difficulty: '难',
      gear: '稳定器、外接麦',
      tips: ['甲', '乙', '丙'],
      mistake: '门外太亮，开门那一下画面发白',
      stale: true,
    });
    expect(rows[2]!.gear).toBe('—');
    expect(rows[0]!.difficulty).toBe('中');
  });

  it('nothing to print without the model\'s tips', () => {
    const none = tipsByShot({ tips: [ruleTip(s1.id), ruleTip(s2.id), ruleTip(s3.id), ruleTip(s4.id)] });
    expect(tipsAppendix(shotsInShootingOrder(plan), lookup, none)).toEqual({ rows: [], without: 4 });
    expect(tipsAppendix([], lookup, tips)).toEqual({ rows: [], without: 0 });
  });
});
