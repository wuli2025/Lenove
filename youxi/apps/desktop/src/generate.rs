//! 生成引擎：需求单 → 站点文件，**分阶段可见产出**（规划书第 01 节）。
//!
//! 这一节是整个方案的头号风险（R1）。核心判断原文照抄：
//! > 十分钟的沉默是灾难，十分钟的持续生长是表演。
//!
//! 所以引擎不是"调一次模型等它吐完整页"，而是拆成有序阶段，
//! **每一段都往盘上写、往屏幕上吐**：骨架 → 首屏 → 内容区 → 页脚 → 精修。
//! 用户看到的是网页在自己长大，而不是一根进度条。
//!
//! 两道闸内置在引擎里，不靠现场临时判断（规划书第 07 节）：
//! * 闸 1 token 预算：累计触顶 → 简化收尾
//! * 软截止：到点还没进精修 → 跳过精修直接出成品
//!
//! 降级原则同样照抄原文：**宁可简单但完整，不要精致但没做完。**

use crate::config::Config;
use crate::interview::Requirement;
use crate::llm::{extract_block, extract_json, Llm, Msg};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Skeleton,
    Hero,
    Content,
    Footer,
    Polish,
    Done,
}

impl Stage {
    pub fn label(self) -> &'static str {
        match self {
            Stage::Skeleton => "骨架先出来",
            Stage::Hero => "首屏正在长出来",
            Stage::Content => "内容区一屏一屏地填",
            Stage::Footer => "补页脚与出口",
            Stage::Polish => "配图与细节",
            Stage::Done => "做好了",
        }
    }
    /// 进度条百分比。和规划书的时间轴对齐，不是均分的——
    /// 内容区本来就是最长的一段。
    pub fn pct(self) -> u32 {
        match self {
            Stage::Skeleton => 20,
            Stage::Hero => 38,
            Stage::Content => 62,
            Stage::Footer => 74,
            Stage::Polish => 92,
            Stage::Done => 100,
        }
    }
}

/// 一次生成过程中推给前端的进度事件
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: Stage,
    pub label: String,
    pub pct: u32,
    pub elapsed_ms: u64,
    pub tokens: u64,
    /// 附注：降级原因之类，没有就空
    pub note: String,
    /// 让预览窗刷新
    pub reload: bool,
}

/// 调色板。骨架阶段一次定死，后面各段共用，
/// 免得每段各自发挥导致整站配色打架。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Palette {
    pub bg: String,
    pub surface: String,
    pub text: String,
    pub muted: String,
    pub accent: String,
}

