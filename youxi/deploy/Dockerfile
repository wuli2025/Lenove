# MicaBase 服务器形态镜像（PRD 6.3 三层构建：运行时层单独缓存，CLI 升级不重编 Rust）
# 构建：docker build -f deploy/Dockerfile -t micabase:latest .
# claude 层可选：--build-arg WITH_CLAUDE=1（默认不含，标准镜像 ≤ 200MB 目标）

# ---- 层1：CLI 运行时（先 scripts/fetch-runtimes.ps1 或 CI 拉取到 resources/runtimes/）----
FROM debian:bookworm-slim AS runtimes
COPY resources/runtimes/ /opt/mica/runtimes/

# ---- 层2：编译 mica-server ----
FROM rust:1-slim-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p mica --features server --bin mica-server

# ---- 层3：运行层（非 root）----
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 mica
COPY --from=runtimes /opt/mica/runtimes /opt/mica/runtimes
COPY --from=builder /build/target/release/mica-server /usr/local/bin/mica-server
USER mica
ENV MICA_DATA_DIR=/data \
    MICA_PORT=1440
VOLUME ["/data"]
EXPOSE 1440
HEALTHCHECK --interval=30s --timeout=3s CMD ["mica-server", "--healthcheck"]
ENTRYPOINT ["mica-server"]
