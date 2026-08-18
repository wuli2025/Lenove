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

use crate::cloud::CloudConfig;
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
    Visuals,
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
            Stage::Visuals => "生图模型正在画作品画面",
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
            Stage::Skeleton => 16,
            Stage::Visuals => 32,
            Stage::Hero => 46,
            Stage::Content => 68,
            Stage::Footer => 78,
            Stage::Polish => 93,
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
    /// 版式：prose / cards / timeline / list / gallery / stats / quotes / faq / steps。
    /// 骨架阶段就定死，内容阶段照着写——不然六栏出来全是一样的段落堆。
    pub layout: String,
    /// 这一栏必须写到的几点。**页面丰不丰满在这里就决定了**：
    /// 骨架只给一句 intent，内容阶段就只能自由发挥出三行套话。
    pub beats: Vec<String>,
}

impl SectionPlan {
    /// 版式关键词，模型没给或给了个没见过的词就退回长文
    fn layout_or_prose(&self) -> &str {
        const KNOWN: [&str; 9] = [
            "prose", "cards", "timeline", "list", "gallery", "stats", "quotes", "faq", "steps",
        ];
        let l = self.layout.trim();
        if KNOWN.contains(&l) {
            l
        } else {
            "prose"
        }
    }
    /// 这一栏该占多少视觉体量。灰模按它铺占位，页面在骨架阶段就有真实的形状。
    fn weight(&self) -> usize {
        self.beats.len().clamp(3, 6)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct ImagePlan {
    /// 稳定的小写资源名；`cover` 是强制首图，其余如 `memory-room`。
    pub slot: String,
    /// hero / section，用于约束图片放置位置。
    pub purpose: String,
    /// 给生图模型的英文画面描述；禁止要求模型在图里写字、画 UI 或二维码。
    pub prompt: String,
    pub alt: String,
    pub section_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedVisual {
    pub slot: String,
    pub path: String,
    pub alt: String,
    pub section_id: String,
}

const MAX_VISUALS: usize = 4;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct Skeleton {
    title: String,
    tagline: String,
    /// 整站气质与视觉基调，一两句话。骨架定一次，首屏与精修共用——
    /// 不然首屏走温柔路线、精修配了套赛博霓虹，两边各画各的。
    mood: String,
    palette: Palette,
    sections: Vec<SectionPlan>,
    image_plans: Vec<ImagePlan>,
}

/// 站点草稿。每个阶段只改自己那一块，渲染时整体拼装——
/// 这样任何一段失败都不会把已经长出来的部分弄丢。
#[derive(Debug, Clone, Default)]
pub struct SiteDraft {
    pub title: String,
    pub tagline: String,
    pub mood: String,
    pub palette: Palette,
    pub sections: Vec<SectionPlan>,
    pub image_plans: Vec<ImagePlan>,
    pub visuals: Vec<GeneratedVisual>,
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
    pub cover_path: String,
    pub visual_count: usize,
    /// Rust 桌面装配层用于发布前复验；WebView 不需要拿到完整内部清单。
    #[serde(skip_serializing)]
    pub visuals: Vec<GeneratedVisual>,
    /// 是否走了降级分支
    pub degraded: bool,
    pub degrade_reason: String,
}

const NO_EXTERNAL: &str = "\
硬性约束（违反即作废）：
- 产物必须完全自包含：禁止外部字体、外部图片 URL、<script src> 与外链样式表。
- 严禁生成任何 <svg>、data:image/svg+xml 或 .svg 资源；也不许用 CSS 图形冒充作品画面。
- 页面里的作品图片只能使用本次提供的 assets/*.jpg 清单，不能自行编造路径。
- CSS 渐变只可做背景、光晕、分隔等非形象化装饰，不能替代清单中的真实生图。
- 禁止写入任何 API key、token、密钥。
- 只输出要求的那一段，不要解释，不要寒暄。";

pub struct Engine {
    llm: Llm,
    cfg: Config,
    cloud: CloudConfig,
}

impl Engine {
    pub fn new(cfg: Config, cloud: CloudConfig) -> Self {
        Self {
            llm: Llm::new(&cfg.api_url, &cfg.api_key, &cfg.model),
            cfg,
            cloud,
        }
    }

    /// 跑完整条生成链路。每个阶段结束调一次 `on_progress`。
    ///
    /// `on_progress` 是同步回调（Tauri 的 emit 本身就是同步的），
    /// 保持简单：引擎不关心它怎么送出去。
    pub async fn run<F>(
        &self,
        req: &Requirement,
        site_dir: &Path,
        on_progress: F,
    ) -> Result<Outcome, String>
    where
        F: FnMut(Progress),
    {
        let hard = std::time::Duration::from_secs(self.cfg.hard_deadline_secs.max(1));
        tokio::time::timeout(hard, self.run_inner(req, site_dir, on_progress))
            .await
            .map_err(|_| {
                format!(
                    "生成超过 {} 秒硬截止，已取消仍在进行的模型与生图任务，请重试。",
                    self.cfg.hard_deadline_secs.max(1)
                )
            })?
    }

    async fn run_inner<F>(
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
                draft.mood = s.mood.trim().to_string();
                draft.palette = s.palette;
                draft.sections = s.sections;
                draft.image_plans = s.image_plans;
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
        draft.image_plans = normalize_image_plans(&draft, &brief);
        write_site(site_dir, &draft)?;
        emit(Stage::Skeleton, tokens, &degrade_reason, &mut on_progress);

        // ── 阶段 2 真实生图 ─────────────────────────────────────────────
        // 封面是交付硬条件：任一计划图失败都停止，不把灰模/SVG 当成成功产物。
        self.cloud.capabilities().await?;
        draft.visuals = self.generate_visuals(site_dir, &draft.image_plans).await?;
        write_site(site_dir, &draft)?;
        emit(Stage::Visuals, tokens, "真实位图已生成", &mut on_progress);

        // ── 阶段 3 首屏 ───────────────────────────────────────────────
        match self.hero(&brief, &draft).await {
            Ok((html, used, truncated)) => {
                tokens += used;
                if truncated {
                    cut.push("首屏");
                }
                draft.hero_html = html;
            }
            Err(e) => {
                return Err(format!("首屏生成失败，未使用灰模或 SVG 代替：{e}"));
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
                return Err(format!("内容区生成失败，未使用灰模或 SVG 代替：{e}"));
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
                    format!(
                        "已过 {} 秒软截止，跳过配图精修直接收尾",
                        self.cfg.soft_deadline_secs
                    )
                } else {
                    format!(
                        "token 触顶（{tokens}/{}），跳过配图精修直接收尾",
                        self.cfg.gen_token_budget
                    )
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
            degrade_reason = if degrade_reason.is_empty() {
                note
            } else {
                format!("{degrade_reason}；{note}")
            };
        }

        write_site(site_dir, &draft)?;
        validate_site_assets(site_dir, &draft)?;

        // R4 红线自动检查：产物里绝不能带密钥。
        // 规划书原文要求「上线前搜一遍产物文件里有没有 sk- 开头的字符串，做成自动检查」。
        if let Some(hit) = scan_for_secrets(site_dir)? {
            return Err(format!(
                "产物疑似包含密钥（{hit}），已拦下不予交付。这是规划书 R4 的红线，请检查生成提示词。"
            ));
        }
        let exact = [
            self.cfg.api_key.as_str(),
            self.cfg.tts_key.as_str(),
            self.cloud.exact_secret(),
        ];
        if let Some(hit) = scan_for_exact_values(site_dir, &exact)? {
            return Err(format!("产物包含运行时凭据（{hit}），已拦下不予交付"));
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
            cover_path: "assets/cover.jpg".into(),
            visual_count: draft.visuals.len(),
            visuals: draft.visuals.clone(),
            degraded,
            degrade_reason,
        })
    }

    async fn generate_visuals(
        &self,
        site_dir: &Path,
        plans: &[ImagePlan],
    ) -> Result<Vec<GeneratedVisual>, String> {
        let assets = site_dir.join("assets");
        std::fs::create_dir_all(&assets).map_err(|e| format!("创建图片目录失败：{e}"))?;

        let mut jobs = tokio::task::JoinSet::new();
        // Workers AI 的瞬时容量对并发突发比较敏感。两张并行仍能保持速度，
        // 又不会让一份六图网站同时把六个请求撞到同一网关。
        let image_slots = std::sync::Arc::new(tokio::sync::Semaphore::new(2));
        for (index, plan) in plans.iter().cloned().enumerate() {
            let cloud = self.cloud.clone();
            let image_slots = std::sync::Arc::clone(&image_slots);
            jobs.spawn(async move {
                let bytes = match image_slots.acquire_owned().await {
                    Ok(_permit) => cloud.generate_image(&plan.prompt).await,
                    Err(_) => Err("生图并发控制已关闭".into()),
                };
                (index, plan, bytes)
            });
        }

        let mut generated: Vec<Option<GeneratedVisual>> = vec![None; plans.len()];
        while let Some(joined) = jobs.join_next().await {
            let (index, plan, bytes) = joined.map_err(|e| format!("生图任务异常退出：{e}"))?;
            let bytes = bytes.map_err(|e| format!("图片 {} 生成失败：{e}", plan.slot))?;
            let final_path = assets.join(format!("{}.jpg", plan.slot));
            let part_path = assets.join(format!("{}.jpg.part", plan.slot));
            std::fs::write(&part_path, &bytes).map_err(|e| format!("写生图临时文件失败：{e}"))?;
            if final_path.exists() {
                std::fs::remove_file(&final_path).map_err(|e| format!("替换旧生图失败：{e}"))?;
            }
            std::fs::rename(&part_path, &final_path)
                .map_err(|e| format!("提交生图文件失败：{e}"))?;
            generated[index] = Some(GeneratedVisual {
                slot: plan.slot.clone(),
                path: format!("assets/{}.jpg", plan.slot),
                alt: plan.alt,
                section_id: plan.section_id,
            });
        }

        generated
            .into_iter()
            .enumerate()
            .map(|(i, value)| value.ok_or_else(|| format!("第 {} 张生图没有返回", i + 1)))
            .collect()
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
            "你是一名网页结构设计师。根据需求单，把一个单页网站**规划到能直接开工**的程度。\n\
             只输出 JSON：\n\
             {{\"title\":\"页面标题\",\"tagline\":\"一句话亮点，不超过60字\",\n\
               \"mood\":\"整站气质与视觉基调，一两句，写给后面画首屏、配 CSS 的人看\",\n\
               \"palette\":{{\"bg\":\"#..\",\"surface\":\"#..\",\"text\":\"#..\",\"muted\":\"#..\",\"accent\":\"#..\"}},\n\
               \"sections\":[{{\"id\":\"英文小写短id\",\"heading\":\"中文栏目标题\",\n\
                 \"layout\":\"版式\",\"intent\":\"这一栏放什么\",\n\
                 \"beats\":[\"这一栏必须写到的具体一点\",\"再一点\"]}}],\"image_plans\":[{{\"slot\":\"cover\",\"purpose\":\"hero\",\"prompt\":\"English image prompt\",\"alt\":\"中文替代文字\",\"section_id\":\"\"}}]}}\n\
             规则：\n\
             - sections 4 到 6 个，第一个不要是首屏（首屏单独做）。栏目之间要有递进，\n\
               别把同一件事拆成两栏，也别拿「关于」「联系」这种空壳凑数。\n\
             - layout 只能从这几个里挑：prose 长文 / cards 卡片组 / timeline 时间线 /\n\
               list 清单 / gallery 图块墙 / stats 数字条 / quotes 引语 / faq 问答 / steps 步骤。\n\
               整站不要全用同一种版式，也别硬凑——版式要是这一栏内容天然的样子。\n\
             - beats 每栏 4 到 6 条，写**页面上真的要出现的东西**：具体的事、场景、\n\
               数字、名字、一句能直接印上去的话。不要写「介绍一下背景」这种任务描述。\n\
               需求单没交代的，按题目合理设想，宁可具体也不要套话。\n\
               这几条会原样交给写文案的人照着写——这里写得空，页面就是空的。\n\
             - image_plans 必须 1 到 4 张。第一张 slot 必须是 cover、purpose=hero、section_id 为空；
\
               gallery 或确实需要作品画面的 cards 栏可各加一张，section_id 必须引用上面的真实栏目 id。
\
               prompt 必须是 40–900 字符的英文摄影/插画画面描述，明确 no text, no letters,
\
               no logo, no UI, no QR code；不要让生图模型写标题。alt 用中文准确描述画面。
\
               slot 只用小写字母、数字和连字符，不能重复。
\
             - 配色要和内容气质相符，保证正文与背景对比度足够。\n{NO_EXTERNAL}"
        );
        // max_tokens 给足：1200 时实测 3 次里有 1 次 JSON 在 1342 列被截断，
        // 触发兜底结构（能跑，但栏目规划就白做了）。骨架是后面所有阶段的输入，
        // 这里省 token 是最不划算的。
        // 2200 → 3600：栏目从 3–5 涨到 4–6，每栏还多带 layout + 3–5 条 beats，
        // 光 beats 就比原来整份 JSON 还长，按老额度必然断在 sections 中间。
        let c = self
            .llm
            .complete(&sys, &[Msg::user(brief.to_string())], 4600)
            .await?;
        let json = extract_json(&c.text).ok_or("骨架输出里没有 JSON")?;
        let s: Skeleton =
            serde_json::from_str(json).map_err(|e| format!("骨架 JSON 解析失败：{e}"))?;
        Ok((s, c.usage.total(), c.truncated()))
    }

    async fn hero(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let sys = format!(
            "你是一名网页文案与前端。写这个网站的**首屏区块**。\n\
             只输出一个 ```html 代码块，内容是 <section class=\"hero\"> …… </section>，\n\
             里面要有大标题、一句副标题、以及一两句引子。文案要具体、有人味，\n\
             直接用需求单里用户说过的事，不要写「欢迎来到我的网站」这种空话。\n\
             必须把清单里的 cover 写成真实 <img src=\"assets/cover.jpg\" alt=\"清单中的alt\">，\n\
             可裁切、叠文字或加遮罩，但不许省略、替换路径或生成 SVG。CSS 渐变只做背景光晕。\n\
             可用的配色变量：\n\
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
            "需求单：\n{brief}\n站点标题：{}\n{}可用锚点（只能用这些）：{}\n真实生图清单：\n{}",
            d.title,
            mood_line(&d.mood),
            if anchors.is_empty() {
                "（暂无，不要放跳转按钮）".to_string()
            } else {
                anchors
            },
            visual_lines(&d.visuals),
        );
        // 1600 偏紧：首屏带内联 SVG 装饰时很容易压线
        // 2400 → 3600：k3 写首屏爱铺陈，2400 实测会断在按钮文案中间（2026-08-15 摸鱼案）
        let c = self.llm.complete(&sys, &[Msg::user(user)], 3600).await?;
        Ok((
            close_unclosed(extract_block(&c.text, "html")),
            c.usage.total(),
            c.truncated(),
        ))
    }

    async fn content(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let plan = plan_lines(&d.sections);
        let sys = format!(
            "你是一名网页文案与前端。按给定的栏目计划写出**全部内容区块**。\n\
             只输出一个 ```html 代码块，里面是若干个 <section id=\"...\"> …… </section>，顺序与计划一致。\n\
             计划里的「必须写到」是骨架阶段定好的内容清单，**一条都不许省、不许合并**，\n\
             每条都要在页面上看得见（一张卡片、一个时间点、一条问答……）。\n\
             但它是**下限不是上限**：每条至少展开成一段有细节的文案，写完清单还有话说就接着写。\n\
             一个栏目只有三五行字就是没做完——那正是这份计划要治的毛病。\n\
             版式也照计划来：cards 就真的排成卡片组，timeline 就真的排成时间线，\n\
             stats 就真的给出数字与说明——不要六个栏目全写成一样的段落堆。\n\
             每个栏目都要有真实、具体的文案，宁可短也不要套话。\n\
             用语义化 HTML（ul/ol/figure/blockquote/dl/article）把结构写出来。\n\
             真实生图清单中 section_id 非空的每张图，都必须在对应 section 内用\n\
             <figure><img src=\"清单路径\" alt=\"清单alt\"></figure> 出现；不能挪栏、漏图或编造图片。\n\
             可用的配色变量：var(--bg) var(--surface) var(--text) var(--muted) var(--accent)。\n\
             可以写 <style> 标签补充这些区块自己的样式（卡片网格、时间线竖线之类）。\n{NO_EXTERNAL}"
        );
        let user = format!(
            "需求单：\n{brief}\n{}\n栏目计划：\n{plan}\n真实生图清单：\n{}",
            mood_line(&d.mood),
            visual_lines(&d.visuals),
        );
        // 额度演进史：4000 → 4 栏页面撞上限，正文停在半句话中间、5 个标签没闭合，
        // 而当时 stop_reason 没人读，链路还报「成功、未降级」。
        // 8000 → 文字类够了，但条目密集的题目（一百个色名、按键热力）仍会撞。
        // 这是全篇最长的一段产出，也是唯一直接决定"页面完不完整"的一段，
        // 省这里的 token 是最不划算的。
        // 11000 → 14000：骨架现在给 4–6 栏、每栏 3–5 条必写项，要求"一条都不许省"，
        // 等于把产出量按老额度的上沿又抬了一截。不跟着抬就是自己给自己造截断。
        let c = self.llm.complete(&sys, &[Msg::user(user)], 14000).await?;
        Ok((
            close_unclosed(extract_block(&c.text, "html")),
            c.usage.total(),
            c.truncated(),
        ))
    }

    async fn polish(&self, brief: &str, d: &SiteDraft) -> Result<(String, u64, bool), String> {
        let sys = format!(
            "你是一名前端。给已经成型的页面补一层**精修 CSS**：\n\
             入场动效（要克制）、响应式适配（窄屏单列）、排版细节（行高、字距、留白）、\n\
             以及不冒充作品画面的 CSS 背景光晕、边框与分隔。
\
             禁止 SVG，禁止新增 background-image URL；现有真实生图只能排版、裁切，不能替换。\n\
             只输出一个 ```css 代码块，不要 HTML。不要重设已有配色变量。\n\
             必须包含 @media (max-width: 720px) 的窄屏规则。\n\
             动效一律加 @media (prefers-reduced-motion: reduce) 的关闭分支。\n{NO_EXTERNAL}"
        );
        // 版式一起喂进去：精修要给卡片组补网格、给时间线补竖线，
        // 只告诉它栏目名，它只能瞎猜这一栏长什么样。
        let user = format!(
            "需求单：\n{brief}\n{}栏目：{}",
            mood_line(&d.mood),
            d.sections
                .iter()
                .map(|s| format!("{}（{}）", s.heading, s.layout_or_prose()))
                .collect::<Vec<_>>()
                .join("、")
        );
        // 额度演进史（都是实测打出来的）：
        //   2000 → 5 个用例里 4 个 CSS 停在半条声明上，兜底闸被吞
        //   3000 → 文字类页面够了，但色卡/深海这种视觉密集的题目 6 个里 3 个还在截断
        //   4500 → 星空/深海这种要画渐变、星点、光晕的页面还是正好撞满
        //   6000 → 骨架开始规划版式后，精修要额外给卡片网格、时间线竖线、
        //          数字条各补一套规则，实测（橘猫纪念站）当场撞满被截断
        //   8000 → 当前值
        // 精修现在和内容区**并发**跑，只要它比内容区先回来，加额度的墙钟成本就是 0；
        // 实测内容区普遍 165–210s，精修从没跑赢过它，还有余量。
        let c = self.llm.complete(&sys, &[Msg::user(user)], 8000).await?;
        Ok((
            harden_css(extract_block(&c.text, "css")),
            c.usage.total(),
            c.truncated(),
        ))
    }
}

fn normalize_image_plans(d: &SiteDraft, brief: &str) -> Vec<ImagePlan> {
    let section_ids: std::collections::HashSet<&str> =
        d.sections.iter().map(|s| s.id.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut cover = None;
    let mut sections = Vec::new();

    for mut plan in d.image_plans.iter().cloned() {
        plan.slot = plan.slot.trim().to_ascii_lowercase();
        if !valid_slot(&plan.slot) || seen.contains(&plan.slot) {
            continue;
        }
        plan.prompt = bounded_chars(plan.prompt.trim(), 900);
        if plan.prompt.chars().count() < 20 {
            continue;
        }
        if !plan.prompt.to_ascii_lowercase().contains("no text") {
            plan.prompt
                .push_str(", no text, no letters, no logo, no UI, no QR code");
        }
        plan.alt = bounded_chars(plan.alt.trim(), 120);
        if plan.slot == "cover" {
            seen.insert(plan.slot.clone());
            plan.purpose = "hero".into();
            plan.section_id.clear();
            if plan.alt.is_empty() {
                plan.alt = format!("{}的主题画面", d.title);
            }
            cover = Some(plan);
            continue;
        }
        if section_ids.contains(plan.section_id.trim()) {
            seen.insert(plan.slot.clone());
            plan.purpose = "section".into();
            if plan.alt.is_empty() {
                plan.alt = format!("{}的内容画面", plan.section_id);
            }
            sections.push(plan);
        }
    }

    let cover = cover.unwrap_or_else(|| ImagePlan {
        slot: "cover".into(),
        purpose: "hero".into(),
        prompt: bounded_chars(
            &format!(
                "A cinematic editorial hero image for a personal one-page website titled '{}', inspired by this brief: {}. {}, emotionally specific, polished composition, no text, no letters, no logo, no UI, no QR code",
                d.title,
                brief,
                d.mood,
            ),
            900,
        ),
        alt: format!("{}的主题画面", d.title),
        section_id: String::new(),
    });

    let mut out = vec![cover];
    out.extend(sections.into_iter().take(MAX_VISUALS - 1));
    out
}

fn valid_slot(slot: &str) -> bool {
    let bytes = slot.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn bounded_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn visual_lines(visuals: &[GeneratedVisual]) -> String {
    visuals
        .iter()
        .map(|v| {
            format!(
                "- slot={} path={} section_id={} alt={}",
                v.slot,
                v.path,
                if v.section_id.is_empty() {
                    "（hero）"
                } else {
                    &v.section_id
                },
                v.alt,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 完整解码生成图片，而不是只认前三个 JPEG 魔数字节。
/// 结尾必须正好是 EOI，既拒绝截断文件，也拒绝在图片后夹带任意数据。
pub fn validate_generated_jpeg(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 4
        || bytes.len() > 12 * 1024 * 1024
        || !bytes.starts_with(b"\xff\xd8\xff")
        || !bytes.ends_with(b"\xff\xd9")
    {
        return Err("不是结构完整且不超过 12MB 的 JPEG".into());
    }

    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "JPEG 像素数据损坏或尺寸异常".to_string())?;
    let dimensions = (decoded.width(), decoded.height());
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err("JPEG 像素尺寸为空".into());
    }
    Ok(dimensions)
}

/// 最终站点只允许本次生图清单里的本地 JPEG；任何 SVG、远程图或灰模实例都拒绝。
pub fn validate_site_assets(site_dir: &Path, draft: &SiteDraft) -> Result<(), String> {
    let index = site_dir.join("index.html");
    let html = std::fs::read_to_string(&index).map_err(|e| format!("读取最终页面失败：{e}"))?;
    let lower = html.to_ascii_lowercase();
    for (needle, reason) in [
        ("<svg", "页面含内联 SVG"),
        ("data:image/svg+xml", "页面含 SVG data URI"),
        (".svg", "页面引用 SVG 文件"),
        ("srcset=", "页面含未受控响应式图片清单"),
        ("url(", "页面 CSS 含未受控图片/字体 URL"),
        ("@import", "页面 CSS 含外链导入"),
        ("class=\"gray\"", "页面仍有灰模占位"),
        ("class=\"gray-lines\"", "页面仍有灰模占位"),
        ("class=\"gray-grid\"", "页面仍有灰模占位"),
        ("class=\"gray-rows\"", "页面仍有灰模占位"),
    ] {
        if lower.contains(needle) {
            return Err(format!("最终产物校验失败：{reason}"));
        }
    }

    if draft.visuals.is_empty() || draft.visuals[0].slot != "cover" {
        return Err("最终产物校验失败：缺少必需的真实 cover".into());
    }
    let allowed: std::collections::HashSet<String> =
        draft.visuals.iter().map(|v| v.path.clone()).collect();
    for visual in &draft.visuals {
        let path = site_dir.join(&visual.path);
        let bytes =
            std::fs::read(&path).map_err(|e| format!("读取生图 {} 失败：{e}", visual.path))?;
        validate_generated_jpeg(&bytes)
            .map_err(|e| format!("最终产物校验失败：{} 不是有效 JPEG：{e}", visual.path))?;
    }

    let mut used = std::collections::HashSet::new();
    for tag in parse_opening_tags(&html)? {
        if matches!(
            tag.name.as_str(),
            "script"
                | "link"
                | "iframe"
                | "object"
                | "embed"
                | "base"
                | "source"
                | "video"
                | "audio"
        ) {
            return Err(format!(
                "最终产物校验失败：页面含不允许的 <{}> 标签",
                tag.name
            ));
        }
        if tag
            .attrs
            .iter()
            .any(|(name, _)| name.starts_with("on") || name == "srcdoc")
        {
            return Err(format!("最终产物校验失败：<{}> 含可执行属性", tag.name));
        }
        if tag.attrs.iter().any(|(_, value)| {
            let value = value.trim().to_ascii_lowercase();
            value.starts_with("javascript:") || value.starts_with("data:text/html")
        }) {
            return Err(format!("最终产物校验失败：<{}> 含可执行 URL", tag.name));
        }
        if tag.attr("href").is_some_and(|href| !safe_href(href)) {
            return Err(format!("最终产物校验失败：<{}> 含不安全链接", tag.name));
        }
        if tag.name != "img" && tag.attr("src").is_some() {
            return Err(format!("最终产物校验失败：<{}> 含未授权 src", tag.name));
        }
        if tag.name == "meta"
            && tag
                .attr("http-equiv")
                .is_some_and(|v| v.eq_ignore_ascii_case("refresh"))
        {
            return Err("最终产物校验失败：页面含自动跳转 meta".into());
        }
        if tag.name != "img" {
            continue;
        }
        let src = tag.attr("src").ok_or("最终页面的 <img> 缺少 src")?;
        let alt = tag.attr("alt").ok_or("最终页面的 <img> 缺少 alt")?;
        if alt.trim().is_empty() {
            return Err("最终页面的 <img> alt 不能为空".into());
        }
        if !allowed.contains(src) {
            return Err(format!("最终页面引用了未授权图片：{src}"));
        }
        used.insert(src.to_string());
    }
    if used != allowed {
        let missing = allowed
            .difference(&used)
            .cloned()
            .collect::<Vec<_>>()
            .join("、");
        return Err(format!("最终页面没有完整使用生图清单：{missing}"));
    }

    reject_svg_files(site_dir)?;
    Ok(())
}

#[derive(Debug)]
struct ParsedTag {
    name: String,
    attrs: Vec<(String, String)>,
}

impl ParsedTag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// 针对最终产物的严格开始标签分词器。它按属性边界解析，绝不会把 `data-src`
/// 当成 `src`，也不会依赖属性顺序；重复属性直接拒绝，避免浏览器与校验器取值不同。
fn parse_opening_tags(html: &str) -> Result<Vec<ParsedTag>, String> {
    let lower = html.to_ascii_lowercase();
    let mut tags = Vec::new();
    let mut pos = 0usize;

    while let Some(rel) = html[pos..].find('<') {
        let start = pos + rel;
        if html[start..].starts_with("<!--") {
            let Some(end) = html[start + 4..].find("-->") else {
                return Err("最终页面含未闭合 HTML 注释".into());
            };
            pos = start + 4 + end + 3;
            continue;
        }

        let first = html.as_bytes().get(start + 1).copied();
        if !first.is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'/' | b'!' | b'?')) {
            pos = start + 1;
            continue;
        }
        let end = find_tag_end(html, start + 1).ok_or("最终页面含未闭合标签")?;
        let raw = html[start + 1..end].trim();
        pos = end + 1;
        if raw.starts_with('/') || raw.starts_with('!') || raw.starts_with('?') {
            continue;
        }

        let name_end = raw
            .bytes()
            .position(|b| b.is_ascii_whitespace() || b == b'/')
            .unwrap_or(raw.len());
        let name = raw[..name_end].to_ascii_lowercase();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("最终页面含无法识别的标签名".into());
        }
        let attrs = parse_tag_attrs(&raw[name_end..], &name)?;
        let is_style = name == "style";
        tags.push(ParsedTag { name, attrs });

        // CSS 里的 content 字符串可能含 `<...>`；style 是允许的原始文本元素，
        // 跳到真实闭合标签后再继续分词，避免把 CSS 文本误认成 HTML。
        if is_style {
            let Some(close_rel) = lower[pos..].find("</style") else {
                return Err("最终页面含未闭合 <style>".into());
            };
            let close_start = pos + close_rel;
            let Some(close_end_rel) = html[close_start..].find('>') else {
                return Err("最终页面含未闭合 </style>".into());
            };
            pos = close_start + close_end_rel + 1;
        }
    }
    Ok(tags)
}

fn find_tag_end(html: &str, from: usize) -> Option<usize> {
    let mut quote = None;
    for (rel, ch) in html[from..].char_indices() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (None, '\'' | '"') => quote = Some(ch),
            (None, '>') => return Some(from + rel),
            _ => {}
        }
    }
    None
}

fn parse_tag_attrs(raw: &str, tag_name: &str) -> Result<Vec<(String, String)>, String> {
    let bytes = raw.as_bytes();
    let mut attrs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        while pos < bytes.len() && (bytes[pos].is_ascii_whitespace() || bytes[pos] == b'/') {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        let name_start = pos;
        while pos < bytes.len()
            && !bytes[pos].is_ascii_whitespace()
            && !matches!(bytes[pos], b'=' | b'/')
        {
            pos += 1;
        }
        if pos == name_start {
            return Err(format!("最终页面的 <{tag_name}> 属性格式异常"));
        }
        let name = raw[name_start..pos].to_ascii_lowercase();
        if !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
        {
            return Err(format!("最终页面的 <{tag_name}> 含非法属性名"));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("最终页面的 <{tag_name}> 重复声明属性 {name}"));
        }
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        let mut value = String::new();
        if pos < bytes.len() && bytes[pos] == b'=' {
            pos += 1;
            while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
            if pos >= bytes.len() {
                return Err(format!("最终页面的 <{tag_name}> 属性 {name} 缺少值"));
            }
            if matches!(bytes[pos], b'\'' | b'"') {
                let quote = bytes[pos];
                pos += 1;
                let value_start = pos;
                while pos < bytes.len() && bytes[pos] != quote {
                    pos += 1;
                }
                if pos >= bytes.len() {
                    return Err(format!("最终页面的 <{tag_name}> 属性 {name} 引号未闭合"));
                }
                value = raw[value_start..pos].to_string();
                pos += 1;
            } else {
                let value_start = pos;
                while pos < bytes.len() && !bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
                value = raw[value_start..pos].trim_end_matches('/').to_string();
            }
        }
        attrs.push((name, value));
    }
    Ok(attrs)
}

fn safe_href(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with('#')
        || value.starts_with('/')
        || value.starts_with("https://")
        || value.starts_with("mailto:")
        || value.starts_with("tel:")
}

fn reject_svg_files(dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("检查站点资源失败：{e}"))?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            reject_svg_files(&path)?;
        } else if path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("svg"))
        {
            return Err(format!(
                "最终产物校验失败：发现 SVG 文件 {}",
                path.display()
            ));
        }
    }
    Ok(())
}

/// 把骨架的栏目规划摊成给内容阶段看的清单。
///
/// beats 必须原样带过去。骨架把「必须写到」想好了却只把 intent 传下去，
/// 等于每次都重新赌一次内容阶段的发挥——那正是页面时丰时空的来源。
fn plan_lines(sections: &[SectionPlan]) -> String {
    sections
        .iter()
        .map(|s| {
            let beats = if s.beats.is_empty() {
                String::new()
            } else {
                format!("\n  必须写到：{}", s.beats.join("；"))
            };
            format!(
                "- id={} 标题={} 版式={} 打算放={}{}",
                s.id,
                s.heading,
                s.layout_or_prose(),
                s.intent,
                beats
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 骨架给的整站气质，拼成一行喂给后面的阶段；没有就什么都不加。
fn mood_line(mood: &str) -> String {
    let m = mood.trim();
    if m.is_empty() {
        String::new()
    } else {
        format!("整站气质（首屏、内容、精修共用同一套）：{m}\n")
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
                ..Default::default()
            })
            .collect();
    }
    vec![
        SectionPlan {
            id: "about".into(),
            heading: "关于".into(),
            intent: req.content.clone(),
            ..Default::default()
        },
        SectionPlan {
            id: "content".into(),
            heading: "内容".into(),
            intent: req.content.clone(),
            ..Default::default()
        },
    ]
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 页脚：规划书第 02 节的传播闭环，两个入口固定。
fn render_footer(d: &SiteDraft) -> String {
    let hall = if d.hall_url.trim().is_empty() {
        "#"
    } else {
        d.hall_url.trim()
    };
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
///
/// 占位跟着骨架的 layout 与 beats 走，不是清一色三根灰条：
/// 骨架规划了六栏、其中两栏是卡片组，那第 10 秒屏幕上就该是六栏、两片卡片墙。
/// 这是 R1「十分钟的持续生长是表演」里最便宜的一段演出——
/// 灰模长得越像成品，后面每段内容填进去越像"长出来"而不是"换了一页"。
fn render_gray(d: &SiteDraft) -> String {
    d.sections
        .iter()
        .map(|s| {
            let n = s.weight();
            let body = match s.layout_or_prose() {
                "cards" | "gallery" | "stats" | "steps" => {
                    format!(r#"<div class="gray-grid">{}</div>"#, "<i></i>".repeat(n))
                }
                "timeline" | "list" | "faq" | "quotes" => {
                    format!(r#"<div class="gray-rows">{}</div>"#, "<i></i>".repeat(n))
                }
                _ => format!(r#"<div class="gray-lines">{}</div>"#, "<i></i>".repeat(n)),
            };
            format!(
                r#"<section id="{}" class="gray"><h2>{}</h2>{body}</section>"#,
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
    let html = sanitize_executable_html(&render(d))?;
    std::fs::write(dir.join("index.html"), html).map_err(|e| format!("写 index.html 失败：{e}"))
}

/// 模型偶尔会给锚点补 `onclick` 平滑滚动，或顺手画一枚装饰 SVG。
/// 这些不是作品内容，直接在每次落盘时删掉，比做到最后才整站报废稳定得多；
/// 真正的作品图片仍由后面的 manifest 闸强制要求，绝不会用删除来冒充生图成功。
fn sanitize_executable_html(html: &str) -> Result<String, String> {
    lol_html::rewrite_str(
        html,
        lol_html::RewriteStrSettings {
            element_content_handlers: vec![
                lol_html::element!(
                    "script, svg, iframe, object, embed, base, link, source, video, audio",
                    |element| {
                        element.remove();
                        Ok(())
                    }
                ),
                lol_html::element!("*", |element| {
                    if element.tag_name() == "meta"
                        && element
                            .get_attribute("http-equiv")
                            .is_some_and(|v| v.eq_ignore_ascii_case("refresh"))
                    {
                        element.remove();
                        return Ok(());
                    }

                    let names = element
                        .attributes()
                        .iter()
                        .map(|attr| attr.name().to_ascii_lowercase())
                        .collect::<Vec<_>>();
                    for name in names {
                        let value = element.get_attribute(&name).unwrap_or_default();
                        let lower = value.trim().to_ascii_lowercase();
                        let executable = name.starts_with("on")
                            || name == "srcdoc"
                            || lower.starts_with("javascript:")
                            || lower.starts_with("data:text/html")
                            || (name == "style" && lower.contains("url("));
                        let unsafe_href = name == "href" && !safe_href(&value);
                        let foreign_src = name == "src" && element.tag_name() != "img";
                        if executable || unsafe_href || foreign_src {
                            element.remove_attribute(&name);
                        }
                    }
                    Ok(())
                }),
            ],
            ..Default::default()
        },
    )
    .map_err(|e| format!("清理模型 HTML 失败：{e}"))
}

pub fn render(d: &SiteDraft) -> String {
    let p = &d.palette;
    let hero = if d.hero_html.trim().is_empty() {
        let cover = d
            .visuals
            .iter()
            .find(|v| v.slot == "cover")
            .map(|v| format!(r#"<img src="{}" alt="{}">"#, esc(&v.path), esc(&v.alt)))
            .unwrap_or_default();
        format!(
            r#"<section class="hero gray"><h1>{}</h1>{cover}<div class="gray-lines"><i></i><i></i></div></section>"#,
            esc(&d.title)
        )
    } else {
        d.hero_html.clone()
    };
    let body = if d.sections_html.trim().is_empty() {
        render_gray(d)
    } else {
        d.sections_html.clone()
    };
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
img{{max-width:100%;height:auto}}
a{{color:var(--accent)}}
section{{max-width:920px;margin:0 auto;padding:64px 24px}}
h1{{font-size:clamp(30px,6vw,54px);line-height:1.2;margin:0 0 16px}}
h2{{font-size:clamp(21px,3.4vw,30px);margin:0 0 18px}}
.site-nav{{position:sticky;top:0;z-index:9;display:flex;gap:20px;flex-wrap:wrap;
  padding:14px 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid color-mix(in srgb,var(--text) 12%,transparent)}}
.site-nav a{{color:var(--muted);text-decoration:none;font-size:14px}}
.site-nav a:hover{{color:var(--accent)}}
/* 灰模：骨架阶段的占位，真实内容到位后被替换。
   三种形状对应骨架规划的版式，让第一屏灰模就已经是成品的轮廓 */
.gray-lines i{{display:block;height:13px;border-radius:7px;margin:11px 0;
  background:color-mix(in srgb,var(--text) 11%,transparent)}}
.gray-lines i:nth-child(2){{width:82%}} .gray-lines i:nth-child(3){{width:58%}}
.gray-grid{{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}
.gray-grid i{{display:block;height:104px;border-radius:12px;
  background:color-mix(in srgb,var(--text) 8%,transparent)}}
.gray-rows i{{display:block;height:46px;border-radius:10px;margin:10px 0;
  background:color-mix(in srgb,var(--text) 8%,transparent)}}
.gray-rows i:nth-child(even){{width:88%}}
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
        let Some(close) = rest[open..].find('}').map(|i| open + i) else {
            break;
        };
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
    let cut = css
        .rfind(|c| c == ';' || c == '{' || c == '}')
        .map(|i| i + 1)
        .unwrap_or(0);
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
                "none"
                    | "forwards"
                    | "backwards"
                    | "both"
                    | "infinite"
                    | "alternate"
                    | "linear"
                    | "ease"
                    | "ease-in"
                    | "ease-out"
                    | "ease-in-out"
                    | "normal"
                    | "reverse"
                    | "alternate-reverse"
                    | "running"
                    | "paused"
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
        .filter(|decl| match decl.split_once(':') {
            Some((p, v)) if p.trim() == "opacity" => {
                v.trim()
                    .trim_end_matches("!important")
                    .trim()
                    .parse::<f32>()
                    != Ok(0.0)
            }
            _ => true,
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
        let Ok(body) = std::fs::read_to_string(&p) else {
            continue;
        };
        for n in NEEDLES {
            if body.contains(n) {
                return Ok(Some(format!("{} 里出现 {n}", p.display())));
            }
        }
    }
    Ok(None)
}

/// 扫当前运行时真正使用的凭据值；与前缀扫描互补，捕捉无固定前缀的发布 token。
pub fn scan_for_exact_values(dir: &Path, secrets: &[&str]) -> Result<Option<String>, String> {
    let secrets: Vec<&[u8]> = secrets
        .iter()
        .map(|s| s.trim().as_bytes())
        .filter(|s| s.len() >= 8)
        .collect();
    if secrets.is_empty() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("扫描产物目录失败：{e}"))?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            if let Some(hit) = scan_for_exact_values(
                &path,
                secrets
                    .iter()
                    .map(|s| std::str::from_utf8(s).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .as_slice(),
            )? {
                return Ok(Some(hit));
            }
            continue;
        }
        let Ok(body) = std::fs::read(&path) else {
            continue;
        };
        if secrets
            .iter()
            .any(|needle| body.windows(needle.len()).any(|w| w == *needle))
        {
            return Ok(Some(format!("{} 里出现精确凭据值", path.display())));
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
                SectionPlan {
                    id: "photos".into(),
                    heading: "照片".into(),
                    intent: "老照片".into(),
                    ..Default::default()
                },
                SectionPlan {
                    id: "story".into(),
                    heading: "故事".into(),
                    intent: "日常".into(),
                    ..Default::default()
                },
            ],
            hall_url: "https://hall.example".into(),
            ..Default::default()
        }
    }

    fn planned(id: &str, layout: &str, beats: &[&str]) -> SectionPlan {
        SectionPlan {
            id: id.into(),
            heading: id.into(),
            intent: "略".into(),
            layout: layout.into(),
            beats: beats.iter().map(|s| s.to_string()).collect(),
        }
    }

    // ── 骨架规划要一路传到底 ──────────────────────────────────────
    // 骨架是全链路最便宜的一段，也是唯一一段"想清楚"的机会。
    // 它规划出来的版式与必写项，只要有一环没传下去，就退回成
    // 「每栏三行套话」——页面看着完整，其实什么都没说。

    #[test]
    fn beats_reach_the_content_stage_verbatim() {
        let plan = plan_lines(&[planned(
            "days",
            "timeline",
            &["2008年春天捡到它", "最后那个冬天"],
        )]);
        assert!(plan.contains("版式=timeline"), "版式要跟着走：{plan}");
        assert!(
            plan.contains("2008年春天捡到它"),
            "必写项一个字都不能丢：{plan}"
        );
        assert!(plan.contains("最后那个冬天"), "{plan}");
    }

    #[test]
    fn unknown_layout_degrades_to_prose() {
        // 模型自造版式名（"masonry"、"英雄区"）是常事，不能让它漏到提示词里
        // 变成内容阶段照着瞎猜的一个词
        assert_eq!(planned("x", "masonry", &[]).layout_or_prose(), "prose");
        assert_eq!(planned("x", "", &[]).layout_or_prose(), "prose");
        assert_eq!(planned("x", "cards", &[]).layout_or_prose(), "cards");
    }

    #[test]
    fn gray_model_takes_the_shape_the_skeleton_planned() {
        // 第 10 秒屏幕上就该是成品的轮廓：卡片栏是卡片墙，时间线是一行行，
        // 而不是清一色三根灰条。灰模越像成品，后面填内容才像"长出来"。
        let mut d = draft();
        d.sections = vec![
            planned("works", "cards", &["a", "b", "c", "d"]),
            planned("days", "timeline", &["x", "y", "z"]),
            planned("about", "prose", &[]),
        ];
        let html = render(&d);
        assert!(
            html.contains(r#"<div class="gray-grid">"#),
            "卡片栏要铺成网格：{html}"
        );
        let grid = html.split(r#"<div class="gray-grid">"#).nth(1).unwrap();
        let grid = &grid[..grid.find("</div>").unwrap()];
        assert_eq!(
            grid.matches("<i>").count(),
            4,
            "占位块数量要跟着规划的条数走"
        );
        assert!(
            html.contains(r#"<div class="gray-rows">"#),
            "时间线要铺成一行行"
        );
        assert!(
            html.contains(r#"<div class="gray-lines">"#),
            "长文栏还是灰条"
        );
        assert!(html.contains(".gray-grid{"), "对应的样式要在基础样式表里");
    }

    #[test]
    fn mood_is_shared_but_optional() {
        // 首屏、内容、精修共用同一句气质描述，不然三段各画各的
        assert!(mood_line("克制的暖色，纸质感").contains("克制的暖色"));
        assert!(
            mood_line("   ").is_empty(),
            "没规划气质时不要塞一行空提示进提示词"
        );
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
        assert!(
            !fixed.contains(r#"class="num"#),
            "没写完的标签必须砍掉：{fixed}"
        );
        assert!(
            fixed.ends_with("</div></section>"),
            "砍完还要补齐闭合：{fixed}"
        );
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
        assert!(
            !fixed.contains("border-bottom:"),
            "半条声明要切掉，别补成 `border-bottom:}}`：{fixed}"
        );
        assert!(fixed.contains("color:var(--gold)"), "写完的声明不许丢");
    }

    #[test]
    fn orphan_selector_at_eof_is_dropped() {
        // portfolio / cafe 的真实断法：末尾剩一个光秃秃的选择器
        let bad = ".project-card:nth-child(1){animation-delay:.1s}\n.project";
        let fixed = close_unclosed_braces(bad);
        assert!(
            !fixed.trim_end().ends_with(".project"),
            "孤儿选择器会把后面的规则吞成选择器串：{fixed}"
        );
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
        assert_eq!(
            depth, 0,
            "兜底闸之前的括号必须已经配平，否则它会被吞掉：\n{out}"
        );
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
        let seq = [
            Stage::Skeleton,
            Stage::Visuals,
            Stage::Hero,
            Stage::Content,
            Stage::Footer,
            Stage::Polish,
            Stage::Done,
        ];
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
        // 兜底栏目没有规划过，版式要落回长文而不是带着空字符串跑
        assert_eq!(s[0].layout_or_prose(), "prose");

        // 需求单里连栏目都没有，也得给出可渲染的结构
        let bare = Requirement {
            title: "t".into(),
            content: "c".into(),
            ..Default::default()
        };
        assert_eq!(fallback_sections(&bare).len(), 2);
    }

    #[test]
    fn harden_keeps_working_animations_intact() {
        // 关键帧定义齐全 —— 一个字都不该动，动效是加分项
        let css = "header,section{opacity:0;animation:fadeUp .9s forwards}\
                   @keyframes fadeUp{from{opacity:0}to{opacity:1}}";
        let out = harden_css(css);
        assert!(
            out.contains("opacity:0;animation:fadeUp"),
            "正常动效被误伤了：{out}"
        );
    }

    #[test]
    fn harden_strips_opacity_when_keyframes_are_missing() {
        // 关键帧名拼错 → 动画永不执行 → opacity:0 永久生效 → 整页空白
        let css = "section{opacity:0;animation:fadeUpp .9s forwards}\
                   @keyframes fadeUp{from{opacity:0}to{opacity:1}}";
        let out = harden_css(css);
        assert!(
            out.contains("section{animation:fadeUpp"),
            "打底 opacity 应被剥掉：{out}"
        );
        // 关键帧内部的 from{opacity:0} 是合法的，必须原样留着
        assert!(
            out.contains("@keyframes fadeUp{from{opacity:0}"),
            "误伤了关键帧：{out}"
        );
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
    fn image_plans_always_have_one_real_cover_and_stay_bounded() {
        let mut d = draft();
        d.image_plans = (0..8)
            .map(|i| ImagePlan {
                slot: format!("scene-{i}"),
                purpose: "section".into(),
                prompt: "Editorial documentary photograph with warm natural light, no text".into(),
                alt: format!("场景 {i}"),
                section_id: if i % 2 == 0 {
                    "photos".into()
                } else {
                    "missing".into()
                },
            })
            .collect();
        let plans = normalize_image_plans(&d, "一只猫的十八年回忆");
        assert_eq!(
            plans[0].slot, "cover",
            "模型漏掉 cover 时必须补一张真实生图计划"
        );
        assert!(plans.len() <= MAX_VISUALS);
        assert!(plans.iter().skip(1).all(|p| p.section_id == "photos"));
        assert!(plans
            .iter()
            .all(|p| p.prompt.to_ascii_lowercase().contains("no text")));
    }

    #[test]
    fn invalid_and_duplicate_image_slots_are_filtered() {
        let mut d = draft();
        d.image_plans = vec![
            ImagePlan {
                slot: "../cover".into(),
                prompt: "A long enough unsafe path prompt for an editorial photo".into(),
                ..Default::default()
            },
            ImagePlan {
                slot: "cover".into(),
                purpose: "anything".into(),
                prompt: "A quiet cinematic portrait of an orange cat by a window, no text".into(),
                alt: "窗边的橘猫".into(),
                section_id: "photos".into(),
            },
            ImagePlan {
                slot: "cover".into(),
                prompt: "A duplicate cover that must not replace the first valid one, no text"
                    .into(),
                alt: "重复图".into(),
                ..Default::default()
            },
        ];
        let plans = normalize_image_plans(&d, "brief");
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].slot, "cover");
        assert_eq!(plans[0].alt, "窗边的橘猫");
        assert!(plans[0].section_id.is_empty());
    }

    fn raster_site(html: &str, visuals: Vec<GeneratedVisual>) -> (PathBuf, SiteDraft) {
        let dir = std::env::temp_dir().join(format!("yiju-raster-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), html).unwrap();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
            .encode(&[24, 48, 72], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        for visual in &visuals {
            std::fs::write(dir.join(&visual.path), &jpeg).unwrap();
        }
        (
            dir,
            SiteDraft {
                visuals,
                ..Default::default()
            },
        )
    }

    fn cover_visual() -> GeneratedVisual {
        GeneratedVisual {
            slot: "cover".into(),
            path: "assets/cover.jpg".into(),
            alt: "真实生图封面".into(),
            section_id: String::new(),
        }
    }

    #[test]
    fn final_asset_gate_accepts_only_the_generated_raster_manifest() {
        let (dir, d) = raster_site(
            r#"<!doctype html><img src="assets/cover.jpg" alt="真实生图封面">"#,
            vec![cover_visual()],
        );
        assert!(validate_site_assets(&dir, &d).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn final_asset_gate_rejects_svg_remote_unplanned_and_missing_alt() {
        for html in [
            r#"<svg></svg><img src="assets/cover.jpg" alt="图">"#,
            r#"<img src="https://images.example/a.jpg" alt="远程图">"#,
            r#"<img src="assets/other.jpg" alt="未规划图">"#,
            r#"<img src="assets/cover.jpg" alt="">"#,
        ] {
            let (dir, d) = raster_site(html, vec![cover_visual()]);
            assert!(validate_site_assets(&dir, &d).is_err(), "本应拒绝：{html}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn model_markup_is_sanitized_instead_of_failing_the_whole_site() {
        let dirty = r##"<section><a href="#join" onclick="scrollIntoView()">加入</a><svg><path></path></svg><script>alert(1)</script><p>正文保留</p></section>"##;
        let clean = sanitize_executable_html(dirty).unwrap();
        assert!(clean.contains("正文保留"));
        assert!(clean.contains("href=\"#join\""));
        assert!(!clean.to_ascii_lowercase().contains("onclick"));
        assert!(!clean.to_ascii_lowercase().contains("<script"));
        assert!(!clean.to_ascii_lowercase().contains("<svg"));
    }

    #[test]
    fn final_asset_gate_rejects_attribute_order_and_boundary_bypasses() {
        for html in [
            r#"<script defer src="https://attacker.example/x.js"></script><img src="assets/cover.jpg" alt="图">"#,
            r#"<link href="https://attacker.example/x.css" rel="stylesheet"><img src="assets/cover.jpg" alt="图">"#,
            r#"<img data-src="assets/cover.jpg" src="https://attacker.example/x.jpg" alt="图">"#,
            r#"<img src="assets/cover.jpg" src="assets/other.jpg" alt="图">"#,
            r##"<a href="java&#x73;cript:alert(1)">点我</a><img src="assets/cover.jpg" alt="图">"##,
            r#"<img src="assets/cover.jpg" alt="图" onerror="alert(1)">"#,
        ] {
            let (dir, d) = raster_site(html, vec![cover_visual()]);
            assert!(validate_site_assets(&dir, &d).is_err(), "本应拒绝：{html}");
            let _ = std::fs::remove_dir_all(dir);
        }

        let scene = GeneratedVisual {
            slot: "scene".into(),
            path: "assets/scene.jpg".into(),
            alt: "真实场景".into(),
            section_id: "story".into(),
        };
        let (dir, d) = raster_site(
            r#"<img src="assets/cover.jpg" alt="图"><!-- assets/scene.jpg -->"#,
            vec![cover_visual(), scene],
        );
        assert!(
            validate_site_assets(&dir, &d).is_err(),
            "注释不能冒充图片引用"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn generated_jpeg_must_decode_completely() {
        let (dir, d) = raster_site(
            r#"<img src="assets/cover.jpg" alt="图">"#,
            vec![cover_visual()],
        );
        std::fs::write(dir.join("assets/cover.jpg"), b"\xff\xd8\xff").unwrap();
        assert!(validate_site_assets(&dir, &d).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exact_secret_scan_reaches_binary_and_nested_files() {
        let dir = std::env::temp_dir().join(format!("yiju-exact-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("index.html"), "clean").unwrap();
        assert!(scan_for_exact_values(&dir, &["publish-token-12345"])
            .unwrap()
            .is_none());
        std::fs::write(
            dir.join("nested/image.jpg"),
            b"jpeg publish-token-12345 bytes",
        )
        .unwrap();
        assert!(scan_for_exact_values(&dir, &["publish-token-12345"])
            .unwrap()
            .is_some());
        let _ = std::fs::remove_dir_all(dir);
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
