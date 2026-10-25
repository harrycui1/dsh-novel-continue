# dsh-novel-continue

DeepSeek Harness（DSH）网文续写插件。把约 1 万字的网文续写到约 3 万字：编辑在 DSH 里和「续写指挥」对话，指挥调度读原文、规划、写作、审稿、改稿、更新备忘这几个节点，每个节点用写死的模型和提示词，结果可复现。

## 工作方式

```
编辑 ⇄ 续写指挥（主 Agent，只调度不写正文）
          │ 调用 novel_* 工具
          ▼
   ┌──────────────────────────────────────────────┐
   │ 工具内部：代码组装上下文 → 起子 Agent → 结果落盘 │
   └──────────────────────────────────────────────┘
     读原文 → 规划 → ⏸ 编辑确认 → 逐章[写作 → 检查 → 审稿 → 改稿(≤2次) → 更新备忘]
```

- **指挥只调度**：决定先做什么、要不要返工、什么时候停下来问编辑；改不了节点的模型和提示词。
- **节点写死**：每个节点的模型、推理强度、输出上限在插件配置里，提示词在 `prompts/`。
- **最小上下文**：写作节点只拿到「续写备忘 + 本章剧情点 + 最近 3 章全文」，看不到整份规划，防止提前写后面的剧情。
- **新人物、新地点只能由规划节点提出**，写作节点不许自创。
- **两种模式**：默认对话模式，规划完一定停下等编辑确认；编辑说「一口气跑完」就连续跑到底，只在卡住时问人。

## 环境要求

- DSH **0.2.1-rc.2** 的 web 或桌面端（已实测 web）。DSH 还在预览期，接口可能变，换版本前先在测试机验证。
- 只能在 **web / 桌面端** 用：插件靠 DSH 的「预设」机制，headless 一次性模式和 SDK profile 不组装预设。
- 用 CLI 启动时需要 Node ≥ 22.19（DSH 入口依赖 `import.meta.main`）。
- 默认模型是 DeepSeek 官方的 `deepseek-v4-pro` 与 `deepseek-flash`，需要在 DSH「设置 → 模型」里配好 DeepSeek 密钥，或启动前设置环境变量 `DEEPSEEK_API_KEY`。

## 安装

安装包是 `dsh-novel-continue-<版本>.tgz`。装完都要**重启 DSH**，然后在输入框上方的预设选择器里能看到「续写指挥」（插件会把它设为默认）。

### 方式一：DSH CLI（需要 pnpm 10 或以上）

```sh
dsh plugin --profile web add ./dsh-novel-continue-0.1.0.tgz
```

### 方式二：没有 pnpm

先把安装包解开，用里面的脚本装：

```sh
tar xzf dsh-novel-continue-0.1.0.tgz
sh package/scripts/install-local.sh ./dsh-novel-continue-0.1.0.tgz
```

脚本默认装到 `~/.dsh/profiles/web`。要装到别的 profile，把目录作为第二个参数传进去，比如桌面版是 `~/.dsh/profiles/desktop`。脚本可以重复执行，第一次会把 profile 的 `package.json` 备份成 `package.json.bak-novel`。

### 方式三：桌面版界面

打开「设置 → 插件」，在安装输入框里粘贴安装包的下载地址。**这条路尚未实测**，装不上就用方式二，profile 选桌面版的目录。

### 卸载

- CLI：`dsh plugin --profile web remove dsh-novel-continue`
- 用脚本装的：把 profile 的 `package.json` 换回 `package.json.bak-novel`，再删掉 `node_modules/dsh-novel-continue`。

## 使用

### 1. 准备书目录

一本书一个文件夹，放入：

| 文件 | 说明 |
|---|---|
| `原文.txt` | 必需。章节标题要写成「第 N 章」，各平台导出的常见格式都可以（行首缩进、段间空行都没关系） |
| `续写方向.md` | 可选。编辑写的续写方向；不写的话就在对话里告诉指挥 |
| `prompts/<节点>.md` | 可选。只对这本书生效的提示词，见下文「自定义提示词」 |

### 2. 打开并对话

**书目录就是会话的工作区。** 插件读写的是当前会话工作区里的文件，与 DSH 进程是在哪个目录启动的无关。所以要先在左侧「Workspaces」里把书目录添加为工作区，再在这个工作区里新建会话。DSH 第一次启动时会建一个 Default workspace（`~/Documents/deepseek-harness/default-workspace`），别在那里面写书。

预设选「续写指挥」（插件已把它设为默认），然后像对编辑助理一样说话，例如：

> 这本书保留原文前 8 章，从第 9 章开始续写，方向在 续写方向.md 里。先读原文生成备忘，然后规划剧情点给我看。

指挥规划完会列出各章章名和梗概，然后停下来。你可以直接回复修改意见，比如「第 22 章的铁盒和第 2 章重复了，改成木匣」，指挥会去改 `剧情点.md`；确认后它会逐章往下写。常用说法：

- 「先只写第 9 章给我看」：小批量试跑。
- 「一口气跑完」：切到连续模式。
- 「第 12 章太水了，后半段重写」：指挥会把你的原话交给改稿节点。

**分叉点**：「保留原文前 N 章」之后的原文会被丢掉、由续写替换。原文结尾已经收束的书（写了"全文完"），适合从最后 20% 左右分叉。

### 3. 产出

| 文件 | 内容 |
|---|---|
| `备忘.md` | 故事概要、人物（含当前处境）、伏笔、文风观察、已写章节摘要；每章定稿后自动更新 |
| `剧情点.md` | 逐章剧情点、钩子、新增元素；编辑可以直接改 |
| `正文/第NN章.md` | 每章一个文件，包括保留下来的原文章节 |
| `成稿.txt` | 全部写完后按原文格式合并 |
| `state/` | 进度、每次调用的模型与耗时（`calls.jsonl`）、审稿记录、改稿前的旧稿 |

