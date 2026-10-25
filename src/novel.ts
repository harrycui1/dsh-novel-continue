/**
 * 续写节点工具集（novel-continue）
 *
 * 给「续写指挥」预设注册 novel_* 工具。每个工具内部：
 * 1. 用代码从书的工作区组装上下文（不让模型自己挑上下文）；
 * 2. 经 ctx.subagents 起一个子 Agent（独立的 novel-node 预设、该节点写死的模型）；
 * 3. 把结果落盘到工作区，返回简短摘要给指挥。
 *
 * 指挥只能决定调哪个工具、传哪些参数，不能改模型与提示词。
 * 工作区约定见项目根 AGENTS.md。
 */

import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'novel-continue';
export const inject = ['tools', 'fs', 'subagents'];

type Stage = 'analyze' | 'plan' | 'write' | 'review' | 'revise' | 'memo';

interface StageConfig {
  model: string;
  fallbackModel?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface NovelConfig {
  provider?: string;
  subagentProvider?: string;
  nodePreset?: string;
  promptsDir?: string;
  chapterChars?: number;
  recentChapters?: number;
  minCharsRatio?: number;
  maxCharsRatio?: number;
  maxRepeatRatio?: number;
  stages?: Partial<Record<Stage, Partial<StageConfig>>>;
}

const DEFAULT_STAGES: Record<Stage, StageConfig> = {
  analyze: { model: 'deepseek-v4-pro', fallbackModel: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 16000 },
  plan: { model: 'deepseek-v4-pro', fallbackModel: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 24000 },
  write: { model: 'deepseek-v4-pro', fallbackModel: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 16000 },
  review: { model: 'deepseek-flash', fallbackModel: 'deepseek-v4-pro', reasoningEffort: 'low', maxTokens: 8000 },
  revise: { model: 'deepseek-v4-pro', fallbackModel: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 16000 },
  memo: { model: 'deepseek-flash', fallbackModel: 'deepseek-v4-pro', reasoningEffort: 'low', maxTokens: 8000 },
};

const PLUGIN_PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

// ---------------------------------------------------------------------------
// 纯文本工具函数（无副作用，供测试直接调用）
// ---------------------------------------------------------------------------

export const pad = (n: number): string => String(n).padStart(2, '0');

/** 去空白后的字符数（中文网文惯用口径）。 */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 按「第 N 章」切分原文，返回 { number, body }[]。 */
export function splitChapters(raw: string): Array<{ number: number; body: string }> {
  const re = /^\s*第\s*(\d+)\s*章[^\n]*$/gm;
  const marks = [...raw.matchAll(re)];
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    return { number: Number(m[1]), body: normalizeProse(raw.slice(start, end)) };
  });
}

/** 统一成「段落之间空一行、行首无缩进」，并去掉"全文完"之类的收尾标记。 */
export function normalizeProse(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[（(]?全文完[)）]?$/.test(l))
    .join('\n\n')
    .trim();
}

export interface PlannedChapter {
  number: number;
  title: string;
  beats: string[];
  hook: string;
  additions: string;
}

/** 解析 剧情点.md（格式见 prompts/plan.md 的输出格式）。 */
export function parsePlan(md: string): PlannedChapter[] {
  const blocks = md.split(/^##\s+/m).slice(1);
  const out: PlannedChapter[] = [];
  for (const block of blocks) {
    const [head, ...lines] = block.split('\n');
    const m = head.match(/第\s*(\d+)\s*章\s*(.*)$/);
    if (!m) continue;
    const beats: string[] = [];
    let hook = '';
    let additions = '';
    for (const line of lines) {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) beats.push(t.replace(/^[-*]\s+/, ''));
      else if (/^钩子[:：]/.test(t)) hook = t.replace(/^钩子[:：]\s*/, '');
      else if (/^新增[:：]/.test(t)) additions = t.replace(/^新增[:：]\s*/, '');
    }
    out.push({ number: Number(m[1]), title: m[2].trim(), beats, hook, additions });
  }
  return out.sort((a, b) => a.number - b.number);
}

export function renderPlanned(c: PlannedChapter): string {
  return [
    `## 第${pad(c.number)}章 ${c.title}`.trimEnd(),
    ...c.beats.map((b) => `- ${b}`),
    `钩子：${c.hook || '无'}`,
    `新增：${c.additions || '无'}`,
  ].join('\n');
}

