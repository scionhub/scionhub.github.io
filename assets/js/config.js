// Configure the OpenScion Worker API base URL for persistence attempts.
// Example: "https://openscion.example.workers.dev"
// Leave empty to disable network calls (confirmation will still show; persistence pending).
window.SCIONHUB_API_BASE = "https://openscion-filecoin-poc.jolly-bush-400d.workers.dev";

// CLI release URLs and asset names (adjust here as needed)
window.SCIONHUB_RELEASE_BASE = "https://github.com/scionhub/openscion/releases/latest/download/";
window.SCIONHUB_RELEASES_URL = "https://github.com/scionhub/openscion/releases";
window.SCIONHUB_CLI_ASSETS = {
  windows_x64: "scion-x86_64-pc-windows-msvc.zip",
  macos_arm64: "scion-aarch64-apple-darwin.tar.gz",
  macos_x64: "scion-x86_64-apple-darwin.tar.gz",
  linux_x64: "scion-x86_64-unknown-linux-gnu.tar.gz",
  linux_arm64: "scion-aarch64-unknown-linux-gnu.tar.gz"
};

