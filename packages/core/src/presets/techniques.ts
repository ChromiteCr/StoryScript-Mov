import type { LookPreset, Technique } from '@storyscript/contracts';

/**
 * Built-in technique cards and look preset. All text is original to this
 * project (MIT). Per docs/CLEANROOM.md no director, storyboard artist, film
 * title or trademark appears here; cards describe general film grammar.
 */

export const TECHNIQUES: readonly Technique[] = [
  {
    id: 'dialogue_coverage',
    version: 1,
    name: '对话覆盖 · 视点纪律',
    intended_effect: '让观众始终清楚"此刻站在谁的视角"，随着对话推进逐步收紧景别，把情绪转折交给近景。',
    shot_grammar: [
      '先用一个交代双方位置的双人镜头或中景建立 180° 轴线；',
      '正反打用过肩镜头，前景肩膀属于当前视点人物（pov_owner），被画框裁切；',
      '情绪转折处从过肩切到单人近景（MCU/CU）；',
      '推动情节的物件用插入镜头（INSERT）；',
      '保持轴线不变；若刻意越轴，在 assumptions 中写明原因。',
    ].join(''),
    camera_defaults: {
      focal_mm: 50,
      camera_height_m: null,
      pitch_deg: null,
      shot_size_bias: ['MS', 'MCU', 'CU'],
      angle_bias: ['eye'],
      lens_bias: ['normal'],
      movement_bias: ['static', 'push_in'],
    },
    applicable_scenes: '两到三人的对话、问询、谈判、告白等以台词推进的场面。',
    resource_cost_notes: '低：一台摄影机、两个主要机位即可完成。',
    low_budget_alternative: '单机拍摄时先拍完一侧的全部镜头（正打），再翻机位拍另一侧（反打），减少重新布光。',
    sources: [{ title: '通用镜头语法：180° 轴线、正反打与视点', url: null, basis_type: 'general' }],
    limitations: '只给出镜头单位与默认机位，不决定最终剪辑点；多人走位复杂时需要人工布局。',
    builtin: true,
  },
  {
    id: 'parallel_crosscut',
    version: 1,
    name: '双线交叉 · 赶时间',
    intended_effect: '两条（或多条）时间线交替推进、节奏逐步加快，最后在一个时刻汇合，制造紧迫感。',
    shot_grammar: [
      '每条线先有一个清晰的空间标识镜头（环境、交通工具或钟表）；',
      '交替时镜头预计时长逐步缩短；',
      '给每条线固定一个主运动方向（例如 A 线左→右、B 线右→左）以便区分；',
      '时间信息用插入镜头（钟、屏幕、手机）交代；',
      '汇合前一刻用最紧的景别；可在 set_piece 的大动作处用低机位广角放大尺度。',
    ].join(''),
    camera_defaults: {
      focal_mm: null,
      camera_height_m: null,
      pitch_deg: null,
      shot_size_bias: ['WS', 'MS', 'INSERT', 'CU'],
      angle_bias: ['eye', 'low'],
      lens_bias: ['wide', 'normal'],
      movement_bias: ['track', 'handheld', 'vehicle'],
    },
    applicable_scenes: '赶时间、营救、倒计时、两地同时发生的事件。',
    resource_cost_notes: '中：两条线往往是两个场地，需要在排期中分别成组。',
    low_budget_alternative: '用同一场地的不同角落、不同光色区分两条线；钟表和屏幕的插入镜头可以事后单独补拍。',
    sources: [{ title: '通用剪辑语法：平行剪辑与交叉剪辑', url: null, basis_type: 'general' }],
    limitations: '节奏最终由剪辑决定；拆镜只保证每条线都有足够的覆盖。',
    builtin: true,
  },
  {
    id: 'suspense_reveal',
    version: 1,
    name: '悬疑揭示 · 延迟信息',
    intended_effect: '先让观众看到反应、再看到原因；或先给局部、再给全貌，把关键信息推迟到最有力的时刻。',
    shot_grammar: [
      '以视点人物的近景反应或主观镜头开场；',
      '关键物件先以局部、遮挡或画外的方式出现；',
      '揭示时做一次明显的景别跳变（特写→全景，或全景→特写）；',
      '揭示镜头保持静止，给观众阅读时间；',
      '反应镜头放在揭示之后，而不是之前。',
    ].join(''),
    camera_defaults: {
      focal_mm: 85,
      camera_height_m: null,
      pitch_deg: null,
      shot_size_bias: ['CU', 'ECU', 'INSERT', 'WS'],
      angle_bias: ['eye', 'low'],
      lens_bias: ['tele', 'wide'],
      movement_bias: ['static', 'push_in'],
    },
    applicable_scenes: '发现、认出、真相揭晓、开门看到房间里有什么。',
    resource_cost_notes: '低到中：多用近景与插入，主要成本在美术道具的细节。',
    low_budget_alternative: '用前景遮挡与手动跟焦代替复杂的摄影机运动。',
    sources: [{ title: '通用叙事语法：悬念与信息延迟', url: null, basis_type: 'general' }],
    limitations: '揭示时机取决于表演与剪辑，这里只给出镜头顺序建议。',
    builtin: true,
  },
];

export const LOOK_WIDE_PENCIL: LookPreset = {
  id: 'wide_pencil',
  version: 1,
  name: '宽银幕铅笔分镜',
  default_aspect: '2.39',
  center_guide: true,
  set_piece_low_wide: true,
  pencil: {
    hatch_angle_deg: 38,
    paper_tone: '#F3F0E8',
    outline_px: { fg: 2.2, mg: 1.4, bg: 0.9 },
  },
};

export function findTechnique(id: string | null | undefined, extra: readonly Technique[] = []): Technique | null {
  if (!id) return null;
  return [...TECHNIQUES, ...extra].find((t) => t.id === id) ?? null;
}
