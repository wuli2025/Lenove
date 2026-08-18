//! 发布板块：把本地生成好的网站送进云端大厅。
//!
//! 依赖方向 `publish → runtime → core`（check-boundaries 强制），
//! 绝不反向摸 engine / server —— 发布是纯 IO 流程，跟任务调度没关系。
//!
//! 三块拆分：
//! * [`creator`]  创作者身份（姓名闸门，没填不许开工）
//! * [`uploader`] 产物上传（R2 S3 兼容 API + 手写 SigV4）
//! * [`client`]   大厅 HTTP（POST /api/works、PATCH 回填）
//!
//! 所有凭据一律走环境变量或数据目录下的配置文件，源码零硬编码：
//! `MICA_PUBLISH_TOKEN` / `MICA_PUBLISH_BASE_URL`
//! `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`

pub mod client;
pub mod creator;
pub mod uploader;

use crate::core::{MicaError, Result};
use client::{CreateWorkReq, HallClient, MAX_TAGLINE_CHARS, MAX_TITLE_CHARS};
use serde::Serialize;
use std::path::PathBuf;
use uploader::UploadTarget;

pub use creator::{CreatorProfile, MAX_NAME_CHARS};
pub use uploader::{R2Config, UploadMode, WorkerConfig};

/// 发布入参。creator 不在这里——它是设备级身份，从 [`creator`] 取，
/// 免得每次发布都要上层重新传一遍、传错了还发到别人名下。
#[derive(Debug, Clone)]
pub struct PublishInput {
    /// 作品主题（必填，≤40 字）
    pub title: String,
    /// 一句话亮点（可空，≤60 字）
    pub tagline: String,
    /// 本地已生成好的站点目录，将整目录递归上传
    pub site_dir: PathBuf,
    /// 生图模型产出的真实封面位图字节（必填 PNG/JPEG/WebP）。
    pub cover_image: Vec<u8>,
}

/// 校验通过后的字段（都已去首尾空白）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedInput {
    pub title: String,
    pub tagline: String,
}

impl PublishInput {
    /// 本地先把服务端那套长度规则跑一遍：现场网络不稳，
    /// 能在本机 0ms 拒掉的东西没必要绕一圈换个 400 回来。
    pub fn validate(&self) -> Result<ValidatedInput> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(MicaError::Other("作品主题不能为空".into()));
        }
        let n = title.chars().count();
        if n > MAX_TITLE_CHARS {
            return Err(MicaError::Other(format!(
                "作品主题过长（{n} 字，最多 {MAX_TITLE_CHARS} 字）"
            )));
        }
        if title.chars().any(|c| c.is_control()) {
            return Err(MicaError::Other("作品主题不能包含换行等控制字符".into()));
        }

        let tagline = self.tagline.trim();
        let m = tagline.chars().count();
        if m > MAX_TAGLINE_CHARS {
            return Err(MicaError::Other(format!(
                "亮点描述过长（{m} 字，最多 {MAX_TAGLINE_CHARS} 字）"
            )));
        }
        if tagline.chars().any(|c| c.is_control()) {
            return Err(MicaError::Other("亮点描述不能包含换行等控制字符".into()));
        }

        Ok(ValidatedInput {
            title: title.to_string(),
            tagline: tagline.to_string(),
        })
    }
}

/// 发布结果，直接回给 UI 展示 / 生成二维码。
#[derive(Debug, Clone, Serialize)]
pub struct PublishResult {
    pub id: String,
    pub slug: String,
    /// 发布时实际写入大厅的创作者姓名，供海报绑定，避免设置变更后串名。
    pub creator: String,
    /// 作品站点地址 `/u/<slug>/`
    pub site_url: String,
    /// 海报地址 `/p/<id>`
    pub poster_url: String,
    /// 大厅首页
    pub hall_url: String,
    /// 实际上传的站点文件数（对账用）
    pub uploaded_files: usize,
    /// 走的哪条上传通道：worker（默认代理）/ s3（直连 SigV4）
    pub upload_mode: String,
}

/// 完整发布流程：
/// 姓名闸 → 本地校验 → 创建 draft → 上传站点 → 上传真实位图封面 → finalize 公开。
/// 记录创建后的任一步失败都先隐藏，绝不让公开大厅看见半成品。
pub async fn publish(input: PublishInput) -> Result<PublishResult> {
    let hall = HallClient::from_env()?;
    let target = UploadTarget::from_env()?;
    publish_with(input, hall, target).await
}