impl Default for Palette {
    fn default() -> Self {
        Self {
            bg: "#0d1117".into(),
            surface: "#161b22".into(),
            text: "#e6edf3".into(),
            muted: "#8b949e".into(),
            accent: "#58a6ff".into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct SectionPlan {
    pub id: String,
    pub heading: String,
    /// 这一栏打算放什么，给内容阶段当输入
    pub intent: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct Skeleton {
    title: String,
    tagline: String,
    palette: Palette,
    sections: Vec<SectionPlan>,
}

/// 站点草稿。每个阶段只改自己那一块，渲染时整体拼装——
/// 这样任何一段失败都不会把已经长出来的部分弄丢。
#[derive(Debug, Clone, Default)]
pub struct SiteDraft {
    pub title: String,
    pub tagline: String,
    pub palette: Palette,
    pub sections: Vec<SectionPlan>,
    pub hero_html: String,
    pub sections_html: String,
    pub footer_html: String,
    pub extra_css: String,
    pub hall_url: String,
}

/// 生成结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub site_dir: String,
    pub title: String,
    pub tagline: String,
    pub elapsed_ms: u64,
    pub tokens: u64,
    /// 是否走了降级分支
    pub degraded: bool,
    pub degrade_reason: String,
}

const NO_EXTERNAL: &str = "\
硬性约束（违反即作废）：
- 产物必须完全自包含：禁止任何外链资源，不许出现 <script src>、<link rel=stylesheet href>、
  外部字体、外部图片 URL。配图只能用内联 SVG 或 CSS 渐变。
- 禁止写入任何 API key、token、密钥。
- 只输出要求的那一段，不要解释，不要寒暄。";

pub struct Engine {
    llm: Llm,
    cfg: Config,
}

impl Engine {
    pub fn new(cfg: Config) -> Self {
        Self { llm: Llm::new(&cfg.api_url, &cfg.api_key, &cfg.model), cfg }
    }

    /// 跑完整条生成链路。每个阶段结束调一次 `on_progress`。
    ///
    /// `on_progress` 是同步回调（Tauri 的 emit 本身就是同步的），
    /// 保持简单：引擎不关心它怎么送出去。
    pub async fn run<F>(
        &self,
        req: &Requirement,
        site_dir: &Path,
        mut on_progress: F,
    ) -> Result<Outcome, String>
    where
        F: FnMut(Progress),
    {
        let t0 = Instant::now();
        let mut tokens = 0u64;
        let mut degraded = false;
        let mut degrade_reason = String::new();

        std::fs::create_dir_all(site_dir).map_err(|e| format!("建站点目录失败：{e}"))?;

        let mut draft = SiteDraft {
            hall_url: self.cfg.hall_url.clone(),
            title: req.title.trim().to_string(),
            tagline: req.tagline.trim().to_string(),
            ..Default::default()
        };

        let brief = req.brief();
        let emit = |stage: Stage, tokens: u64, note: &str, on: &mut F| {
            on(Progress {
                stage,
                label: stage.label().to_string(),
                pct: stage.pct(),
                elapsed_ms: t0.elapsed().as_millis() as u64,
                tokens,
                note: note.to_string(),
                reload: true,
            });
        };

        // ── 阶段 1 骨架 ───────────────────────────────────────────────
        // 先出结构与导航，预览窗立刻看到一个灰模网页。
        // 「此时已经"有东西"了，心理上的等待从这里就结束了。」
        // 截断是**静默**故障：模型撞了 max_tokens 就地断句，HTTP 仍是 200，
        // 不读 stop_reason 的话整条链路会当成功交付一个半截页面。
        // 这里把每个阶段的截断都记下来，最后并进 degrade_reason 让人看得见。
        let mut cut: Vec<&str> = Vec::new();

        let sk = self.skeleton(&brief).await;
        match sk {
            Ok((s, used, truncated)) => {
                tokens += used;
                if truncated {
                    cut.push("骨架");
                }
                if !s.title.trim().is_empty() {
                    draft.title = s.title.trim().to_string();
                }
                if !s.tagline.trim().is_empty() {
                    draft.tagline = s.tagline.trim().to_string();
                }
                draft.palette = s.palette;
                draft.sections = s.sections;
            }
            Err(e) => {
                // 骨架挂了不能整条链路死掉：用需求单自己拼一个兜底结构，
                // 后面的阶段照跑。现场宁可样子普通也不能白屏。
                degraded = true;
                degrade_reason = format!("骨架生成失败，已用兜底结构继续：{e}");
                draft.sections = fallback_sections(req);
            }
        }
        if draft.sections.is_empty() {
            draft.sections = fallback_sections(req);
        }
        if draft.title.trim().is_empty() {
            draft.title = "我的网站".into();
        }
        write_site(site_dir, &draft)?;
        emit(Stage::Skeleton, tokens, &degrade_reason, &mut on_progress);

        // ── 阶段 2 首屏 ───────────────────────────────────────────────
        match self.hero(&brief, &draft).await {
            Ok((html, used, truncated)) => {
                tokens += used;
                if truncated {
                    cut.push("首屏");
                }
                draft.hero_html = html;
            }
            Err(e) => {
                degraded = true;
                degrade_reason = format!("首屏生成失败，保留灰模：{e}");
            }
        }
        write_site(site_dir, &draft)?;
        emit(Stage::Hero, tokens, &degrade_reason, &mut on_progress);

        // ── 阶段 3 内容区 ＋ 阶段 5 精修（并发发起）────────────────────
        // 精修 CSS 只吃 brief 和栏目标题，**不依赖内容区产出的任何东西**
        // （看 polish() 的入参就知道）。原来把它排在内容区之后串行等，
        // 那 40–55 秒是白等的。两条一起发，总耗时收敛到两者里慢的那个。
        //
        // 首屏没并进来是故意的：它是第一个能看见的节拍，必须尽早单独落屏，
        // 并进来会让 10s→65s 之间屏幕上什么都不长——快了，但演出废了。
        //
        // 降级闸必须在**发起之前**判。并发之后事后再判"时间不够所以跳过精修"
        // 毫无意义：那时候钱已经花完了。
        let over_time = t0.elapsed().as_secs() >= self.cfg.soft_deadline_secs;
        let over_budget = tokens >= self.cfg.gen_token_budget;
        let skip_polish = over_time || over_budget;

        let (content_r, polish_r) = if skip_polish {
            (self.content(&brief, &draft).await, None)
        } else {
            let (c, p) = tokio::join!(self.content(&brief, &draft), self.polish(&brief, &draft));
            (c, Some(p))
        };

        match content_r {
            Ok((html, used, truncated)) => {
                tokens += used;
                if truncated {
                    cut.push("内容区");
                }
                draft.sections_html = html;
            }
            Err(e) => {
                degraded = true;
                degrade_reason = format!("内容区生成失败，保留灰模：{e}");
            }
        }
        write_site(site_dir, &draft)?;
        emit(Stage::Content, tokens, &degrade_reason, &mut on_progress);

        // ── 阶段 4 页脚 ───────────────────────────────────────────────
        // 页脚是规划书第 02 节要求的传播闭环，两个入口写死在 Rust 里，
        // 不交给模型发挥——这是品牌展示位，不能这次有下次没有。
        draft.footer_html = render_footer(&draft);
        write_site(site_dir, &draft)?;
        emit(Stage::Footer, tokens, &degrade_reason, &mut on_progress);

        // ── 阶段 5 精修 ───────────────────────────────────────────────
        // 规划书第 01 节的降级顺序：时间不够就砍动效与配图精修。
        // 这里只负责收结果 —— 请求在上面和内容区一起发出去了。
        match polish_r {
            Some(Ok((css, used, truncated))) => {
                tokens += used;
                if truncated {
                    cut.push("精修 CSS");
                }
                draft.extra_css = css;
                write_site(site_dir, &draft)?;
                emit(Stage::Polish, tokens, &degrade_reason, &mut on_progress);
            }
            Some(Err(e)) => {
                degraded = true;
                degrade_reason = format!("精修失败，成品仍完整：{e}");
                write_site(site_dir, &draft)?;
                emit(Stage::Polish, tokens, &degrade_reason, &mut on_progress);
            }
            None => {
                degraded = true;
                degrade_reason = if over_time {
                    format!("已过 {} 秒软截止，跳过配图精修直接收尾", self.cfg.soft_deadline_secs)
                } else {
                    format!("token 触顶（{tokens}/{}），跳过配图精修直接收尾", self.cfg.gen_token_budget)
                };
                on_progress(Progress {
                    stage: Stage::Polish,
                    label: "跳过精修（降级收尾）".into(),
                    pct: Stage::Polish.pct(),
                    elapsed_ms: t0.elapsed().as_millis() as u64,
                    tokens,
                    note: degrade_reason.clone(),
                    reload: false,
                });
            }
        }

        // ── 收尾 ──────────────────────────────────────────────────────
        // 截断必须体现在结论里。之前这里什么都不做，于是被砍掉半页正文的产物
        // 照样以 degraded=false 交付——比生成失败更糟，因为没人会去看它。
        if !cut.is_empty() {
            degraded = true;
            let note = format!(
                "{} 撞到输出上限被截断，产物可能不完整（已自动补全未闭合标签）",
                cut.join("、")
            );
            degrade_reason =
                if degrade_reason.is_empty() { note } else { format!("{degrade_reason}；{note}") };
        }

        write_site(site_dir, &draft)?;

        // R4 红线自动检查：产物里绝不能带密钥。
        // 规划书原文要求「上线前搜一遍产物文件里有没有 sk- 开头的字符串，做成自动检查」。
        if let Some(hit) = scan_for_secrets(site_dir)? {
            return Err(format!(
                "产物疑似包含密钥（{hit}），已拦下不予交付。这是规划书 R4 的红线，请检查生成提示词。"
            ));
        }

        on_progress(Progress {
            stage: Stage::Done,
            label: Stage::Done.label().to_string(),
            pct: 100,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            tokens,
            note: degrade_reason.clone(),
            reload: true,
        });

        Ok(Outcome {
            site_dir: site_dir.display().to_string(),
            title: draft.title.clone(),
            tagline: draft.tagline.clone(),
            elapsed_ms: t0.elapsed().as_millis() as u64,
            tokens,
            degraded,
            degrade_reason,
        })
    }

    /// 骨架：**失败重试一次**。
    ///
    /// 它是唯一一个「自己挂了会把整页拖下水」的阶段——栏目规划、配色、标题全在这，
    /// 挂了就退到兜底结构，后面三个阶段都在一个没规划过的骨架上干活。
    /// 而它只花 7–10 秒、几百 token，是全链路最便宜的一段。
    /// 实测见过模型把 JSON 写坏（第 631 列少个逗号）——这种是掷骰子，重掷一次就好。
    /// 只重一次：真是提示词或网关的问题，重十次也一样，白白拖慢现场。
    async fn skeleton(&self, brief: &str) -> Result<(Skeleton, u64, bool), String> {
        match self.skeleton_once(brief).await {
            Ok(v) => Ok(v),
            Err(first) => match self.skeleton_once(brief).await {
                Ok((s, used, t)) => Ok((s, used, t)),
                // 两次都挂就如实带上第一次的原因——重试掩盖了首因最难查
                Err(second) => Err(format!("{second}（重试前那次：{first}）")),
            },
        }
    }

    async fn skeleton_once(&self, brief: &str) -> Result<(Skeleton, u64, bool), String> {
        let sys = format!(
            "你是一名网页结构设计师。根据需求单，规划一个单页网站的结构与配色。\n\
             只输出 JSON：\n\
             {{\"title\":\"页面标题\",\"tagline\":\"一句话亮点，不超过60字\",\n\
               \"palette\":{{\"bg\":\"#..\",\"surface\":\"#..\",\"text\":\"#..\",\"muted\":\"#..\",\"accent\":\"#..\"}},\n\
               \"sections\":[{{\"id\":\"英文小写短id\",\"heading\":\"中文栏目标题\",\"intent\":\"这一栏放什么\"}}]}}\n\
             规则：sections 3 到 5 个，第一个不要是首屏（首屏单独做）。\n\
             配色要和内容气质相符，保证正文与背景对比度足够。\n{NO_EXTERNAL}"
        );
        // max_tokens 给足：1200 时实测 3 次里有 1 次 JSON 在 1342 列被截断，
        // 触发兜底结构（能跑，但栏目规划就白做了）。骨架是后面所有阶段的输入，
        // 这里省 token 是最不划算的。
        let c = self.llm.complete(&sys, &[Msg::user(brief.to_string())], 2200).await?;
        let json = extract_json(&c.text).ok_or("骨架输出里没有 JSON")?;
        let s: Skeleton = serde_json::from_str(json).map_err(|e| format!("骨架 JSON 解析失败：{e}"))?;
        Ok((s, c.usage.total(), c.truncated()))
    }

    async fn hero(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let sys = format!(
            "你是一名网页文案与前端。写这个网站的**首屏区块**。\n\
             只输出一个 ```html 代码块，内容是 <section class=\"hero\"> …… </section>，\n\
             里面要有大标题、一句副标题、以及一两句引子。文案要具体、有人味，\n\
             直接用需求单里用户说过的事，不要写「欢迎来到我的网站」这种空话。\n\
             可以用内联 SVG 或 CSS 渐变做装饰。可用的配色变量：\n\
             var(--bg) var(--surface) var(--text) var(--muted) var(--accent)。\n\
             首屏里如果放跳转按钮，**锚点只能从下面给出的栏目 id 里挑**，\n\
             一个字都不能改、更不能自己编——编出来的锚点点了不跳，是现场最丢人的那种 bug。\n{NO_EXTERNAL}"
        );
        // 必须把真实栏目 id 喂进去。实测漏传时模型会自造 `#find` 去指一个叫
        // `find-us` 的栏目，首屏按钮点了没反应——观众三秒内就会碰到。
        let anchors = d
            .sections
            .iter()
            .map(|s| format!("#{}（{}）", s.id, s.heading))
            .collect::<Vec<_>>()
            .join("、");
        let user = format!(
            "需求单：\n{brief}\n站点标题：{}\n可用锚点（只能用这些）：{}",
            d.title,
            if anchors.is_empty() { "（暂无，不要放跳转按钮）".to_string() } else { anchors }
        );
        // 1600 偏紧：首屏带内联 SVG 装饰时很容易压线
        // 2400 → 3600：k3 写首屏爱铺陈，2400 实测会断在按钮文案中间（2026-08-15 摸鱼案）
        let c = self.llm.complete(&sys, &[Msg::user(user)], 3600).await?;
        Ok((close_unclosed(extract_block(&c.text, "html")), c.usage.total(), c.truncated()))
    }

    async fn content(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let plan = d
            .sections
            .iter()
            .map(|s| format!("- id={} 标题={} 打算放={}", s.id, s.heading, s.intent))
            .collect::<Vec<_>>()
            .join("\n");
        let sys = format!(
            "你是一名网页文案与前端。按给定的栏目计划写出**全部内容区块**。\n\
             只输出一个 ```html 代码块，里面是若干个 <section id=\"...\"> …… </section>，顺序与计划一致。\n\
             每个栏目都要有真实、具体的文案，宁可短也不要套话。\n\
             需要列表、卡片、时间线就用语义化 HTML 写出来。\n\
             可用的配色变量：var(--bg) var(--surface) var(--text) var(--muted) var(--accent)。\n\
             可以写 <style> 标签补充这些区块自己的样式。\n{NO_EXTERNAL}"
        );
        let user = format!("需求单：\n{brief}\n\n栏目计划：\n{plan}");
        // 额度演进史：4000 → 4 栏页面撞上限，正文停在半句话中间、5 个标签没闭合，
        // 而当时 stop_reason 没人读，链路还报「成功、未降级」。
        // 8000 → 文字类够了，但条目密集的题目（一百个色名、按键热力）仍会撞。
        // 这是全篇最长的一段产出，也是唯一直接决定"页面完不完整"的一段，
        // 省这里的 token 是最不划算的。
        let c = self.llm.complete(&sys, &[Msg::user(user)], 11000).await?;
        Ok((close_unclosed(extract_block(&c.text, "html")), c.usage.total(), c.truncated()))
    }

    async fn polish(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let sys = format!(
            "你是一名前端。给已经成型的页面补一层**精修 CSS**：\n\
             入场动效（要克制）、响应式适配（窄屏单列）、排版细节（行高、字距、留白）、\n\
             以及用 CSS 渐变/图形做的装饰。\n\
             只输出一个 ```css 代码块，不要 HTML。不要重设已有配色变量。\n\
             必须包含 @media (max-width: 720px) 的窄屏规则。\n\
             动效一律加 @media (prefers-reduced-motion: reduce) 的关闭分支。\n{NO_EXTERNAL}"
        );
        let user = format!("需求单：\n{brief}\n栏目：{}", d.sections.iter().map(|s| s.heading.as_str()).collect::<Vec<_>>().join("、"));
        // 额度演进史（都是实测打出来的）：
        //   2000 → 5 个用例里 4 个 CSS 停在半条声明上，兜底闸被吞
        //   3000 → 文字类页面够了，但色卡/深海这种视觉密集的题目 6 个里 3 个还在截断
        //   4500 → 星空/深海这种要画渐变、星点、光晕的页面还是正好撞满
        //   6000 → 当前值
        // 精修现在和内容区**并发**跑，只要它比内容区先回来，加额度的墙钟成本就是 0；
        // 实测内容区普遍 110–210s，精修 4500 token 时已经在它之前收工，还有余量。
        let c = self.llm.complete(&sys, &[Msg::user(user)], 6000).await?;
        Ok((harden_css(extract_block(&c.text, "css")), c.usage.total(), c.truncated()))
    }
}

/// 骨架失败时的兜底栏目：直接从需求单硬拼，保证有结构可渲染。
fn fallback_sections(req: &Requirement) -> Vec<SectionPlan> {
    if !req.sections.is_empty() {
        return req
            .sections
            .iter()
            .enumerate()
            .map(|(i, h)| SectionPlan {
                id: format!("s{}", i + 1),
                heading: h.clone(),
                intent: h.clone(),
            })
            .collect();
    }
    vec![
        SectionPlan { id: "about".into(), heading: "关于".into(), intent: req.content.clone() },
        SectionPlan { id: "content".into(), heading: "内容".into(), intent: req.content.clone() },
    ]
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 页脚：规划书第 02 节的传播闭环，两个入口固定。
fn render_footer(d: &SiteDraft) -> String {
    let hall = if d.hall_url.trim().is_empty() { "#" } else { d.hall_url.trim() };
    format!(
        r#"<footer class="site-footer">
  <div class="footer-links">
    <a href="{hall}">← 回到大厅</a>
    <a href="{hall}" class="cta">我也要做一个</a>
  </div>
  <p class="footer-note">本站由「一句话生成」现场制作</p>
</footer>"#
    )
}

/// 灰模：骨架阶段就要有东西可看，所以每个规划出来的栏目
/// 先渲染成占位块。真实内容到位后被整体替换。
fn render_gray(d: &SiteDraft) -> String {
    d.sections
        .iter()
        .map(|s| {
            format!(
                r#"<section id="{}" class="gray"><h2>{}</h2><div class="gray-lines"><i></i><i></i><i></i></div></section>"#,
                esc(&s.id),
                esc(&s.heading)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 把草稿渲染成完整 index.html 并落盘。
///
/// 每个阶段结束都整体重渲染一次：拼装成本可以忽略，
/// 换来的是「任何一段失败都不会把已长出来的部分弄丢」。
pub fn write_site(dir: &Path, d: &SiteDraft) -> Result<(), String> {
    let html = render(d);
    std::fs::write(dir.join("index.html"), html).map_err(|e| format!("写 index.html 失败：{e}"))
}

pub fn render(d: &SiteDraft) -> String {
    let p = &d.palette;
    let hero = if d.hero_html.trim().is_empty() {
        format!(
            r#"<section class="hero gray"><h1>{}</h1><div class="gray-lines"><i></i><i></i></div></section>"#,
            esc(&d.title)
        )
    } else {
        d.hero_html.clone()
    };
    let body = if d.sections_html.trim().is_empty() { render_gray(d) } else { d.sections_html.clone() };
    let nav = d
        .sections
        .iter()
        .map(|s| format!(r##"<a href="#{}">{}</a>"##, esc(&s.id), esc(&s.heading)))
        .collect::<Vec<_>>()
        .join("");

    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{tagline}">
<style>
:root{{--bg:{bg};--surface:{surface};--text:{text};--muted:{muted};--accent:{accent};
  --sans:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.75}}
img,svg{{max-width:100%;height:auto}}
a{{color:var(--accent)}}
section{{max-width:920px;margin:0 auto;padding:64px 24px}}
h1{{font-size:clamp(30px,6vw,54px);line-height:1.2;margin:0 0 16px}}
h2{{font-size:clamp(21px,3.4vw,30px);margin:0 0 18px}}
.site-nav{{position:sticky;top:0;z-index:9;display:flex;gap:20px;flex-wrap:wrap;
  padding:14px 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent)}}
.site-nav a{{color:var(--muted);text-decoration:none;font-size:14px}}
.site-nav a:hover{{color:var(--accent)}}
/* 灰模：骨架阶段的占位，真实内容到位后被替换 */
.gray-lines i{{display:block;height:13px;border-radius:7px;margin:11px 0;
  background:color-mix(in srgb,var(--text) 11%,transparent)}}
.gray-lines i:nth-child(2){{width:82%}} .gray-lines i:nth-child(3){{width:58%}}
.gray h2,.gray h1{{color:var(--muted)}}
.site-footer{{border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent);
  margin-top:40px;padding:36px 24px 48px;text-align:center}}
.footer-links{{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}}
.footer-links a{{text-decoration:none;font-size:15px;padding:9px 18px;border-radius:999px;
  border:1px solid color-mix(in srgb,var(--accent) 40%,transparent)}}
.footer-links a.cta{{background:var(--accent);color:var(--bg);border-color:var(--accent)}}
.footer-note{{color:var(--muted);font-size:13px;margin:0}}
@media(max-width:720px){{section{{padding:44px 18px}}}}
</style>
<style>
{extra}
</style>
</head>
<body>
<nav class="site-nav">{nav}</nav>
{hero}
{body}
{footer}
</body>
</html>
"#,
        title = esc(&d.title),
        tagline = esc(&d.tagline),
        bg = p.bg,
        surface = p.surface,
        text = p.text,
        muted = p.muted,
        accent = p.accent,
        extra = d.extra_css,
        nav = nav,
        hero = hero,
        body = body,
        footer = d.footer_html,
    )
}

/// 精修 CSS 的加固闸。
///
/// 模型很爱写这个入场动效套路：
/// ```css
/// header,section,footer{opacity:0;animation:fadeUp .9s forwards}
/// @keyframes fadeUp{from{opacity:0}to{opacity:1}}
/// ```
/// 写对了很好看。但只要有一处没对上——关键帧名拼错、关键帧根本没定义、
/// 或者 `prefers-reduced-motion` 分支只写了 `animation:none` 却忘了还原 opacity——
/// **整页就是永久空白**。现场当着人面出白屏，是最难解释的一种翻车。
///
/// 这里不禁止动效（能跑就让它跑，观感是加分项），只堵死"永久藏起来"这个结局：
/// 1. 引用了未定义关键帧的规则，剥掉它的 `opacity:0` 打底；
/// 2. 末尾追加 reduced-motion 兜底，保证关掉动效时容器一定可见。
pub fn harden_css(css: &str) -> String {
    let defined = keyframe_names(css);
    let mut out = String::with_capacity(css.len() + 256);
    let mut rest = css;

    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|i| open + i) else { break };
        let head = &rest[..=open];
        let body = &rest[open + 1..close];

        // @keyframes / @media 这类嵌套块不在这里处理，原样透传即可——
        // 它们内部的规则会在后续循环里被单独扫到。
        let referenced = referenced_animation(body);
        let strip = matches!(referenced, Some(ref n) if !defined.contains(n));

        out.push_str(head);
        if strip {
            out.push_str(&drop_zero_opacity(body));
        } else {
            out.push_str(body);
        }
        out.push('}');
        rest = &rest[close + 1..];
    }
    out.push_str(rest);

    // 截断收口。撞了 max_tokens 的 CSS 会停在半条声明上（`border-bottom:` 后面没值），
    // 留下一个没闭合的 `{`。下面那段兜底闸是**追加**在这之后的，
    // 于是整段被当成那条非法声明的值一起吞掉——兜底闸自己先失效了。
    // 所以在追加之前必须先把括号补平。
    let out = close_unclosed_braces(&out);
    let mut out = out;

    out.push_str(
        "\n/* 兜底闸：关掉动效时，入场动画的初始态不许把内容永久藏起来 */\n\
         @media (prefers-reduced-motion: reduce){\n\
         \x20 body :where(header,section,footer,article,main,figure,nav,.hero){\n\
         \x20   opacity:1 !important;transform:none !important;animation:none !important}\n\
         }\n",
    );
    out
}

/// 把被截断的 HTML 收口，让它至少是**合法嵌套**的。
///
/// 撞了 max_tokens 的 HTML 有两种断法，第二种远比第一种毒：
/// 1. 断在标签之间 —— 只是少了几个 `</section>`，页面还能看；
/// 2. **断在属性值中间**（实测 `<div class="num`）—— 引号没闭合，
///    HTML 分词器会一路吞到下一个 `>` 才收工，把紧随其后的整块 `<style>`
///    当成属性值吃掉。结果是内容区样式**整个消失**，正文还被残留的 class 染色。
///
/// 所以顺序是：先砍掉末尾那个没写完的标签，再按栈补齐闭合标签。
pub fn close_unclosed(html: &str) -> String {
    const VOID: [&str; 15] = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
        "source", "track", "wbr", "!doctype",
    ];
    let mut s = html.trim_end().to_string();

    // 末尾那个没写完的标签直接砍掉——留着它比少一段内容坏得多
    if let Some(i) = s.rfind('<') {
        if !s[i..].contains('>') {
            s.truncate(i);
        }
    }

    let mut stack: Vec<String> = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // 注释整段跳过：里面的 `<` `>` 不是标签
        if s[i..].starts_with("<!--") {
            match s[i..].find("-->") {
                Some(j) => {
                    i += j + 3;
                    continue;
                }
                None => break,
            }
        }
        let Some(rel) = s[i..].find('>') else { break };
        let end = i + rel;
        let inner = &s[i + 1..end];
        i = end + 1;

        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        let closing = inner.starts_with('/');
        let raw = if closing { &inner[1..] } else { inner };
        let name: String = raw
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if VOID.contains(&name.as_str()) || inner.trim_end().ends_with('/') {
            continue;
        }

        if closing {
            // 就近匹配：`<div><span></div>` 这种错嵌也要能把 span 一起弹掉，
            // 否则栈会越积越深，最后补出一堆莫名其妙的闭合标签。
            if let Some(p) = stack.iter().rposition(|x| *x == name) {
                stack.truncate(p);
            }
        } else {
            stack.push(name);
        }
    }

    for name in stack.iter().rev() {
        s.push('<');
        s.push('/');
        s.push_str(name);
        s.push('>');
    }
    s
}

/// 末尾那条没写完的声明 / 孤儿选择器的起点。
///
/// 最后一个 `;{}` 之后若还剩实质内容，那必然是半条东西：
/// `border-bottom:` 后面没值，或者光秃秃一个 `.project`。
/// **括号配平与否都要切**——孤儿选择器不影响括号计数，却会把紧随其后的
/// 那段兜底闸整个吞成自己的选择器串（实测 cafe / portfolio 都是这么废掉的）。
///
/// 末尾的注释不算实质内容，正常收尾的样式表不该被误伤。
fn trailing_partial_decl(css: &str) -> Option<usize> {
    let cut = css.rfind(|c| c == ';' || c == '{' || c == '}').map(|i| i + 1).unwrap_or(0);
    let tail = &css[cut..];

    // 剥掉注释再看还剩什么
    let mut meat = String::new();
    let mut rest = tail;
    loop {
        match rest.find("/*") {
            Some(i) => {
                meat.push_str(&rest[..i]);
                match rest[i..].find("*/") {
                    Some(j) => rest = &rest[i + j + 2..],
                    None => {
                        rest = "";
                        break;
                    }
                }
            }
            None => {
                meat.push_str(rest);
                break;
            }
        }
    }
    meat.push_str(rest);

    if meat.trim().is_empty() {
        None
    } else {
        Some(cut)
    }
}

/// 把被截断的 CSS 括号补平（字符串与注释里的括号不算）。
fn close_unclosed_braces(css: &str) -> String {
    let mut depth = 0i32;
    let mut in_str: Option<char> = None;
    let mut in_comment = false;
    let mut prev = '\0';

    for c in css.chars() {
        if in_comment {
            if prev == '*' && c == '/' {
                in_comment = false;
                prev = '\0';
                continue;
            }
            prev = c;
            continue;
        }
        match in_str {
            Some(q) => {
                if c == q && prev != '\\' {
                    in_str = None;
                }
            }
            None => match c {
                '*' if prev == '/' => in_comment = true,
                '"' | '\'' => in_str = Some(c),
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            },
        }
        prev = c;
    }

    let mut out = css.trim_end().to_string();
    // 先切半条声明 / 孤儿选择器（与括号是否配平无关），再补缺的右括号
    if let Some(cut) = trailing_partial_decl(&out) {
        out.truncate(cut);
    }
    for _ in 0..depth.max(0) {
        out.push('}');
    }
    out
}

fn keyframe_names(css: &str) -> Vec<String> {
    let mut v = Vec::new();
    let mut rest = css;
    while let Some(i) = rest.find("@keyframes") {
        let after = &rest[i + "@keyframes".len()..];
        let name: String = after
            .trim_start()
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !name.is_empty() {
            v.push(name);
        }
        rest = after;
    }
    v
}

/// 从声明块里取出它引用的动画名（`animation` 简写或 `animation-name`）。
fn referenced_animation(body: &str) -> Option<String> {
    for decl in body.split(';') {
        let (prop, val) = decl.split_once(':')?;
        let prop = prop.trim();
        if prop != "animation" && prop != "animation-name" {
            continue;
        }
        // 简写里名字可能在任意位置；跳过明显是时长/缓动/关键字的 token
        for tok in val.split_whitespace() {
            let t = tok.trim_matches(|c: char| c == ',' || c == '!').trim();
            if t.is_empty() || t.starts_with("var(") || t.contains('(') {
                continue;
            }
            if t.ends_with('s') && t.trim_end_matches('s').parse::<f32>().is_ok() {
                continue;
            }
            if matches!(
                t,
                "none" | "forwards" | "backwards" | "both" | "infinite" | "alternate"
                    | "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
                    | "normal" | "reverse" | "alternate-reverse" | "running" | "paused"
                    | "important"
            ) || t.parse::<f32>().is_ok()
            {
                continue;
            }
            return Some(t.to_string());
        }
    }
    None
}

fn drop_zero_opacity(body: &str) -> String {
    body.split(';')
        .filter(|decl| {
            match decl.split_once(':') {
                Some((p, v)) if p.trim() == "opacity" => {
                    v.trim().trim_end_matches("!important").trim().parse::<f32>() != Ok(0.0)
                }
                _ => true,
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// R4 自动检查：扫产物里有没有像密钥的字符串。
///
/// 只认高置信度的前缀，不做泛化——误报会拦下正常作品，
/// 现场当着人面被拦比漏一个更难解释。
pub fn scan_for_secrets(dir: &Path) -> Result<Option<String>, String> {
    const NEEDLES: &[&str] = &["sk-cp-", "sk-ant-", "sk-proj-", "AKIA", "ANTHROPIC_API_KEY"];
    let rd = std::fs::read_dir(dir).map_err(|e| format!("扫描产物目录失败：{e}"))?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(h) = scan_for_secrets(&p)? {
                return Ok(Some(h));
            }
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&p) else { continue };
        for n in NEEDLES {
            if body.contains(n) {
                return Ok(Some(format!("{} 里出现 {n}", p.display())));
            }
        }
    }
    Ok(None)
}

/// 站点目录名。用时间戳前缀保证同一台机器上不撞车，
/// 真正对外的 slug 由服务端按姓名拼音分配（r2-sites/src/pinyin.js）。
pub fn new_site_dir(root: &Path) -> PathBuf {
    root.join(uuid::Uuid::new_v4().to_string()[..8].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> SiteDraft {
        SiteDraft {
            title: "我家猫的回忆录".into(),
            tagline: "十八年".into(),
            sections: vec![
                SectionPlan { id: "photos".into(), heading: "照片".into(), intent: "老照片".into() },
                SectionPlan { id: "story".into(), heading: "故事".into(), intent: "日常".into() },
            ],
            hall_url: "https://hall.example".into(),
            ..Default::default()
        }
    }

    // ── 截断收口 ──────────────────────────────────────────────────
    // 下面的用例全部取自 2026-08-15 那轮 5 路并发压测的**真实产物**：
    // 5 个用例 5 个都被截断，而链路清一色报 ok:true / degraded:false。

    #[test]
    fn truncated_attribute_is_cut_not_left_dangling() {
        // portfolio 的真实断法：断在属性值中间。留着它，HTML 分词器会一路吞到
        // 下一个 `>`，把紧随其后的整块 <style> 当属性吃掉——内容区样式全没了。
        let bad = r#"<section class="hero"><div class="hero-stat"><div class="num"#;
        let fixed = close_unclosed(bad);
        assert!(!fixed.contains(r#"class="num"#), "没写完的标签必须砍掉：{fixed}");
        assert!(fixed.ends_with("</div></section>"), "砍完还要补齐闭合：{fixed}");
    }

    #[test]
    fn truncated_content_gets_its_tags_closed() {
        // ledger 的真实断法：正文停在半句话上，section/div/article/p 共 5 个没闭合
        let bad = "<section id=\"a\"><article><div><p>公共账户不够花，先问两个问题：是入金比例定低了，还是";
        let fixed = close_unclosed(bad);
        assert!(fixed.ends_with("</p></div></article></section>"), "{fixed}");
        assert!(fixed.contains("先问两个问题"), "已经写出来的正文不许丢");
    }

    #[test]
    fn well_formed_html_is_left_alone() {
        // 没坏的产物一个字节都不许动
        let ok = "<section id=\"a\"><p>好好的</p><img src=\"x.png\"><br></section>";
        assert_eq!(close_unclosed(ok), ok);
    }

    #[test]
    fn void_and_self_closing_tags_are_not_pushed() {
        let s = "<div><img src=\"a\"><br/><input value=\"x\"><hr>";
        assert_eq!(close_unclosed(s), format!("{s}</div>"));
    }

    #[test]
    fn comments_are_not_mistaken_for_tags() {
        let s = "<div><!-- <section> 这是注释里的假标签 --></div>";
        assert_eq!(close_unclosed(s), s);
    }

    #[test]
    fn mismatched_nesting_unwinds_to_nearest_match() {
        // `<div><span></div>` 这种错嵌，闭 div 时要把 span 一起弹掉，
        // 否则栈越积越深，最后补出一串莫名其妙的闭合标签
        let fixed = close_unclosed("<div><span>x</div>");
        assert_eq!(fixed, "<div><span>x</div>");
    }

    #[test]
    fn truncated_css_braces_get_balanced() {
        // wedding 的真实断法：`border-bottom:` 后面没值，`a {` 从未闭合
        let bad = "a{color:var(--gold);text-decoration:none;border-bottom:";
        let fixed = close_unclosed_braces(bad);
        assert!(fixed.ends_with('}'), "{fixed}");
        assert!(!fixed.contains("border-bottom:"), "半条声明要切掉，别补成 `border-bottom:}}`：{fixed}");
        assert!(fixed.contains("color:var(--gold)"), "写完的声明不许丢");
    }

    #[test]
    fn orphan_selector_at_eof_is_dropped() {
        // portfolio / cafe 的真实断法：末尾剩一个光秃秃的选择器
        let bad = ".project-card:nth-child(1){animation-delay:.1s}\n.project";
        let fixed = close_unclosed_braces(bad);
        assert!(!fixed.trim_end().ends_with(".project"), "孤儿选择器会把后面的规则吞成选择器串：{fixed}");
        assert!(fixed.contains("animation-delay:.1s"));
    }

    #[test]
    fn braces_inside_strings_and_comments_dont_count() {
        let s = "a{content:\"{{{\"}\n/* } } } */\nb{color:red}";
        assert_eq!(close_unclosed_braces(s), s, "字符串和注释里的括号不算数");
    }

    #[test]
    fn hardened_css_keeps_the_reduced_motion_guard_reachable() {
        // 这条是本次压测最值钱的回归：harden_css 的兜底闸是**追加**在末尾的，
        // 前面只要有一个没闭合的 `{`，整段兜底闸就被当成那条非法声明的值吞掉，
        // 兜底闸自己先失效了。实测 5 个产物里 4 个都这样。
        let truncated = "section:nth-of-type(1){animation-delay:0.15s;";
        let out = harden_css(truncated);
        let guard = out.find("prefers-reduced-motion").expect("兜底闸必须在");
        let before = &out[..guard];
        let depth = before.matches('{').count() as i32 - before.matches('}').count() as i32;
        assert_eq!(depth, 0, "兜底闸之前的括号必须已经配平，否则它会被吞掉：\n{out}");
    }

    #[test]
    fn skeleton_stage_already_renders_a_visible_page() {
        // R1 的核心：骨架阶段就必须"有东西"，不能是白屏
        let html = render(&draft());
        assert!(html.contains("我家猫的回忆录"));
        assert!(html.contains("gray-lines"), "骨架阶段要有灰模占位");
        assert!(html.contains(r##"href="#photos""##), "导航要按栏目计划生成");
        assert!(html.contains("照片") && html.contains("故事"));
    }

    #[test]
    fn real_content_replaces_the_gray_blocks() {
        let mut d = draft();
        d.hero_html = "<section class=\"hero\"><h1>十八年</h1></section>".into();
        d.sections_html = "<section id=\"photos\"><h2>照片</h2><p>真内容</p></section>".into();
        let html = render(&d);
        assert!(html.contains("真内容"));
        // 灰模的 CSS 类还在（样式表里），但不该再有占位实例
        assert!(!html.contains("<div class=\"gray-lines\">"));
    }

    #[test]
    fn footer_always_carries_both_exits() {
        // 规划书第 02 节：传播闭环 + 品牌展示位，不能这次有下次没有
        let mut d = draft();
        d.footer_html = render_footer(&d);
        let html = render(&d);
        assert!(html.contains("← 回到大厅"));
        assert!(html.contains("我也要做一个"));
        assert!(html.contains("https://hall.example"));
    }

    #[test]
    fn escaping_blocks_markup_injection_from_requirement() {
        // 标题来自用户口述，经模型透传，必须转义
        let mut d = draft();
        d.title = r#"<script>alert(1)</script>"#.into();
        let html = render(&d);
        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn stage_progress_is_monotonic() {
        let seq = [Stage::Skeleton, Stage::Hero, Stage::Content, Stage::Footer, Stage::Polish, Stage::Done];
        for w in seq.windows(2) {
            assert!(w[0].pct() < w[1].pct(), "{:?} 应早于 {:?}", w[0], w[1]);
        }
        assert_eq!(Stage::Done.pct(), 100);
    }

    #[test]
    fn fallback_sections_prefer_the_requirement() {
        let req = Requirement {
            title: "t".into(),
            content: "c".into(),
            sections: vec!["首页".into(), "作品".into()],
            ..Default::default()
        };
        let s = fallback_sections(&req);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].heading, "首页");

        // 需求单里连栏目都没有，也得给出可渲染的结构
        let bare = Requirement { title: "t".into(), content: "c".into(), ..Default::default() };
        assert_eq!(fallback_sections(&bare).len(), 2);
    }

    #[test]
    fn harden_keeps_working_animations_intact() {
        // 关键帧定义齐全 —— 一个字都不该动，动效是加分项
        let css = "header,section{opacity:0;animation:fadeUp .9s forwards}\
                   @keyframes fadeUp{from{opacity:0}to{opacity:1}}";
        let out = harden_css(css);
        assert!(out.contains("opacity:0;animation:fadeUp"), "正常动效被误伤了：{out}");
    }

    #[test]
    fn harden_strips_opacity_when_keyframes_are_missing() {
        // 关键帧名拼错 → 动画永不执行 → opacity:0 永久生效 → 整页空白
        let css = "section{opacity:0;animation:fadeUpp .9s forwards}\
                   @keyframes fadeUp{from{opacity:0}to{opacity:1}}";
        let out = harden_css(css);
        assert!(out.contains("section{animation:fadeUpp"), "打底 opacity 应被剥掉：{out}");
        // 关键帧内部的 from{opacity:0} 是合法的，必须原样留着
        assert!(out.contains("@keyframes fadeUp{from{opacity:0}"), "误伤了关键帧：{out}");
    }

    #[test]
    fn harden_always_appends_the_reduced_motion_guard() {
        // 模型只写 animation:none 忘了还原 opacity 时的兜底
        let out = harden_css("section{color:red}");
        assert!(out.contains("prefers-reduced-motion"));
        assert!(out.contains("opacity:1 !important"));
        // 原样内容不能丢
        assert!(out.contains("section{color:red}"));
    }

    #[test]
    fn harden_recognises_animation_name_property() {
        let css = "section{opacity:0;animation-name:slideIn;animation-duration:1s}";
        let out = harden_css(css);
        assert!(!out.contains("opacity:0"), "animation-name 写法也要认出来");
    }

    #[test]
    fn harden_ignores_non_zero_opacity() {
        // .75 这类刻意的半透明不能被当成打底剥掉
        let css = "footer{opacity:.75;animation:ghost 1s}";
        let out = harden_css(css);
        assert!(out.contains("opacity:.75"));
    }

    #[test]
    fn secret_scan_catches_a_leaked_key() {
        let dir = std::env::temp_dir().join(format!("yiju-scan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("index.html"), "<p>干净</p>").unwrap();
        assert!(scan_for_secrets(&dir).unwrap().is_none());

        // R4：产物里带 key 必须被拦下，子目录也要扫到
        std::fs::write(dir.join("nested/app.js"), "const k='sk-cp-abcdef';").unwrap();
        let hit = scan_for_secrets(&dir).unwrap();
        assert!(hit.is_some());
        assert!(hit.unwrap().contains("sk-cp-"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
