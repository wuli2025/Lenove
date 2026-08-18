//! 生成链路冒烟：不起窗口，跑完整条 需求单 → 站点 的链路并打印耗时分布。
//!
//! 规划书 R1 的处置③写着「8/17 连跑 20 次统计成功率与耗时分布」——
//! 十分钟生成这种事，跑一次成功不算数，要看它稳不稳。
//!
//! 用法：
//! ```powershell
//! cargo run -p yiju-desktop --bin yiju-smoke            # 跑 1 次
//! cargo run -p yiju-desktop --bin yiju-smoke -- 20      # 连跑 20 次，出分布
//! ```

use std::time::Instant;
use yiju_desktop::config::Config;
use yiju_desktop::generate::{Engine, Progress};
use yiju_desktop::interview::Requirement;

/// 现场最典型的一类需求，拿它当基准用例
fn sample() -> Requirement {
    Requirement {
        title: "我家猫的十八年回忆录".into(),
        site_type: "纪念站".into(),
        audience: "家里人和几个老朋友".into(),
        sections: vec![
            "它是谁".into(),
            "老照片".into(),
            "那些小事".into(),
            "最后一年".into(),
        ],
        style: "安静、温暖，不要太花哨".into(),
        content: "一只叫橘子的橘猫，2007 年在小区楼下捡到的，去年冬天走的。\
                  喜欢趴在洗衣机上睡觉，怕打雷，会自己开阳台的门。\
                  想放几段和它有关的小事，还有它最后那年的照片。"
            .into(),
        tagline: "陪了我十八年的那只橘猫".into(),
    }
}

#[tokio::main]
async fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let cfg = Config::load();
    if !cfg.configured() {
        eprintln!(
            "没有配模型密钥。设 YIJU_API_KEY 环境变量，或写 {}",
            yiju_desktop::config::config_path().display()
        );
        std::process::exit(2);
    }
    let cloud = match yiju_desktop::cloud::CloudConfig::load() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Cloudflare 发布/生图未配置：{e}");
            std::process::exit(2);
        }
    };
    println!("模型 {} @ {}", cfg.model, cfg.api_url);
    println!(
        "软截止 {}s · token 预算 {}\n",
        cfg.soft_deadline_secs, cfg.gen_token_budget
    );

    let root = std::env::temp_dir().join("yiju-smoke");
    std::fs::create_dir_all(&root).expect("建临时目录");

    let mut oks: Vec<(u64, u64, bool)> = Vec::new();
    let mut fails = 0usize;

    for i in 1..=runs {
        let engine = Engine::new(cfg.clone(), cloud.clone());
        let dir = yiju_desktop::generate::new_site_dir(&root);
        let t0 = Instant::now();
        print!("[{i}/{runs}] ");
        let r = engine
            .run(&sample(), &dir, |p: Progress| {
                print!("{} ", short(&p));
                use std::io::Write;
                let _ = std::io::stdout().flush();
            })
            .await;
        match r {
            Ok(o) => {
                let bytes = std::fs::metadata(dir.join("index.html"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                println!(
                    "\n     ✅ {:.1}s · {} token · {} 字节{}",
                    o.elapsed_ms as f64 / 1000.0,
                    o.tokens,
                    bytes,
                    if o.degraded {
                        format!(" · 降级：{}", o.degrade_reason)
                    } else {
                        String::new()
                    }
                );
                oks.push((o.elapsed_ms, o.tokens, o.degraded));
            }
            Err(e) => {
                println!("\n     ❌ {:.1}s · {e}", t0.elapsed().as_secs_f64());
                fails += 1;
            }
        }
    }

    println!("\n──────── 汇总 ────────");
    println!("成功 {}/{}   失败 {}", oks.len(), runs, fails);
    if oks.is_empty() {
        std::process::exit(1);
    }

    let mut times: Vec<u64> = oks.iter().map(|x| x.0).collect();
    times.sort_unstable();
    let toks: Vec<u64> = oks.iter().map(|x| x.1).collect();
    let degraded = oks.iter().filter(|x| x.2).count();
    let pick = |q: f64| times[((times.len() - 1) as f64 * q).round() as usize] as f64 / 1000.0;

    println!(
        "耗时  最快 {:.1}s   中位 {:.1}s   P90 {:.1}s   最慢 {:.1}s",
        times[0] as f64 / 1000.0,
        pick(0.5),
        pick(0.9),
        times[times.len() - 1] as f64 / 1000.0
    );
    println!(
        "token 平均 {}   最高 {}",
        toks.iter().sum::<u64>() / toks.len() as u64,
        toks.iter().max().unwrap()
    );
    println!("降级 {degraded}/{}", oks.len());

    // 十分钟是对观众的硬承诺，超了就该红灯
    let over = times
        .iter()
        .filter(|&&t| t > cfg.hard_deadline_secs * 1000)
        .count();
    if over > 0 {
        println!("⚠ 有 {over} 次超过 {}s 硬上限", cfg.hard_deadline_secs);
        std::process::exit(1);
    }
    println!("产物目录 {}", root.display());
}

fn short(p: &Progress) -> String {
    let s = format!("{:?}", p.stage).to_lowercase();
    format!(
        "{}·{:.0}s",
        &s[..s.len().min(4)],
        p.elapsed_ms as f64 / 1000.0
    )
}
