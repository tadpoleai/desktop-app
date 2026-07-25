#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's default DMA-BUF renderer needs direct /dev/dri access to allocate
    // GBM buffers via DRM/KMS. On virtualized/cloud desktops (observed: Alibaba Wuying
    // workstation) that access is denied, and the failure is silent — WebKitGTK just
    // renders a blank white window with no visible error (only "KMS: DRM_IOCTL_MODE_
    // CREATE_DUMB failed: Permission denied" in stderr). Disabling the DMA-BUF renderer
    // falls back to a compositing path that doesn't need that access; must be set
    // before WebKitGTK initializes, i.e. before any window is created. Linux-only var,
    // harmless no-op on macOS (WKWebView) / Windows (WebView2).
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    hera_desktop_lib::run();
}