## 节点与工具

| 指挥可调的工具 | 节点 | 默认模型 | 做什么 |
|---|---|---|---|
| `novel_status` | 无（纯代码） | — | 查进度和下一步 |
| `novel_analyze` | 读原文 | deepseek-v4-pro | 按分叉点拆出原文章节，生成 `备忘.md` |
| `novel_plan` | 规划 | deepseek-v4-pro | 逐章 5~10 个剧情点、钩子和新增元素 |
| `novel_write_chapter` | 写作 | deepseek-v4-pro | 写一章，并用代码检查字数和与上一章的重复度 |
| `novel_review_chapter` | 审稿 | deepseek-flash | 只查越界跑偏、重复、人物与设定、AI 味四项，给出 pass 或 revise 和具体改法 |
| `novel_revise_chapter` | 改稿 | deepseek-v4-pro | 按审稿意见或编辑要求改，旧稿留档 |
| `novel_update_memo` | 更新备忘 | deepseek-flash | 写入本章摘要，更新人物处境与伏笔 |
| `novel_export` | 无（纯代码） | — | 合并成 `成稿.txt` |

每个节点在主模型失败或输出为空时，会自动换到备用模型（`fallbackModel`）。

## 配置

模型和检查阈值都在包里的 `cordis.patch.yml` 中，`novel-continue` 这一行的 `config`：

```yaml
chapterChars: 1000      # 每章目标字数
recentChapters: 3       # 写作节点能看到的前文章数
minCharsRatio: 0.7      # 字数下限 = 目标 × 0.7
maxCharsRatio: 1.4      # 字数上限 = 目标 × 1.4
maxRepeatRatio: 0.15    # 与上一章的重合率上限
stages:
  write: { model: deepseek-v4-pro, fallbackModel: deepseek-flash, reasoningEffort: high, maxTokens: 16000 }
  # analyze / plan / review / revise / memo 同理
```

- 要换成其他模型供应商：先在 DSH「设置 → 模型」里添加该供应商，再把 `provider` 改成它的 Provider ID（比如 `anthropic`），把各节点的 `model` 改成对应的模型 ID。
- 设计上模型由维护者统一控制，所以改配置的流程是：改 `cordis.patch.yml` → 重新打包 → 重新分发。不要让每个编辑各改各的。

## 自定义提示词

包里的 `prompts/` 是默认提示词。书目录下放同名文件（`prompts/write.md` 等），就只覆盖这本书。

| 文件 | 节点 | 可用占位符 |
|---|---|---|
| `analyze.md` | 读原文 | `{{原文}}` `{{章节字数}}` |
| `plan.md` | 规划 | `{{备忘}}` `{{最近章节}}` `{{续写方向}}` `{{起始章}}` `{{章数}}` `{{每章字数}}` |
| `write.md` | 写作 | `{{文风约束}}` `{{备忘}}` `{{最近章节}}` `{{本章剧情点}}` `{{下一章开头}}` `{{章号}}` `{{字数}}` |
| `review.md` | 审稿 | `{{备忘}}` `{{上一章}}` `{{本章剧情点}}` `{{本章正文}}` `{{检查结果}}` |
| `revise.md` | 改稿 | `{{文风约束}}` `{{备忘}}` `{{上一章}}` `{{本章剧情点}}` `{{本章正文}}` `{{修改要求}}` `{{字数}}` |
| `memo.md` | 更新备忘 | `{{人物}}` `{{伏笔}}` `{{章号}}` `{{本章正文}}` |
| `style.md` | 文风约束 | 被写作和改稿节点引用，包括禁用的 AI 套话词表 |

`plan.md` 的输出格式（`## 第NN章 章名`、`- 剧情点`、`钩子：`、`新增：`）会被代码解析，改提示词时这个格式不能动。`analyze.md` 的二级标题（`## 人物`、`## 伏笔与未解决的线`、`## 已写章节摘要`）也会被更新备忘的代码按名字查找，同样不能改名。

## 成本参考

DeepSeek 官方价格下的实测（2026-10，约 1 万字原文，每章约 1000 字）：读原文加规划 22 章约 ¥0.15；每章完整走一轮（写、审、改一次、复审、更新备忘，再加指挥自身的对话）约 ¥0.15。一本书从 1 万字续到 3 万字约 ¥3~4。

## 已知限制

- 只支持 web 和桌面端。批量无人值守还没做，headless 模式不组装预设。
- 同一时间一本书只能开一个会话在写，多个会话同时写同一个书目录会互相覆盖。
- `dsh plugin add` 需要 pnpm 10 或以上（DSH 的 profile 用了 pnpm 10 的工作区设置），pnpm 9 会报 `ERR_PNPM_ADDING_TO_ROOT`。
- 字数、重复度这些代码检查只是兜底，文风和剧情质量仍然需要编辑读稿把关。

## 开发

```sh
npm run build   # esbuild 把 src/novel.ts 编到 dist/novel.js
npm test        # 纯函数测试（切章、剧情点解析、重复度、备忘读写）
npm pack        # 打包前会自动 build 和 test，产出 dsh-novel-continue-<版本>.tgz
```

## 来源与许可

预设结构（纯净工具面隔离、去工程化的人设写法）参考了 [chuanban-dsh-writingset](https://github.com/Anarcadia/chuanban-dsh-writingset)（MIT © 船板）。续写节点的约束条款参考了 NovelForge 的提示词，续写思路参考了灵犀速写的「AI 续写」。

MIT License，见 `LICENSE`。