/** 用新规划替换同章号的旧规划，其余保留。 */
export function mergePlans(existing: PlannedChapter[], incoming: PlannedChapter[]): PlannedChapter[] {
  const map = new Map(existing.map((c) => [c.number, c]));
  for (const c of incoming) map.set(c.number, c);
  return [...map.values()].sort((a, b) => a.number - b.number);
}

/** 本章与参照文本的 n-gram 重合比例（0~1），用于发现复述上一章。 */
export function repeatRatio(text: string, reference: string, n = 8): number {
  const a = text.replace(/\s/g, '');
  const b = reference.replace(/\s/g, '');
  if (a.length < n || b.length < n) return 0;
  const ref = new Set<string>();
  for (let i = 0; i + n <= b.length; i++) ref.add(b.slice(i, i + n));
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= a.length; i++) {
    total++;
    if (ref.has(a.slice(i, i + n))) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

/** 读写备忘里的二级标题小节。 */
export function getSection(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = md.match(re);
  if (!m || m.index === undefined) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function setSection(md: string, heading: string, body: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = md.match(re);
  const block = `## ${heading}\n${body.trim()}\n`;
  if (!m || m.index === undefined) return `${md.trimEnd()}\n\n${block}`;
  const head = md.slice(0, m.index);
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  const tail = next === -1 ? '' : rest.slice(next);
  return `${head}${block}${tail ? `\n${tail}` : ''}`;
}

/** 在「已写章节摘要」里写入或替换某一章的那一行。 */
export function upsertSummary(md: string, chapter: number, summary: string): string {
  const body = getSection(md, '已写章节摘要');
  const line = `第${pad(chapter)}章：${summary.replace(/\s+/g, ' ').trim()}`;
  const lines = body.split('\n').filter((l) => l.trim() && !l.trim().replace(/^[-*]\s*/, '').startsWith(`第${pad(chapter)}章`));
  lines.push(line);
  lines.sort((a, b) => Number(a.match(/第(\d+)章/)?.[1] ?? 0) - Number(b.match(/第(\d+)章/)?.[1] ?? 0));
  return setSection(md, '已写章节摘要', lines.join('\n'));
}

export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (all, key: string) => {
    const v = vars[key.trim()];
    return v === undefined ? all : String(v);
  });
}

// ---------------------------------------------------------------------------
// 结构化输出 schema
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string', enum: ['越界跑偏', '重复', '人物与设定', 'AI味', '字数'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['item', 'problem', 'fix'],
      },
    },
  },
  required: ['verdict', 'issues'],
};

const MEMO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    characters: { type: 'string' },
    threads: { type: 'string' },
  },
  required: ['summary', 'characters', 'threads'],
};

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

interface Review {
  verdict: 'pass' | 'revise';
  issues: Array<{ item: string; problem: string; fix: string }>;
}

interface BookState {
  keepChapters: number;
  originalChapters: number;
}

const textTool = () => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { report: { type: 'string' } },
    required: ['report'],
  },
  render: (_args: unknown, v: { report: string }) => [{ type: 'text', text: v.report }],
});

