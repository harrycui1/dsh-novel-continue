// novel.ts 纯函数测试：node --test tests/novel.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  countChars, fillTemplate, getSection, mergePlans, normalizeProse, parsePlan,
  renderPlanned, repeatRatio, setSection, splitChapters, upsertSummary,
} from '../dist/novel.js';

const sample = new URL('../../books/全网群嘲明星/原文.txt', import.meta.url);

test('splitChapters 切出样本的 10 章，去掉缩进与"全文完"', () => {
  const chapters = splitChapters(readFileSync(sample, 'utf8'));
  assert.equal(chapters.length, 10);
  assert.deepEqual(chapters.map((c) => c.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(chapters[0].body.startsWith('上一秒，我还在公司厕所摸鱼，'));
  assert.ok(!chapters[9].body.includes('全文完'));
  assert.ok(chapters.every((c) => countChars(c.body) > 700));
});

test('normalizeProse 段落间空一行', () => {
  assert.equal(normalizeProse('    第一段\n\n\n    第二段\n'), '第一段\n\n第二段');
});

const PLAN = `# 剧情点

## 第09章 转机
- 医生说奶奶醒了
- 严寒取保候审
钩子：律师来电
新增：周律师（维权律师）

## 第10章 反咬
- 严寒反告非法入侵
钩子：警察敲门
新增：无
`;

test('parsePlan / renderPlanned 往返一致', () => {
  const plan = parsePlan(PLAN);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { number: 9, title: '转机', beats: ['医生说奶奶醒了', '严寒取保候审'], hook: '律师来电', additions: '周律师（维权律师）' });
  assert.deepEqual(parsePlan(plan.map(renderPlanned).join('\n\n')), plan);
});

test('mergePlans 同章号覆盖，其余保留', () => {
  const merged = mergePlans(parsePlan(PLAN), [{ number: 10, title: '新', beats: ['x'], hook: '', additions: '' }]);
  assert.deepEqual(merged.map((c) => c.title), ['转机', '新']);
});

test('repeatRatio 识别复述', () => {
  const prev = '我抓起车钥匙冲出家门，开车去往医院。脑子里回荡着医生电话里那句没说完的话。';
  assert.ok(repeatRatio(prev, prev) > 0.9);
  assert.ok(repeatRatio('完全不同的一段新内容，讲的是律师事务所里的谈话和证据整理。', prev) < 0.05);
});

test('备忘小节读写与章节摘要 upsert', () => {
  let md = '## 故事概要\nA\n\n## 人物\n### 许栀\n- 身份：演员\n\n## 已写章节摘要\n第01章：开局\n第02章：溯源\n';
  assert.equal(getSection(md, '人物'), '### 许栀\n- 身份：演员');
  md = setSection(md, '人物', '### 许栀\n- 身份：演员兼码农');
  assert.ok(md.includes('演员兼码农') && md.includes('## 故事概要\nA'));
  md = upsertSummary(md, 9, '奶奶醒了');
  md = upsertSummary(md, 2, '溯源到严寒');
  assert.deepEqual(getSection(md, '已写章节摘要').split('\n'), ['第01章：开局', '第02章：溯源到严寒', '第09章：奶奶醒了']);
});

test('fillTemplate 只替换已知变量', () => {
  assert.equal(fillTemplate('{{a}}-{{ b }}-{{c}}', { a: 1, b: 'x' }), '1-x-{{c}}');
});
