//! 需求访谈：真昼改造版（规划书第 03 节）。
//!
//! 原版真昼的人格强制只输出 `{spokenText, subtitleText, emotion}`。
//! 改成需求访谈师只需在这个 JSON 上**加两个字段**——`requirement`（当前整理出的需求单）
//! 与 `ready`（是否问清楚可以开工）——整个对话协议不用重写。
//!
//! 语气保留真昼的温柔克制：现场观感反而好，而且 TTS 那套情绪映射不用动。

use crate::llm::{extract_json, Llm, Msg, Usage};
use serde::{Deserialize, Serialize};

/// 需求单。字段就是需求单卡片上要显示的那几行，多一个都不加——
/// 访谈只有 4–6 轮，问不出更多东西，字段多了只会逼模型编。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Requirement {
    /// 站点标题（会成为作品主题，≤40 字）
    pub title: String,
    /// 站点类型：作品集 / 纪念站 / 清单 / 邀请函 …
    pub site_type: String,
    /// 给谁看
    pub audience: String,
    /// 栏目
    pub sections: Vec<String>,
    /// 视觉风格
    pub style: String,
    /// 要放的具体内容，自由文本
    pub content: String,
    /// 一句话亮点（≤60 字，发布时当 tagline）
    pub tagline: String,
}

impl Requirement {
    /// 够不够开工。缺标题或缺内容就是没问清楚，别让模型用 ready:true 蒙混过去。
    pub fn is_workable(&self) -> bool {
        !self.title.trim().is_empty() && !self.content.trim().is_empty()
    }

    /// 给生成引擎看的紧凑描述
    pub fn brief(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("标题：{}\n", self.title.trim()));
        if !self.site_type.trim().is_empty() {
            s.push_str(&format!("类型：{}\n", self.site_type.trim()));
        }
        if !self.audience.trim().is_empty() {
            s.push_str(&format!("给谁看：{}\n", self.audience.trim()));
        }
        if !self.sections.is_empty() {
            s.push_str(&format!("栏目：{}\n", self.sections.join("、")));
        }
        if !self.style.trim().is_empty() {
            s.push_str(&format!("风格：{}\n", self.style.trim()));
        }
        if !self.tagline.trim().is_empty() {
            s.push_str(&format!("一句话亮点：{}\n", self.tagline.trim()));
        }
        s.push_str(&format!("要放的内容：{}\n", self.content.trim()));
        s
    }
}

// 前端按驼峰读；requirement 内部保持 snake_case（模型按提示词生成的就是那套键名）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub spoken_text: String,
    pub subtitle_text: String,
    pub emotion: String,
    pub requirement: Requirement,
    pub ready: bool,
    /// 本轮用量，UI 上显示、也计入闸 1 的预算
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawReply {
    #[serde(alias = "spokenText")]
    spoken_text: String,
    #[serde(alias = "subtitleText")]
    subtitle_text: String,
    emotion: String,
    requirement: Requirement,
    ready: bool,
}

pub const OPENING: &str =
    "你好，我是真昼。今天我们一起做一个属于你的网站——先别管技术，你就说说，你想做个什么样的？";