export function apply(ctx: any, config: NovelConfig = {}) {
  const cfg = {
    provider: config.provider ?? 'deepseek-official',
    subagentProvider: config.subagentProvider ?? 'spawn',
    nodePreset: config.nodePreset ?? 'novel-node',
    promptsDir: config.promptsDir ?? PLUGIN_PROMPTS_DIR,
    chapterChars: config.chapterChars ?? 1000,
    recentChapters: config.recentChapters ?? 3,
    minCharsRatio: config.minCharsRatio ?? 0.7,
    maxCharsRatio: config.maxCharsRatio ?? 1.4,
    maxRepeatRatio: config.maxRepeatRatio ?? 0.15,
  };
  const stages: Record<Stage, StageConfig> = { ...DEFAULT_STAGES };
  for (const [k, v] of Object.entries(config.stages ?? {})) {
    stages[k as Stage] = { ...stages[k as Stage], ...v } as StageConfig;
  }

  // ---- 工作区 ----

  async function bookDir(): Promise<string> {
    const target = await ctx.fs.resolve('.');
    return ctx.fs.processPath(target);
  }

  const paths = (dir: string) => ({
    original: join(dir, '原文.txt'),
    memo: join(dir, '备忘.md'),
    plan: join(dir, '剧情点.md'),
    direction: join(dir, '续写方向.md'),
    prose: join(dir, '正文'),
    chapter: (n: number) => join(dir, '正文', `第${pad(n)}章.md`),
    state: join(dir, 'state'),
    book: join(dir, 'state', 'book.json'),
    review: (n: number) => join(dir, 'state', 'reviews', `${pad(n)}.json`),
    reviewHistory: (n: number) => join(dir, 'state', 'reviews', `${pad(n)}-${Date.now()}.json`),
    check: (n: number) => join(dir, 'state', 'checks', `${pad(n)}.json`),
    drafts: join(dir, 'state', 'drafts'),
    calls: join(dir, 'state', 'calls.jsonl'),
    exported: join(dir, '成稿.txt'),
  });

  async function readText(file: string): Promise<string> {
    return existsSync(file) ? readFile(file, 'utf8') : '';
  }

  async function writeText(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }

  async function readJson<T>(file: string): Promise<T | undefined> {
    return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as T : undefined;
  }

  async function writtenChapters(dir: string): Promise<number[]> {
    const p = paths(dir);
    if (!existsSync(p.prose)) return [];
    return (await readdir(p.prose))
      .map((f) => f.match(/^第(\d+)章\.md$/)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** 提示词：书目录下 prompts/<name>.md 优先，否则用插件自带。 */
  async function prompt(dir: string, nodeName: string): Promise<string> {
    const local = join(dir, 'prompts', `${nodeName}.md`);
    return readFile(existsSync(local) ? local : join(cfg.promptsDir, `${nodeName}.md`), 'utf8');
  }

  async function recentChaptersText(dir: string, before: number, count: number): Promise<string> {
    const nums = (await writtenChapters(dir)).filter((n) => n < before).slice(-count);
    const parts: string[] = [];
    for (const n of nums) parts.push(`### 第${pad(n)}章\n${(await readText(paths(dir).chapter(n))).trim()}`);
    return parts.join('\n\n') || '（无）';
  }

  async function requirePlanned(dir: string, chapter: number): Promise<{ plan: PlannedChapter[]; current: PlannedChapter }> {
    const plan = parsePlan(await readText(paths(dir).plan));
    const current = plan.find((c) => c.number === chapter);
    if (!current) throw new Error(`剧情点.md 里没有第${pad(chapter)}章，先调 novel_plan 规划。`);
    return { plan, current };
  }

  // ---- 节点执行 ----

  async function runNode(
    exec: any,
    stage: Stage,
    label: string,
    text: string,
    schema?: object,
  ): Promise<{ text: string; structured?: any; model: string }> {
    if (!exec?.agent) throw new Error('novel 工具需要由 Agent 调用（exec.agent 缺失）');
    const s = stages[stage];
    const dir = await bookDir();
    const models = [s.model, s.fallbackModel].filter((m): m is string => !!m);
    const failures: string[] = [];
    for (const model of models) {
      const started = Date.now();
      const activation = await ctx.subagents.startActivation({
        provider: cfg.subagentProvider,
        label,
        delivery: 'caller',
        signal: exec.signal,
        request: {
          prompt: [{ type: 'text', text }],
          parent: exec.agent,
          agentPreset: cfg.nodePreset,
          agentOptions: {
            provider: cfg.provider,
            model,
            ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}),
            ...(s.maxTokens ? { maxTokens: s.maxTokens } : {}),
          },
          ...(schema ? { outputSchema: schema } : {}),
        },
      });
      let result: any;
      try {
        result = await activation.result;
      } finally {
        await activation.dispose().catch(() => {});
      }
      const out = (result.output ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .trim();
      const ok = result.stopReason === 'completed' && (schema ? result.structured !== undefined : out.length > 0);
      await mkdir(paths(dir).state, { recursive: true });
      await appendFile(paths(dir).calls, `${JSON.stringify({
        at: new Date().toISOString(),
        stage,
        label,
        model,
        stopReason: result.stopReason,
        ok,
        outChars: countChars(out),
        ms: Date.now() - started,
        childId: activation.childId,
        diagnostic: result.diagnostic,
      })}\n`, 'utf8');
      if (ok) return { text: out, structured: result.structured, model };
      failures.push(`${model}: ${result.stopReason}${result.diagnostic ? ` (${result.diagnostic})` : ''}${out ? '' : ' 空输出'}`);
    }
    throw new Error(`节点 ${stage} 全部模型失败：${failures.join('；')}`);
  }

  async function checkChapter(dir: string, chapter: number): Promise<{ chars: number; repeat: number; problems: string[] }> {
    const body = await readText(paths(dir).chapter(chapter));
    const prev = (await writtenChapters(dir)).filter((n) => n < chapter).pop();
    const prevBody = prev === undefined ? '' : await readText(paths(dir).chapter(prev));
    const chars = countChars(body);
    const repeat = Number(repeatRatio(body, prevBody).toFixed(3));
    const problems: string[] = [];
    if (chars < cfg.chapterChars * cfg.minCharsRatio) problems.push(`字数不足：${chars} 字，目标约 ${cfg.chapterChars} 字`);
    if (chars > cfg.chapterChars * cfg.maxCharsRatio) problems.push(`字数超出：${chars} 字，目标约 ${cfg.chapterChars} 字`);
    if (repeat > cfg.maxRepeatRatio) problems.push(`与上一章重复度 ${(repeat * 100).toFixed(1)}%，超过 ${(cfg.maxRepeatRatio * 100).toFixed(0)}%`);
    const result = { chars, repeat, problems };
    await writeText(paths(dir).check(chapter), JSON.stringify(result, null, 2));
    return result;
  }

  const describeCheck = (c: { chars: number; repeat: number; problems: string[] }) =>
    `${c.chars} 字，与上一章重复度 ${(c.repeat * 100).toFixed(1)}%${c.problems.length ? `；代码检查未通过：${c.problems.join('；')}` : '；代码检查通过'}`;

  // ---- 工具 ----

  ctx.tools.register({
    name: 'novel_status',
    description: '查看当前书的续写进度：分叉点、备忘与剧情点是否就绪、已写章节字数、每章审稿状态、下一步该写哪章。开工和不确定进度时先调它。',
    parameters: { type: 'object', properties: {} },
    output: textTool(),
    async execute() {
      const dir = await bookDir();
      const p = paths(dir);
      const book = await readJson<BookState>(p.book);
      const plan = parsePlan(await readText(p.plan));
      const written = await writtenChapters(dir);
      const lines: string[] = [`书目录：${dir}`];
      lines.push(existsSync(p.original) ? '原文.txt：有' : '原文.txt：缺失（需要编辑放入）');
      lines.push(book ? `分叉点：保留原文前 ${book.keepChapters} 章（原文共 ${book.originalChapters} 章）` : '尚未分析原文（novel_analyze）');
      lines.push(existsSync(p.memo) ? '备忘.md：有' : '备忘.md：无');
      lines.push(existsSync(p.direction) ? '续写方向.md：有' : '续写方向.md：无');
      lines.push(plan.length ? `剧情点：第${pad(plan[0].number)}~${pad(plan[plan.length - 1].number)}章，共 ${plan.length} 章` : '剧情点：无');
      let total = 0;
      for (const n of written) {
        const chars = countChars(await readText(p.chapter(n)));
        total += chars;
        const isOriginal = book && n <= book.keepChapters;
        const review = await readJson<Review>(p.review(n));
        const memoDone = getSection(await readText(p.memo), '已写章节摘要').includes(`第${pad(n)}章`);
        lines.push(`- 第${pad(n)}章 ${chars} 字${isOriginal ? '（原文）' : `｜审稿：${review ? review.verdict : '未审'}｜备忘：${memoDone ? '已更新' : '未更新'}`}`);
      }
      lines.push(`正文合计：${total} 字`);
      const next = plan.find((c) => !written.includes(c.number));
      lines.push(next ? `下一章待写：第${pad(next.number)}章 ${next.title}` : plan.length ? '规划内章节已全部写完' : '');
      return { report: lines.filter(Boolean).join('\n') };
    },
  });

  ctx.tools.register({
    name: 'novel_analyze',
    description: '读原文并生成续写备忘（人物、伏笔、文风观察、章节摘要）。keep_chapters 是分叉点：只保留原文前 N 章，其后的原文丢弃、由续写替换。会把保留的原文章节拆到 正文/ 目录。',
    parameters: {
      type: 'object',
      properties: {
        keep_chapters: { type: 'integer', description: '保留原文前多少章；不填则保留全部。' },
      },
    },
    output: textTool(),
    async execute(args: { keep_chapters?: number }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const raw = await readText(p.original);
      if (!raw) throw new Error('书目录下没有 原文.txt');
      const chapters = splitChapters(raw);
      if (chapters.length === 0) throw new Error('原文.txt 里没找到「第 N 章」标题');
      const keep = Math.min(args.keep_chapters ?? chapters.length, chapters.length);
      const kept = chapters.filter((c) => c.number <= keep);
      for (const c of kept) await writeText(p.chapter(c.number), c.body);
      await writeText(p.book, JSON.stringify({ keepChapters: keep, originalChapters: chapters.length }, null, 2));
      const original = kept.map((c) => `### 第${pad(c.number)}章\n${c.body}`).join('\n\n');
      const lengths = kept.map((c) => countChars(c.body));
      const stats = `共 ${kept.length} 章，每章 ${Math.min(...lengths)}~${Math.max(...lengths)} 字，平均 ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)} 字（代码实测，去空白字符数）`;
      const res = await runNode(exec, 'analyze', '读原文', fillTemplate(await prompt(dir, 'analyze'), { 原文: original, 章节字数: stats }));
      await writeText(p.memo, res.text);
      return { report: `已保留原文第01~${pad(keep)}章（共 ${countChars(original)} 字）到 正文/，备忘.md 已生成（${res.model}）。` };
    },
  });

  ctx.tools.register({
    name: 'novel_plan',
    description: '规划续写章节的剧情点，写入 剧情点.md（同章号覆盖，其余保留）。direction 留空时读书目录下的 续写方向.md。规划完要把章名和梗概给编辑过目。',
    parameters: {
      type: 'object',
      properties: {
        chapters: { type: 'integer', description: '本次规划多少章。' },
        start_chapter: { type: 'integer', description: '从第几章开始；默认接已写的最后一章。' },
        direction: { type: 'string', description: '编辑给的续写方向；留空则读 续写方向.md。' },
      },
      required: ['chapters'],
    },
    output: textTool(),
    async execute(args: { chapters: number; start_chapter?: number; direction?: string }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const memo = await readText(p.memo);
      if (!memo) throw new Error('还没有 备忘.md，先调 novel_analyze。');
      const written = await writtenChapters(dir);
      const start = args.start_chapter ?? ((written[written.length - 1] ?? 0) + 1);
      const direction = args.direction?.trim() || (await readText(p.direction)).trim();
      if (!direction) throw new Error('没有续写方向：请向编辑要，或在书目录写 续写方向.md。');
      const text = fillTemplate(await prompt(dir, 'plan'), {
        备忘: memo,
        最近章节: await recentChaptersText(dir, start, 2),
        续写方向: direction,
        起始章: start,
        章数: args.chapters,
        每章字数: cfg.chapterChars,
      });
      const res = await runNode(exec, 'plan', `规划第${pad(start)}章起 ${args.chapters} 章`, text);
      const incoming = parsePlan(res.text);
      if (incoming.length === 0) throw new Error(`规划节点输出无法解析为章节：\n${res.text.slice(0, 500)}`);
      const merged = mergePlans(parsePlan(await readText(p.plan)), incoming);
      await writeText(p.plan, `# 剧情点\n\n${merged.map(renderPlanned).join('\n\n')}`);
      const outline = incoming.map((c) => `第${pad(c.number)}章 ${c.title}：${c.beats[0] ?? ''}…（${c.beats.length} 个剧情点）${c.additions && c.additions !== '无' ? `｜新增：${c.additions}` : ''}`);
      return { report: `剧情点.md 已写入 ${incoming.length} 章（${res.model}）：\n${outline.join('\n')}` };
    },
  });

  ctx.tools.register({
    name: 'novel_write_chapter',
    description: '写一章正文：只给写作节点 备忘 + 最近几章全文 + 本章剧情点，写入 正文/第NN章.md，并做字数与重复度检查。已存在的章节会先备份再覆盖。',
    parameters: {
      type: 'object',
      properties: { chapter: { type: 'integer', description: '章号' } },
      required: ['chapter'],
    },
    output: textTool(),
    async execute(args: { chapter: number }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const { plan, current } = await requirePlanned(dir, args.chapter);
      const next = plan.find((c) => c.number === args.chapter + 1);
      const text = fillTemplate(await prompt(dir, 'write'), {
        章号: args.chapter,
        文风约束: await prompt(dir, 'style'),
        备忘: await readText(p.memo),
        最近章节: await recentChaptersText(dir, args.chapter, cfg.recentChapters),
        本章剧情点: renderPlanned(current),
        下一章开头: next ? `${next.title}：${next.beats[0] ?? ''}` : '（无，本章为当前规划的最后一章）',
        字数: cfg.chapterChars,
      });
      const res = await runNode(exec, 'write', `写第${pad(args.chapter)}章`, text);
      if (existsSync(p.chapter(args.chapter))) {
        await mkdir(p.drafts, { recursive: true });
        await copyFile(p.chapter(args.chapter), join(p.drafts, `${pad(args.chapter)}-${Date.now()}.md`));
      }
      await writeText(p.chapter(args.chapter), normalizeProse(res.text));
      const check = await checkChapter(dir, args.chapter);
      return { report: `第${pad(args.chapter)}章已写入（${res.model}）：${describeCheck(check)}` };
    },
  });

  ctx.tools.register({
    name: 'novel_review_chapter',
    description: '审一章：查越界跑偏、重复、人物与设定、AI 味四项，结合代码检查结果给出 pass / revise 和具体修改点。',
    parameters: {
      type: 'object',
      properties: { chapter: { type: 'integer', description: '章号' } },
      required: ['chapter'],
    },
    output: textTool(),
    async execute(args: { chapter: number }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const { current } = await requirePlanned(dir, args.chapter);
      const body = await readText(p.chapter(args.chapter));
      if (!body) throw new Error(`第${pad(args.chapter)}章还没写。`);
      const check = await checkChapter(dir, args.chapter);
      const prev = (await writtenChapters(dir)).filter((n) => n < args.chapter).pop();
      const text = fillTemplate(await prompt(dir, 'review'), {
        备忘: await readText(p.memo),
        上一章: prev === undefined ? '（无）' : await readText(p.chapter(prev)),
        本章剧情点: renderPlanned(current),
        本章正文: body,
        检查结果: describeCheck(check),
      });
      const res = await runNode(exec, 'review', `审第${pad(args.chapter)}章`, text, REVIEW_SCHEMA);
      const review = res.structured as Review;
      if (check.problems.length && review.verdict === 'pass') {
        review.verdict = 'revise';
        for (const problem of check.problems) review.issues.push({ item: '字数', problem, fix: problem.startsWith('字数不足') ? '补足场景细节和心理，写满剧情点' : problem.startsWith('字数超出') ? '删去重复的心理描写和可有可无的过渡，压到目标字数' : '删去复述上一章的内容' });
      }
      await writeText(p.review(args.chapter), JSON.stringify(review, null, 2));
      await writeText(p.reviewHistory(args.chapter), JSON.stringify({ ...review, model: res.model, check }, null, 2));
      const issues = review.issues.map((i, k) => `${k + 1}. [${i.item}] ${i.problem} → ${i.fix}`);
      return { report: `第${pad(args.chapter)}章审稿：${review.verdict}（${res.model}）${issues.length ? `\n${issues.join('\n')}` : ''}` };
    },
  });

  ctx.tools.register({
    name: 'novel_revise_chapter',
    description: '按最近一次审稿意见和/或编辑的额外要求改一章，原稿备份到 state/drafts/。instructions 用于转达编辑的修改要求。',
    parameters: {
      type: 'object',
      properties: {
        chapter: { type: 'integer', description: '章号' },
        instructions: { type: 'string', description: '编辑的额外修改要求（可选）。' },
        use_review: { type: 'boolean', description: '是否带上最近一次审稿意见，默认 true。' },
      },
      required: ['chapter'],
    },
    output: textTool(),
    async execute(args: { chapter: number; instructions?: string; use_review?: boolean }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const { current } = await requirePlanned(dir, args.chapter);
      const body = await readText(p.chapter(args.chapter));
      if (!body) throw new Error(`第${pad(args.chapter)}章还没写。`);
      const requirements: string[] = [];
      if (args.instructions?.trim()) requirements.push(`编辑要求：${args.instructions.trim()}`);
      const review = args.use_review === false ? undefined : await readJson<Review>(p.review(args.chapter));
      if (review?.verdict === 'revise') review.issues.forEach((i) => requirements.push(`[${i.item}] ${i.problem} → ${i.fix}`));
      if (requirements.length === 0) throw new Error('没有修改要求：既没有 revise 审稿意见，也没有 instructions。');
      const prev = (await writtenChapters(dir)).filter((n) => n < args.chapter).pop();
      const text = fillTemplate(await prompt(dir, 'revise'), {
        文风约束: await prompt(dir, 'style'),
        备忘: await readText(p.memo),
        上一章: prev === undefined ? '（无）' : await readText(p.chapter(prev)),
        本章剧情点: renderPlanned(current),
        本章正文: body,
        修改要求: requirements.map((r, k) => `${k + 1}. ${r}`).join('\n'),
        字数: cfg.chapterChars,
      });
      const res = await runNode(exec, 'revise', `改第${pad(args.chapter)}章`, text);
      await mkdir(p.drafts, { recursive: true });
      await copyFile(p.chapter(args.chapter), join(p.drafts, `${pad(args.chapter)}-${Date.now()}.md`));
      await writeText(p.chapter(args.chapter), normalizeProse(res.text));
      const check = await checkChapter(dir, args.chapter);
      return { report: `第${pad(args.chapter)}章已按 ${requirements.length} 条要求改完（${res.model}）：${describeCheck(check)}。需要的话再审一次。` };
    },
  });

  ctx.tools.register({
    name: 'novel_update_memo',
    description: '一章定稿后更新备忘：写入本章摘要，更新人物当前处境与伏笔清单。每章定稿后都要调，后面的章节靠它保持连贯。',
    parameters: {
      type: 'object',
      properties: { chapter: { type: 'integer', description: '章号' } },
      required: ['chapter'],
    },
    output: textTool(),
    async execute(args: { chapter: number }, exec: any) {
      const dir = await bookDir();
      const p = paths(dir);
      const memo = await readText(p.memo);
      const body = await readText(p.chapter(args.chapter));
      if (!memo || !body) throw new Error('备忘或本章正文缺失。');
      const text = fillTemplate(await prompt(dir, 'memo'), {
        人物: getSection(memo, '人物'),
        伏笔: getSection(memo, '伏笔与未解决的线'),
        章号: args.chapter,
        本章正文: body,
      });
      const res = await runNode(exec, 'memo', `更新备忘·第${pad(args.chapter)}章`, text, MEMO_SCHEMA);
      const s = res.structured as { summary: string; characters: string; threads: string };
      const strip = (t: string, h: string) => t.replace(new RegExp(`^##\\s+${h}\\s*\\n`), '');
      let next = setSection(memo, '人物', strip(s.characters, '人物'));
      next = setSection(next, '伏笔与未解决的线', strip(s.threads, '伏笔与未解决的线'));
      next = upsertSummary(next, args.chapter, s.summary);
      await writeText(p.memo, next);
      return { report: `备忘已更新到第${pad(args.chapter)}章（${res.model}）：${s.summary}` };
    },
  });

  ctx.tools.register({
    name: 'novel_export',
    description: '把 正文/ 下所有章节按原文格式合并成 成稿.txt，返回总字数。',
    parameters: { type: 'object', properties: {} },
    output: textTool(),
    async execute() {
      const dir = await bookDir();
      const p = paths(dir);
      const nums = await writtenChapters(dir);
      const title = (await readText(p.original)).split('\n')[0]?.trim() || '成稿';
      const parts = [title, ''];
      let total = 0;
      for (const n of nums) {
        const body = (await readText(p.chapter(n))).trim();
        total += countChars(body);
        parts.push(`第 ${n} 章`, '', ...body.split(/\n\s*\n/).map((para) => `    ${para.trim()}\n`), '');
      }
      await writeText(p.exported, parts.join('\n'));
      return { report: `已导出 成稿.txt：${nums.length} 章，${total} 字。` };
    },
  });
}
