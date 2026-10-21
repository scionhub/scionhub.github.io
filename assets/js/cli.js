// Build CLI download links from config and auto-highlight the visitor's OS/arch
(function () {
  const assets = window.SCIONHUB_CLI_ASSETS || {};
  const base = (window.SCIONHUB_RELEASE_BASE || "").replace(/\/?$/, "/");
  const releasesUrl = window.SCIONHUB_RELEASES_URL || "https://github.com/scionhub/openscion/releases";

  const byId = (id) => document.getElementById(id);
  const setHref = (id, assetKey) => {
    const el = byId(id);
    if (!el || !assets[assetKey]) return;
    el.href = base + assets[assetKey];
  };

  // Populate links
  setHref("dl-windows-x64", "windows_x64");
  setHref("dl-macos-arm64", "macos_arm64");
  setHref("dl-macos-x64", "macos_x64");
  setHref("dl-linux-x64", "linux_x64");
  setHref("dl-linux-arm64", "linux_arm64");
  const all = document.querySelectorAll('[data-all-releases-link="true"]');
  all.forEach((a) => (a.href = releasesUrl));

  // OS/arch detection
  function detect() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const uaData = navigator.userAgentData || null;
    const isWindows = /Win/.test(platform) || /Windows/.test(ua);
    const isMac = /Mac/.test(platform) || /Macintosh|Mac OS X/.test(ua);
    const isLinux = /Linux|X11/.test(platform) || /Linux|X11/.test(ua);
    // Arch
    let arch = "x64";
    if (uaData && Array.isArray(uaData.brands)) {
      if (uaData.architecture && /arm|aarch64/i.test(uaData.architecture)) arch = "arm64";
    } else {
      if (/arm64|aarch64/i.test(ua)) arch = "arm64";
    }
    return { isWindows, isMac, isLinux, arch };
  }

  function highlightRecommended() {
    const { isWindows, isMac, isLinux, arch } = detect();
    let cardId = "";
    if (isWindows) {
      cardId = "card-windows-x64";
    } else if (isMac) {
      cardId = arch === "arm64" ? "card-macos-arm64" : "card-macos-x64";
    } else if (isLinux) {
      cardId = arch === "arm64" ? "card-linux-arm64" : "card-linux-x64";
    }
    if (cardId) {
      const card = byId(cardId);
      if (card) {
        card.classList.add("recommended");
        const badge = document.createElement("span");
        badge.className = "badge recommend-badge";
        badge.textContent = "Recommended for your system";
        const h3 = card.querySelector("h3");
        if (h3) h3.after(badge);
      }
    }
  }

  highlightRecommended();
})();