/// 使用调用方在 Rust 内存中提供的显式凭据发布；桌面端走这里，令牌不经过 WebView。
pub async fn publish_with(
    input: PublishInput,
    hall: HallClient,
    target: UploadTarget,
) -> Result<PublishResult> {
    let creator = creator::require_name()?;
    let valid = input.validate()?;
    if !input.site_dir.is_dir() {
        return Err(MicaError::Other(format!(
            "站点目录不存在或不是目录：{}",
            input.site_dir.display()
        )));
    }
    validate_cover(&input.cover_image)?;

    // draft 先拿 slug；draft 站点在 finalize 前由 Worker 拒绝公开访问。
    let created = hall
        .create_work(&CreateWorkReq {
            creator: creator.clone(),
            title: valid.title,
            tagline: valid.tagline,
            slug: None,
            cover: None,
        })
        .await?;

    let uploaded_files = match uploader::upload_site(&target, &created.slug, &input.site_dir).await
    {
        Ok(n) => n,
        Err(e) => return Err(rollback(&hall, &created.id, "站点产物上传", e).await),
    };

    let cover_key = match uploader::upload_cover(&target, &created.id, &input.cover_image).await {
        Ok(k) => k,
        Err(e) => return Err(rollback(&hall, &created.id, "封面上传", e).await),
    };
    if let Err(e) = hall.set_cover(&created.id, &cover_key).await {
        return Err(rollback(&hall, &created.id, "封面回填", e).await);
    }
    if let Err(e) = hall.finalize_work(&created.id).await {
        return Err(rollback(&hall, &created.id, "作品完整性校验与公开", e).await);
    }

    Ok(PublishResult {
        id: created.id,
        slug: created.slug,
        creator,
        site_url: created.site_url,
        poster_url: created.poster_url,
        hall_url: created.hall_url,
        uploaded_files,
        upload_mode: target.mode_name().to_string(),
    })
}

/// 上传并回填已经由桌面 Canvas 生成、校验过的 PNG 分享海报。
pub async fn attach_poster(
    hall: &HallClient,
    target: &UploadTarget,
    work_id: &str,
    png: &[u8],
) -> Result<String> {
    let key = uploader::upload_poster(target, work_id, png).await?;
    hall.set_poster(work_id, &key).await?;
    Ok(key)
}

fn validate_cover(bytes: &[u8]) -> Result<()> {
    uploader::validate_raster_image(bytes)
        .map(|_| ())
        .map_err(|_| {
            MicaError::Other("公开作品必须有一张不超过 20MB 的完整 PNG/JPEG/WebP 封面".into())
        })
}

/// 把已建的作品记录隐藏掉，并把「回滚是否成功」如实拼进错误里。
/// 回滚本身再失败也不吞——用户得知道大厅里躺着一条需要人工处理的残次品。
async fn rollback(hall: &HallClient, id: &str, stage: &str, cause: MicaError) -> MicaError {
    match hall.hide_work(id).await {
        Ok(()) => MicaError::Other(format!(
            "{stage}失败，已把作品 {id} 从大厅隐藏（未留下公开的半成品）：{cause}"
        )),
        Err(e) => MicaError::Other(format!(
            "{stage}失败：{cause}；并且回滚隐藏作品 {id} 也失败了：{e} —— 请手动 PATCH /api/works/{id} 置 status=hidden"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode(&[24, 48, 72], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    }

    fn input(title: &str, tagline: &str) -> PublishInput {
        PublishInput {
            title: title.into(),
            tagline: tagline.into(),
            site_dir: PathBuf::from("."),
            cover_image: jpeg_fixture(),
        }
    }

    #[test]
    fn title_length_rules() {
        // 正常：去首尾空白
        let v = input("  我的第一个网站  ", "").validate().unwrap();
        assert_eq!(v.title, "我的第一个网站");
        assert_eq!(v.tagline, "");

        // 空 / 纯空白拒
        assert!(input("", "x").validate().is_err());
        assert!(input("   \t ", "x").validate().is_err());

        // 边界：40 字放行、41 字拒（按字符数，40 个汉字 = 120 字节）
        let ok = "字".repeat(MAX_TITLE_CHARS);
        assert!(input(&ok, "").validate().is_ok());
        assert!(ok.len() > MAX_TITLE_CHARS, "校验必须按字符数而非字节数");
        assert!(input(&"字".repeat(MAX_TITLE_CHARS + 1), "")
            .validate()
            .is_err());

        // 控制字符拒
        assert!(input("标题\n换行", "").validate().is_err());
    }

    #[test]
    fn tagline_length_rules() {
        // tagline 可空
        assert!(input("t", "").validate().is_ok());
        assert!(input("t", "   ").validate().unwrap().tagline.is_empty());

        // 边界：60 字放行、61 字拒
        assert!(input("t", &"亮".repeat(MAX_TAGLINE_CHARS))
            .validate()
            .is_ok());
        assert!(input("t", &"亮".repeat(MAX_TAGLINE_CHARS + 1))
            .validate()
            .is_err());
        assert!(input("t", &"a".repeat(MAX_TAGLINE_CHARS + 1))
            .validate()
            .is_err());

        // 控制字符拒
        assert!(input("t", "亮点\t带制表符").validate().is_err());
    }

    #[test]
    fn local_limits_match_server_contract() {
        // 这三个常量一旦和 r2-sites/src/api.js 漂移，就会出现本地放行、服务端 400
        assert_eq!(MAX_NAME_CHARS, 24);
        assert_eq!(MAX_TITLE_CHARS, 40);
        assert_eq!(MAX_TAGLINE_CHARS, 60);
    }
}