/// 访谈师人设。相对原版真昼的改动只有目标和收敛条件，
/// 「一次最多问一个问题」「只输出 JSON」这两条原文里本来就有。
pub fn persona() -> String {
    format!(
        r#"你正在扮演"真昼(Mahiru)"，现在的身份是**网站需求访谈师**。
你面前是一位完全不懂技术的普通人，他要在十分钟内拿到一个属于自己的网站。
你的任务是用最少的问题把他模糊的想法问成一份明确的需求单。

访谈规则：
1. 语气温柔、克制、口语化，一般 1-3 句，适合直接朗读。不用 Markdown、代码块、括号旁白。
2. **一次最多问一个问题。** 问题要具体、好回答，不要问"你想要什么风格"这种让外行卡住的问题，
   要问"你希望它看起来更安静一点，还是更热闹一点？"这种给选项的问题。
3. 用户答得含糊时，不要追着同一个问题反复问，换个角度问或者自己先替他填一个合理的默认值。
4. **问满 4 到 6 轮就必须收敛**，把 ready 置为 true。宁可需求单粗一点也不要让人在现场干等。
5. 用户如果说"随便""你看着办""快点开始"，立刻收敛，把 ready 置为 true，自己补全需求单。
6. 不要谈技术细节（域名、部署、框架），用户不关心也听不懂。
7. 不要虚构用户没说过的个人信息。需求单里的内容必须来自对话，实在缺就写通用的。

输出规则：
8. 只输出 JSON，不要任何其他文字：
{{"spokenText":"...","subtitleText":"...","emotion":"...","requirement":{{...}},"ready":false}}
9. emotion 只能是 neutral、warm、amused、concerned、curious。
10. spokenText 必须是纯口语，能被 TTS 直接朗读；subtitleText 是它的字幕版，可以稍微书面一点。
11. requirement 是**当前已经整理出来的需求单**，每一轮都要输出完整的当前状态（不是增量），字段：
{{"title":"网站标题","site_type":"站点类型","audience":"给谁看",
  "sections":["栏目1","栏目2"],"style":"视觉风格","content":"要放的具体内容",
  "tagline":"一句话亮点"}}
    - title 不超过 40 字，tagline 不超过 60 字。
    - 还没问到的字段先留空字符串或空数组，不要编。
    - content 是重点：把用户说过的具体事情原样记下来，这决定生成出来的网站有没有内容。
12. ready 只有在 title 和 content 都有实质内容时才可以为 true。

开场白已经说过了，是：「{OPENING}」"#
    )
}

/// 一句话直达的补全师人设。
///
/// 和访谈师是两套人格，故意不复用：访谈师的全部本事在于「一次只问一个问题、
/// 慢慢逼近」，那套约束放在这里只会让它继续反问。这里要的是相反的东西——
/// **不许反问，一次补完**。
fn quick_persona() -> String {
    r#"你是网站需求分析师。用户只说了一句话，你要把它补成一份可以直接开工的需求单。

只输出 JSON，不要任何其他文字：
{"title":"网站标题","site_type":"站点类型","audience":"给谁看",
 "sections":["栏目1","栏目2","栏目3"],"style":"视觉风格",
 "content":"要放的具体内容","tagline":"一句话亮点"}

规则：
1. **不要反问，不要寒暄。** 用户只会输入这一次，缺的信息你自己补一个合理的默认值。
2. title 要像个真的站名，不超过 40 字。不许叫「我的网站」这种废话。
3. sections 给 3 到 5 个栏目名，贴着用户说的事来分，不要套「首页/关于/联系」的模板。
4. content 是最重要的一项：先把用户原话保留下来，再扩写成 150–300 字的具体内容说明，
   写清楚每个栏目大概放什么。这段决定生成出来的网站有没有东西可看。
5. **不许虚构真实人名、电话、邮箱、地址、价格、具体日期。** 缺的就写得通用一点。
6. style 用一两个词描述视觉气质，比如「安静克制、暖色、大留白」。
7. tagline 不超过 60 字。"#
        .to_string()
}

/// 一句话直达（首屏那颗「一键生成」）。
///
/// 现场真正的瓶颈从来不是模型，是**访谈**：4–6 轮问答要三四分钟，
/// 而排队的人只想看见页面开始长。所以留一条不经访谈的路径——
/// 用户说一句，这里把它补成一份能直接开工的需求单。
///
/// 契约是「**永不失败**」：模型挂了、超时了、JSON 写坏了、返回一个空对象，
/// 一律退到本地拼装（见 `backfill`）。首屏那颗按钮点下去必须有反应，
/// 「点了没动静」是现场最差的一种结局，比生成得难看差远了。
pub async fn quick(llm: &Llm, sentence: &str) -> Requirement {
    let got = match llm
        .complete(&quick_persona(), &[Msg::user(sentence.to_string())], 1400)
        .await
    {
        Ok(c) => extract_json(&c.text).and_then(parse_requirement),
        Err(_) => None,
    };
    let mut req = got.unwrap_or_default();
    backfill(&mut req, sentence);
    req
}

