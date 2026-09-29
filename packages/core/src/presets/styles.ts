import type { StyleCard, StyleLevel } from '@storyscript/contracts';

/**
 * S3 built-in style cards. Original text, named after the technique only:
 * no director, cinematographer, film title or format brand appears here or in
 * any prompt (docs/CLEANROOM.md §3). A user who wants "the look of film X"
 * types it into style research; the result is their own, unverified card.
 */

type Builtin = Omit<StyleCard, 'origin' | 'reference' | 'unverified' | 'created_at' | 'updated_at'>;

const card = (c: Builtin): StyleCard => ({ ...c, origin: 'builtin', reference: null, unverified: false, created_at: null, updated_at: null });

export const BUILTIN_STYLES: readonly StyleCard[] = [
  card({
    id: 'style.track-low',
    name: '赛道贴地：车载多机位与长焦压缩',
    summary: '速度靠贴地机位、车身硬挂和长焦压缩来表现，剪辑节奏跟着引擎声走。',
    grammar: [
      '机位尽量低：贴近地面或车身，让路面和背景高速掠过，主体放在画面下三分之一。',
      '车载硬挂：车头、车侧、驾驶位各一个固定视角，驾驶者的眼睛、手和仪表交替插入。',
      '长焦压缩：在弯道外侧用长焦把前后两辆车压在一起，距离显得极近。',
      '跟车拍摄：另一辆车并行或尾随，稳定器放低跟拍。',
      '节奏：高速段用 1–2 秒的短镜头快切；关键的超越给一个稍长的镜头，让观众看清两车的空间关系；静止与高速交替。',
      '主观视角：驾驶者的主观镜头与车外客观镜头交替，让观众觉得"我就在车里"。',
    ].join('\n'),
    bias: { shot_size: ['CU', 'ECU', 'WS', 'INSERT'], angle: ['low', 'eye'], lens: ['tele', 'wide'], movement: ['vehicle', 'track', 'handheld'] },
    gear: '车载吸盘支架、并行跟拍的车辆和司机、长焦镜头、运动相机；必须在封闭场地或极低车速下拍，专人负责安全。',
    low_budget: '用自行车、滑板或推车代替汽车；手机贴近地面慢速跟拍，剪辑时加速；玩具车加微距镜头也能拍出贴地效果。',
  }),
  card({
    id: 'style.epic-film',
    name: '胶片史诗：大特写、对称与交叉剪辑',
    summary: '人物内心用极近的面部特写来讲，环境用宏大的空镜，几条时间线交叉推进。',
    grammar: [
      '面部大特写：人物的决定和动摇都落在眼睛、嘴角的极近特写上，背景虚到只剩色块。',
      '宏大空镜：用大远景交代环境的尺度，人很小、环境很大；空镜也是段落之间的呼吸。',
      '对称与正面：对峙、审问、会议这类场面用正面对称构图，人物居中直视。',
      '交叉剪辑：两到三条时间线（过去、现在、想象）交替推进，每条线用光线或色调区分。',
      '插入物件：推动情节的信、钥匙、笔记给极近的插入镜头，常配合声音强调。',
      '节奏：对白段落镜头偏长、机位克制；情绪高点用越来越快的交叉剪辑和声音叠加推上去。',
    ].join('\n'),
    bias: { shot_size: ['ECU', 'CU', 'EWS'], angle: ['eye', 'low'], lens: ['tele', 'wide'], movement: ['static', 'push_in'] },
    gear: '能靠得很近的镜头（微距或长焦）、三脚架、柔光；大远景需要开阔场地或高处机位。',
    low_budget: '手机人像模式或夹式微距镜头拍特写；大远景找天台、操场、空旷的走廊；用冷暖不同的灯光或调色区分时间线。',
  }),
  card({
    id: 'style.handheld-doc',
    name: '手持纪实：跟拍与临场感',
    summary: '摄影机像一个在场的人：跟着人物走，会晃、会错过，追求真实的临场感。',
    grammar: [
      '手持跟拍：摄影机在人物身后或侧面跟随，人物进出画面不刻意构图。',
      '反应优先：对话时常常停在听的人脸上，而不是说话的人。',
      '允许不完美：轻微失焦、突然摇过去找人、被前景挡住都可以，但不要为晃而晃。',
      '镜头偏长：一个镜头里完成一段动作或对话，少切；要切时用跳切。',
      '自然光：窗光、路灯、屏幕光作为主光源。',
      '距离近：多用中近景和近景，广角或标准镜头贴近人物。',
    ].join('\n'),
    bias: { shot_size: ['MCU', 'MS', 'CU'], angle: ['eye'], lens: ['normal', 'wide'], movement: ['handheld', 'track'] },
    gear: '手持或肩扛的相机或手机、能听清对白的收音；摄影师要熟悉演员的走位。',
    low_budget: '手机开防抖直接手持即可；让一个同学专门跟拍收音；多排练走位，比设备更重要。',
  }),
  card({
    id: 'style.oner',
    name: '一镜到底：长镜头调度',
    summary: '把几段动作设计成连续的长镜头，摄影机随演员穿过门、走廊和楼梯。',
    grammar: [
      '调度先于剪辑：把一段戏设计成一个或几个连续长镜头，摄影机随人物穿行，远景、中景、特写都在一个镜头里完成。',
      '景别靠距离变化：不切镜头，而是让摄影机靠近或远离，或让演员走向镜头。',
      '接点藏在运动里：经过门框、柱子、黑暗处时可以藏接点，把几个长镜头接成"看起来一镜到底"。',
      '每个长镜头在拍法说明里写清起点、路线、经过的节点、终点，以及演员何时进出画。',
      '段落之间用一个明确的切点（一声响动或一个动作）换段。',
    ].join('\n'),
    bias: { shot_size: ['WS', 'MS', 'MCU'], angle: ['eye'], lens: ['wide', 'normal'], movement: ['track', 'handheld', 'crane', 'orbit'] },
    gear: '稳定器、清空的走位路线、对讲机或手势信号；需要多次排练，演员和摄影师都要记住路线。',
    low_budget: '手机稳定器沿走廊和楼梯完成；把长镜头缩短到每段 20–40 秒，接点藏在门框或转身处。',
  }),
  card({
    id: 'style.still-space',
    name: '静观留白：固定机位与远景',
    summary: '固定机位、远景、长时间停留，少运动多留白，让观众自己在画面里找情绪。',
    grammar: [
      '固定机位为主：三脚架不动，人物在画面里走动、进出画。',
      '多用远景和全景：人物常常很小，环境、天空、墙面占大面积。',
      '镜头停得久：动作结束后多停几秒，让情绪沉下来。',
      '构图留白：人物放在画面边缘，另一侧留出空间；用门框、窗框做框中框。',
      '声音代替特写：环境声、脚步声表达情绪，而不是切到脸。',
      '只在情绪转折处用一次很慢的推近。',
    ].join('\n'),
    bias: { shot_size: ['WS', 'EWS', 'FS'], angle: ['eye', 'high'], lens: ['normal', 'wide'], movement: ['static', 'push_in'] },
    gear: '三脚架、稳定的收音；需要安静的环境和有耐心的演员。',
    low_budget: '手机加三脚架就能完成；功夫在选景：找有线条、有层次的空间；每条多留几秒余量。',
  }),
  card({
    id: 'style.center-symmetry',
    name: '居中对称：正面构图与平移',
    summary: '人物居中、正面平视、横向平移，画面像精心布置的舞台，带一点幽默和距离感。',
    grammar: [
      '中心构图：主体放在画面正中，环境左右对称。',
      '正面与正侧面：机位多为正对人物或正侧面，很少斜角。',
      '平移与急摇：镜头沿水平方向平移，或用 90 度的急摇从一个人转到另一个人。',
      '以平视为主，偶尔用顶拍展示桌面和物件。',
      '色彩统一：服装、道具、背景色事先设计好。',
      '对话用正反打，两人各自居中，直视或接近直视镜头。',
    ].join('\n'),
    bias: { shot_size: ['FS', 'MS', 'WS'], angle: ['eye', 'overhead'], lens: ['wide', 'normal'], movement: ['static', 'track', 'pan'] },
    gear: '三脚架和水平仪、滑轨或平稳的推车；需要美术和布景配合对称。',
    low_budget: '手机加水平仪找正；平移用椅子、滑板或推车代替滑轨；对称靠选景，走廊、门、楼梯最容易。',
  }),
  card({
    id: 'style.thriller-press',
    name: '惊悚压迫：低角度、倾斜与慢推',
    summary: '低角度、倾斜构图、缓慢推近和大面积阴影，让观众始终觉得不安全。',
    grammar: [
      '力量关系：仰拍威胁者，俯拍受害者。',
      '倾斜构图只用在心理失衡的时刻，不要滥用。',
      '缓慢推近：人物沉默或意识到危险时，镜头几乎察觉不到地推近。',
      '阴影与遮挡：人物一半在暗处，前景用门缝、栏杆遮挡，制造"有人在看"的感觉。',
      '延迟揭示：先拍反应，再拍引起反应的东西；关键信息放在画面边缘或背景里。',
      '偶尔用来源不明的主观镜头跟着人物。',
    ].join('\n'),
    bias: { shot_size: ['CU', 'ECU', 'MCU'], angle: ['low', 'high', 'dutch'], lens: ['wide', 'tele'], movement: ['push_in', 'static', 'handheld'] },
    gear: '能控制明暗的灯（或足够暗的场地）、做慢推的三脚架或稳定器；夜间拍摄注意安全。',
    low_budget: '手机沿桌面慢慢滑动做推近；手电筒或台灯做单一硬光；用门缝、楼梯扶手做前景遮挡。',
  }),
  card({
    id: 'style.youth-bright',
    name: '青春明快：自然光与跳切',
    summary: '自然光、手持、跳切和明亮的色彩，节奏轻快，镜头跟着人物的情绪跳动。',
    grammar: [
      '自然光与逆光：阳光下拍，逆光勾出头发边缘，画面明亮干净。',
      '手持跟拍：跟着人物跑、转身、骑车，镜头有活力。',
      '跳切与蒙太奇：同一个动作在不同地点重复、快速拼接，表现时间流逝或情绪高涨。',
      '近景和特写抓笑容、眼神和小动作。',
      '偶尔用升降或高处俯拍展示人群和操场。',
      '剪辑点跟着音乐的节拍走。',
    ].join('\n'),
    bias: { shot_size: ['MCU', 'CU', 'WS'], angle: ['eye', 'high'], lens: ['normal', 'wide'], movement: ['handheld', 'track', 'crane'] },
    gear: '稳定器或手持、晴天的拍摄日程；骑车或滑板跟拍要注意安全。',
    low_budget: '选晴天下午拍，手机手持即可；蒙太奇素材多拍几条不同地点的同一动作；升降用楼梯或看台代替。',
  }),
];

export function findBuiltinStyle(id: string): StyleCard | null {
  return BUILTIN_STYLES.find((s) => s.id === id) ?? null;
}

export const LEVEL_LABEL: Record<StyleLevel, string> = { steady: '稳妥', bold: '进取', extreme: '挑战' };

export const LEVEL_HINT: Record<StyleLevel, string> = {
  steady: '手机、稳定器、三脚架就能拍。',
  bold: '允许长镜头调度、复杂走位、滑轨和摇臂，有难度的镜头会写清器材和走位。',
  extreme: '按摄影能力强、愿意冒险来设计：车拍、航拍、环绕、一镜到底都可以，每个高难镜头附低成本替代。',
};
