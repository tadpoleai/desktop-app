# Hera Desktop — Tauri v2 构建镜像
# 基于 Ubuntu 22.04，预装 Rust stable + Node 20 LTS + WebKitGTK 4.1 全部依赖
#
# 构建并推送（在项目根目录执行）：
#   ACR=crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com
#   docker build -f docker/tauri-builder.Dockerfile -t $ACR/glim/tauri-builder:v1 .
#   docker push $ACR/glim/tauri-builder:v1
#
# 若国内拉取 ubuntu:22.04 超时，改用阿里云镜像：
#   FROM registry.cn-hangzhou.aliyuncs.com/library/ubuntu:22.04

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/root/.cargo/bin:${PATH}"

# ── 1. 系统依赖 (Tauri v2 必需) ─────────────────────────────────────────────
# 使用阿里云 ubuntu 镜像加速国内下载
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list && \
    sed -i 's|http://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev \
        libjavascriptcoregtk-4.1-dev \
        libsoup-3.0-dev \
        libappindicator3-dev \
        librsvg2-dev \
        patchelf \
        libgtk-3-dev \
        libssl-dev \
        build-essential \
        pkg-config \
        curl \
        file \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Rust stable ───────────────────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain stable && \
    rustc --version && cargo --version

# ── 3. Node.js 20 LTS ────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    node --version && npm --version

WORKDIR /workspace
