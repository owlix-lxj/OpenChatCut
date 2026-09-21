import { getPluginSkill } from './plugin-skills';
import type { SkillDefinition } from './skill-types';

interface CreativeSkillMetadata {
  id: string;
  slug: string;
  name: string;
  nameZh: string;
  summary: string;
  scenarios: string[];
}

export const CREATIVE_SKILL_METADATA: CreativeSkillMetadata[] = [
  {
    id: '11111111-1240-4000-8000-000000000015',
    slug: 'livestream-to-clips',
    name: 'Livestream to Clips',
    nameZh: '直播智能切片',
    summary: '把带货、游戏、访谈、教学、娱乐、体育、音乐或混合直播录屏剪成有证据、可发布的高光切片。',
    scenarios: [
      'livestream-to-clips',
      'live-highlights',
      'stream-clips',
      'gaming-highlights',
      'commerce-clips',
      '直播切片'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000004',
    slug: 'long-video-to-shorts',
    name: 'Long Video to Shorts',
    nameZh: '长视频转短视频',
    summary: '把一条长播客、访谈、课程或直播剪成适合社媒发布的短视频和高光。',
    scenarios: [
      'long-video-to-shorts',
      'reels',
      'tiktok',
      'shorts',
      'social-clips',
      'highlight-reel'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000012',
    slug: 'multi-clips-to-reels',
    name: 'Multi Clips to Reels',
    nameZh: '多素材剪 Reels',
    summary: '把产品、活动、旅行或游戏素材剪成适合社媒发布的 Reels。',
    scenarios: [
      'multi-clips-to-reels',
      'multi-clips-to-shorts',
      'raw-clips',
      'reels',
      'tiktok',
      'shorts'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000005',
    slug: 'ai-cinematic-short-film',
    name: 'AI Cinematic Short Film',
    nameZh: 'AI 电影感短片',
    summary: '规划并制作 AI 电影感短片，覆盖故事、镜头、提示词、连续性和最终检查。',
    scenarios: [
      'ai-film',
      'cinematic',
      'seedance',
      'story',
      'short-film',
      'video-generation'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000006',
    slug: 'product-ad-video-script',
    name: 'Product Ad Video Script',
    nameZh: '产品广告脚本',
    summary: '把产品或页面转成广告角度、开头钩子、分镜、字幕、CTA 和视觉方向。',
    scenarios: [
      'ad',
      'e-commerce',
      'landing-page',
      'marketing',
      'product',
      'script'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000011',
    slug: 'explainer-video',
    name: 'Explainer Video',
    nameZh: '解说视频制作',
    summary: '把主题、脚本、配音、产品逻辑或数据做成完整解说视频。',
    scenarios: [
      'concept',
      'course',
      'data',
      'education',
      'explainer',
      'explainer-video'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000008',
    slug: 'motion-graphic-placement',
    name: 'Motion Graphic Placement',
    nameZh: '动效点缀指南',
    summary: '在合适时机添加动效，强化表达且不遮挡内容。',
    scenarios: [
      'creator-video',
      'interview',
      'lecture',
      'motion-graphic-placement',
      'motion-graphics',
      'podcast'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000009',
    slug: 'storyboard-shot-breakdown',
    name: 'Storyboard Shot Breakdown',
    nameZh: '拉片分镜图',
    summary: '逐镜拆解镜头语言，并生成分镜参考图。',
    scenarios: [
      'cinematography',
      'director-logic',
      'film-analysis',
      'shot-analysis',
      'shot-breakdown',
      'storyboard'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000010',
    slug: 'video-thumbnail-generator',
    name: 'Video Thumbnail Generator',
    nameZh: '视频封面生成',
    summary: '基于视频内容和真实画面生成适合平台的封面图。',
    scenarios: [
      'bilibili-cover',
      'cover-image',
      'poster',
      'shorts-cover',
      'thumbnail',
      'video-cover'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000014',
    slug: 'news-rough-cut',
    name: 'News Rough Cut',
    nameZh: '新闻智能粗剪',
    summary: '把新闻素材粗剪为一条内容完整、逻辑清晰、节奏紧凑的新闻短视频，不加任何外部声音。',
    scenarios: [
      'news-rough-cut',
      'news-cut',
      '新闻剪辑',
      '粗剪新闻',
      'news footage',
      'rough-cut-news'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000016',
    slug: 'heygen-avatar',
    name: 'HeyGen Avatar',
    nameZh: '定制数字人形象',
    summary: '创建并管理用户自己的定制数字人形象，作为课程视频的专属主讲人。',
    scenarios: [
      'heygen-avatar',
      'custom-avatar',
      'digital-twin',
      'photo-avatar',
      '定制数字人',
      '数字人形象库'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000017',
    slug: 'heygen-video',
    name: 'HeyGen Course Video',
    nameZh: '数字人智能制课',
    summary: '用自定义数字人、可试听课程配音和分段讲稿生成课程视频，并导入本地素材池。',
    scenarios: [
      'heygen-video',
      'course-video',
      'avatar-video',
      'digital-human-course',
      '数字人制课',
      '智能制课'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000018',
    slug: 'heygen-translate',
    name: 'HeyGen Video Translation',
    nameZh: '数字人视频翻译',
    summary: '把已有视频翻译为多语言配音与口型同步版本，并分别导回本地素材池。',
    scenarios: [
      'heygen-translate',
      'video-translation',
      'video-localization',
      'lip-sync-translation',
      '视频翻译',
      '多语言课程'
    ]
  },
  {
    id: '11111111-1240-4000-8000-000000000013',
    slug: 'skill-creator',
    name: 'Skill Creator',
    nameZh: '技能创作器',
    summary: '把重复流程或想法做成可复用的自定义技能（SKILL.md），并安装到本机技能目录。',
    scenarios: [
      'create-skill',
      'skill-creator',
      'make-a-skill',
      'new-skill',
      'workflow-capture',
      '创建技能',
      '写技能',
      '把流程做成技能'
    ]
  }
];

export const CREATIVE_SKILLS: SkillDefinition[] = CREATIVE_SKILL_METADATA.flatMap((metadata) => {
  const file = getPluginSkill(metadata.slug);
  if (!file) {
    if (typeof import.meta.env !== 'undefined') {
      throw new Error(`Creative skill metadata references missing SKILL.md: ${metadata.slug}`);
    }
    return [];
  }
  return [{
    ...metadata,
    description: file.description,
    body: file.body,
    files: file.files,
    source: 'builtin',
  }];
});

let customSkills: SkillDefinition[] = [];

export function setCustomSkills(list: SkillDefinition[]): void {
  customSkills = list;
}

/** Built-in then custom skills shown in the Creative Mode picker. */
export function allCreativeSkills(): SkillDefinition[] {
  return [...CREATIVE_SKILLS, ...customSkills];
}

export const findSkill = (id: string | null | undefined): SkillDefinition | undefined =>
  id ? (CREATIVE_SKILLS.find((skill) => skill.id === id) ?? customSkills.find((skill) => skill.id === id)) : undefined;