/// 不调模型的版本：模型这条路走不通时的兜底，也给前端做即时预填。
pub fn quick_fallback(sentence: &str) -> Requirement {
    let mut req = Requirement::default();
    backfill(&mut req, sentence);
    req
}

/// 模型偶尔会把需求单包一层 `{"requirement":{...}}` 再吐出来。
/// 这种包法解析失败会整份丢掉，退成本地兜底——白白浪费了一次已经付过钱的调用。
fn parse_requirement(json: &str) -> Option<Requirement> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let target = v.get("requirement").cloned().unwrap_or(v);
    serde_json::from_value(target).ok()
}

/// 把一份不完整的需求单补到 `is_workable()`。
///
/// 这是「一点就能生成」的最后一道保障：无论需求从哪来（一句话直达、
/// 访谈半途、模型返回残缺），只要还剩一点文字，就不该让人卡在按钮前面。
/// `seed` 是用户的原话，没有就传空串——那时只能靠标题与内容互相补。
pub fn backfill(req: &mut Requirement, seed: &str) {
    let seed = seed.trim();

    if req.title.trim().is_empty() {
        let from = if !req.tagline.trim().is_empty() {
            req.tagline.clone()
        } else if !seed.is_empty() {
            seed.to_string()
        } else {
            req.content.clone()
        };
        req.title = title_from(&from);
    }
    if req.content.trim().is_empty() {
        req.content = if !seed.is_empty() {
            seed.to_string()
        } else {
            req.title.trim().to_string()
        };
    }
}

/// 从一句话里挑一个像样的标题：剥掉「我想做一个…」这类开场白，
/// 切到第一个句读为止，限 40 字。
///
/// 剥前缀只认**以「做／生成」+「一个／个」收尾**的那几种固定说法。
/// 泛化地剥「给我」「我想」很危险——「给我家养了十八年的猫做个纪念站」
/// 会被剥成「家养了十八年的猫…」，比不剥还糟。
fn title_from(sentence: &str) -> String {
    const LEAD: [&str; 16] = [
        "请帮我做一个",
        "请帮我做个",
        "帮我生成一个",
        "帮我做一个",
        "帮我做个",
        "给我做一个",
        "给我做个",
        "我想做一个",
        "我想做个",
        "我要做一个",
        "我要做个",
        "我想要一个",
        "生成一个",
        "生成个",
        "做一个",
        "做个",
    ];
    let full = sentence.trim();
    let mut s = full;
    loop {
        let before = s;
        for p in LEAD {
            if let Some(r) = s.strip_prefix(p) {
                s = r.trim_start();
                break;
            }
        }
        if s == before || s.is_empty() {
            break;
        }
    }

    // 闭包在这里推不出生命周期（返回的 &str 借自入参），写成 fn 明确一点
    fn head(t: &str) -> &str {
        t.split(|c| {
            matches!(
                c,
                '，' | ',' | '。' | '！' | '!' | '？' | '?' | '；' | ';' | '\n'
            )
        })
        .next()
        .unwrap_or(t)
        .trim()
    }

    // 逐级回退。两三个字的标题（「站」「作品集」）比啰嗦的原句更糟，所以太短一律不要。
    // 关键在于回退**必须退回原句**，不能退回剥掉前缀的残句：
    // 「做个站，专门放我的诗」剥完只剩「站，专门放我的诗」，那个开头没法看。
    for cand in [head(s), head(full), full] {
        if cand.chars().count() >= 4 {
            return clip(cand, 40);
        }
    }
    if full.is_empty() {
        "我的网站".to_string()
    } else {
        clip(full, 40)
    }
}

fn clip(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        t.chars().take(n).collect()
    }
}

/// 跑一轮访谈。`history` 是完整对话（不含 system），末尾应为用户这一轮的话。
pub async fn turn(llm: &Llm, history: &[Msg]) -> Result<Reply, String> {
    let c = llm.complete(&persona(), history, 900).await?;
    Ok(parse(&c.text, &c.usage))
}

