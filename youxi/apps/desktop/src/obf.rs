// 轻量混淆：把内嵌 / 落盘的凭据搅成一串看不出所以然的字节。
//
// 摆在明处的诚实话：这**不是加密，是抬高门槛**。密钥要能被本进程用，
// 就必须能被本进程还原，还原算法与种子都在这个二进制里——铁了心逆向的人
// 照样能把它抠出来。它挡的是两类人：拿 `strings app.exe | findstr sk-`
// 一把梭的，和装完顺手翻 `~\MicaBase\yiju.json` 想抄一份配置的。
// 对这两类，成本从「零秒」抬到「得先看懂这段代码」——够用，但别当保险箱。
// 真要密钥不外泄，只有一条路：密钥留在服务器，客户端走代理（规划书第 03 节的红线）。
//
// 这个文件同时被 build.rs（include!）和运行时（mod obf）用，所以：
// 只准用 `//` 注释、纯函数、无外部依赖、无 inner 属性。

/// 落盘配置的魔数前缀：认出「这份是混淆过的」，好和历史明文 JSON 区分开。
pub const OBF_MAGIC: &[u8] = b"YJO1";

// 编译期种子。改这里等于换锁，旧包解不开新包的串（反之亦然）。
const OBF_SEED: [u8; 16] = [
    0x8f, 0x2a, 0xd7, 0x41, 0x63, 0xbe, 0x19, 0xc5, 0x7d, 0x04, 0xa8, 0x36, 0xef, 0x92, 0x5b, 0x10,
];

/// 对称变换：encode 与 decode 是同一个函数（异或流），跑两遍还原。
/// 密钥流与字节位置绑定，避免同一个字节到处都异或成同一个值、被频率分析看穿。
pub fn transform(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    // LCG（numerical recipes 那组常数）产密钥流，再叠上种子与位置。
    let mut state: u32 = 0x9E37_79B9;
    for (i, b) in data.iter().enumerate() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let k = (state >> 24) as u8 ^ OBF_SEED[i % OBF_SEED.len()] ^ (i as u8);
        out.push(b ^ k);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transform_is_symmetric_and_hides_plaintext() {
        let plain = br#"{"api_key":"sk-kimi-never-plain","model":"k3"}"#;
        let encoded = transform(plain);
        assert_ne!(encoded, plain);
        assert!(!String::from_utf8_lossy(&encoded).contains("sk-kimi"));
        assert_eq!(transform(&encoded), plain);
    }

    #[test]
    fn disk_magic_can_be_removed_before_repackaging() {
        // build.rs 的下一版重打包路径：YJO1 + encoded → plain → embedded encoded
        let plain = br#"{"api_key":"x"}"#;
        let mut disk = OBF_MAGIC.to_vec();
        disk.extend_from_slice(&transform(plain));
        let repacked = transform(&transform(disk.strip_prefix(OBF_MAGIC).unwrap()));
        assert_eq!(repacked, transform(plain));
    }
}
