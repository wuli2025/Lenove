use yiju_desktop::{cloud::CloudConfig, config, doctor, preview};

#[tokio::main]
async fn main() {
    if let Err(error) = config::normalize_working_directory() {
        eprintln!("环境医生无法修正程序启动目录：{error}");
        std::process::exit(2);
    }
    let force_deep = std::env::args().any(|arg| arg == "--deep");
    let cfg = config::Config::load();
    let cloud = CloudConfig::load();
    let root = config::sites_dir();
    let preview = match preview::serve(root).await {
        Ok(preview) => Some(preview),
        Err(error) => {
            eprintln!("环境医生无法启动本地预览服务：{error}");
            None
        }
    };
    let preview_url = preview.as_ref().map(preview::Preview::url);
    let report = doctor::run(cfg, cloud, preview_url, force_deep, |_| {}).await;

    match serde_json::to_string_pretty(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("环境医生报告序列化失败：{error}");
            std::process::exit(2);
        }
    }
    if !report.ready {
        std::process::exit(1);
    }
}