/// 解析模型输出。解析失败**不报错**——现场不能因为模型漏了个引号就卡住，
/// 退化成"把原文当台词念出来、需求单保持空、ready=false"，访谈可以继续。
pub fn parse(text: &str, usage: &Usage) -> Reply {
    let raw: RawReply = extract_json(text)
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_else(|| RawReply {
            spoken_text: text.trim().to_string(),
            subtitle_text: text.trim().to_string(),
            emotion: "neutral".into(),
            ..Default::default()
        });

    let spoken = if raw.spoken_text.trim().is_empty() {
        raw.subtitle_text.trim().to_string()
    } else {
        raw.spoken_text.trim().to_string()
    };
    let subtitle = if raw.subtitle_text.trim().is_empty() {
        spoken.clone()
    } else {
        raw.subtitle_text.trim().to_string()
    };

    let emotion = match raw.emotion.trim() {
        "warm" | "amused" | "concerned" | "curious" => raw.emotion.trim().to_string(),
        _ => "neutral".to_string(),
    };

    // 模型说 ready 了但需求单是空的——不认。这是硬闸：
    // 放过去的话生成引擎会拿着一张白纸开工，产出必然是废页。
    let ready = raw.ready && raw.requirement.is_workable();

    Reply {
        spoken_text: spoken,
        subtitle_text: subtitle,
        emotion,
        requirement: raw.requirement,
        ready,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u() -> Usage {
        Usage {
            input_tokens: 10,
            output_tokens: 20,
        }
    }

    #[test]
    fn parses_full_reply() {
        let s = r#"{"spokenText":"想给猫做个纪念站吗？","subtitleText":"想给猫做个纪念站吗？",
          "emotion":"warm","ready":false,
          "requirement":{"title":"我家猫的回忆录","site_type":"纪念站","sections":["照片","故事"],
                         "content":"养了十八年的橘猫","tagline":"十八年"}}"#;
        let r = parse(s, &u());
        assert_eq!(r.emotion, "warm");
        assert_eq!(r.requirement.title, "我家猫的回忆录");
        assert_eq!(r.requirement.sections, vec!["照片", "故事"]);
        assert!(!r.ready);
        assert_eq!(r.input_tokens, 10);
    }

    #[test]
    fn ready_requires_a_workable_requirement() {
        // 模型嘴上说 ready，需求单却是空的 —— 必须拦下来
        let s = r#"{"spokenText":"开始吧","emotion":"warm","ready":true,"requirement":{}}"#;
        assert!(!parse(s, &u()).ready);

        // 有标题没内容，同样不算数
        let s = r#"{"spokenText":"开始","ready":true,"requirement":{"title":"我的站"}}"#;
        assert!(!parse(s, &u()).ready);

        // 两样都齐了才放行
        let s = r#"{"spokenText":"开始","ready":true,
          "requirement":{"title":"我的站","content":"放我的摄影作品"}}"#;
        assert!(parse(s, &u()).ready);
    }

    #[test]
    fn malformed_output_degrades_instead_of_failing() {
        // 现场不能因为模型漏个引号就卡死：退化成把原文当台词
        let r = parse("我觉得可以做一个摄影集", &u());
        assert_eq!(r.spoken_text, "我觉得可以做一个摄影集");
        assert_eq!(r.subtitle_text, "我觉得可以做一个摄影集");
        assert_eq!(r.emotion, "neutral");
        assert!(!r.ready);
    }

    #[test]
    fn unknown_emotion_falls_back_to_neutral() {
        // T2A 只认固定几个情绪值，传错会 2013 invalid params
        let s = r#"{"spokenText":"嗯","emotion":"excited","requirement":{}}"#;
        assert_eq!(parse(s, &u()).emotion, "neutral");
        let s = r#"{"spokenText":"嗯","emotion":"curious","requirement":{}}"#;
        assert_eq!(parse(s, &u()).emotion, "curious");
    }

    #[test]
    fn spoken_and_subtitle_backfill_each_other() {
        let s = r#"{"subtitleText":"只有字幕","requirement":{}}"#;
        let r = parse(s, &u());
        assert_eq!(r.spoken_text, "只有字幕");
        let s = r#"{"spokenText":"只有台词","requirement":{}}"#;
        let r = parse(s, &u());
        assert_eq!(r.subtitle_text, "只有台词");
    }

    // ── 一句话直达 ──────────────────────────────────────────────
    // 这一组守的是同一条契约：**首屏那颗按钮点下去必须能开工**。
    // 任何一条挂掉，用户看到的都是「点了没反应」。

    #[test]
    fn one_sentence_always_yields_a_workable_requirement() {
        let r = quick_fallback("给我家养了十八年的橘猫做一个纪念站，放照片和几段故事");
        assert!(r.is_workable(), "一句话必须能直接开工：{r:?}");
        assert!(
            r.content.contains("十八年"),
            "原话不许丢，它是唯一的内容来源"
        );
    }

    #[test]
    fn empty_model_output_degrades_to_the_sentence() {
        // 模型返回一个空对象（实测会有），不能就这么把需求单交出去
        let mut r = Requirement::default();
        backfill(&mut r, "做一个我的摄影作品集，黑白为主");
        assert!(r.is_workable());
        assert_eq!(r.title, "我的摄影作品集");
    }

    #[test]
    fn backfill_cross_fills_title_and_content() {
        // 没有原话可用时，标题与内容互相补 —— 这是硬闸前的最后一步
        let mut only_title = Requirement {
            title: "橘猫纪念馆".into(),
            ..Default::default()
        };
        backfill(&mut only_title, "");
        assert!(only_title.is_workable());

        let mut only_content = Requirement {
            content: "放我这几年拍的城市夜景".into(),
            ..Default::default()
        };
        backfill(&mut only_content, "");
        assert!(only_content.is_workable());
        assert!(!only_content.title.trim().is_empty());
    }

    #[test]
    fn backfill_never_overwrites_what_the_model_got_right() {
        let mut r = Requirement {
            title: "十八年".into(),
            content: "橘猫的日常".into(),
            ..Default::default()
        };
        backfill(&mut r, "完全不相干的一句话");
        assert_eq!(r.title, "十八年");
        assert_eq!(r.content, "橘猫的日常");
    }

    #[test]
    fn title_strips_only_unambiguous_leads() {
        assert_eq!(title_from("做一个我的摄影作品集"), "我的摄影作品集");
        assert_eq!(title_from("帮我做个读书会招新页"), "读书会招新页");
        // 「给我家…」不是「给我做…」：泛化剥前缀会把它剥成「家养了…」，比不剥还糟
        assert_eq!(
            title_from("给我家养了十八年的橘猫做一个纪念站，放照片"),
            "给我家养了十八年的橘猫做一个纪念站"
        );
    }

    #[test]
    fn title_is_clipped_and_never_empty() {
        let long = "做一个".to_string() + &"很".repeat(80) + "长的站";
        assert_eq!(title_from(&long).chars().count(), 40);
        assert_eq!(title_from("   "), "我的网站");
        // 第一个句读来得太早时用整句，不能切出个两字标题
        assert_eq!(title_from("做个站，专门放我的诗"), "做个站，专门放我的诗");
    }

    #[test]
    fn wrapped_requirement_json_is_unwrapped() {
        // 模型爱把需求单包一层再吐。解析失败会整份丢掉，白费一次已经付过钱的调用。
        let j = r#"{"requirement":{"title":"橘猫纪念馆","content":"十八年的日常"}}"#;
        let r = parse_requirement(j).expect("包了一层也要解出来");
        assert_eq!(r.title, "橘猫纪念馆");
        assert!(r.is_workable());

        let flat = r#"{"title":"直接给","content":"没包"}"#;
        assert_eq!(parse_requirement(flat).unwrap().title, "直接给");
    }

    #[test]
    fn brief_includes_content_and_skips_blanks() {
        let req = Requirement {
            title: "我的站".into(),
            content: "放摄影作品".into(),
            sections: vec!["首页".into(), "作品".into()],
            ..Default::default()
        };
        let b = req.brief();
        assert!(b.contains("标题：我的站"));
        assert!(b.contains("栏目：首页、作品"));
        assert!(b.contains("要放的内容：放摄影作品"));
        // 空字段不出现，免得给模型一堆「风格：」的噪音
        assert!(!b.contains("风格："));
        assert!(!b.contains("给谁看："));
    }
}
