    "<unknown>": void 0,
    "linux-x64": void 0,
    "linux-arm64": void 0,
    "mac-x64": void 0,
    "mac-arm64": void 0,
    "win-x64": ["PrintDeps.exe"]
  }
};
function cftUrl(suffix) {
  return ({ browserVersion }) => {
    return {
      path: `builds/cft/${browserVersion}/${suffix}`,
      mirrors: [
        "https://cdn.playwright.dev"
      ]
    };
  };
}
const DOWNLOAD_PATHS = {
  "chromium": {
    "<unknown>": void 0,
    "ubuntu18.04-x64": void 0,
    "ubuntu20.04-x64": cftUrl("linux64/chrome-linux64.zip"),
    "ubuntu22.04-x64": cftUrl("linux64/chrome-linux64.zip"),
    "ubuntu24.04-x64": cftUrl("linux64/chrome-linux64.zip"),
    "ubuntu18.04-arm64": void 0,
    "ubuntu20.04-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "ubuntu22.04-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "ubuntu24.04-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "debian11-x64": cftUrl("linux64/chrome-linux64.zip"),
    "debian11-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "debian12-x64": cftUrl("linux64/chrome-linux64.zip"),
    "debian12-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "debian13-x64": cftUrl("linux64/chrome-linux64.zip"),
    "debian13-arm64": "builds/chromium/%s/chromium-linux-arm64.zip",
    "mac10.13": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac10.14": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac10.15": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac11": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac11-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
    "mac12": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac12-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
    "mac13": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac13-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
    "mac14": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac14-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
    "mac15": cftUrl("mac-x64/chrome-mac-x64.zip"),
    "mac15-arm64": cftUrl("mac-arm64/chrome-mac-arm64.zip"),
    "win64": cftUrl("win64/chrome-win64.zip")
  },
  "chromium-headless-shell": {
    "<unknown>": void 0,
    "ubuntu18.04-x64": void 0,
    "ubuntu20.04-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "ubuntu22.04-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "ubuntu24.04-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "ubuntu18.04-arm64": void 0,
    "ubuntu20.04-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "ubuntu22.04-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "ubuntu24.04-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "debian11-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "debian11-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "debian12-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "debian12-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "debian13-x64": cftUrl("linux64/chrome-headless-shell-linux64.zip"),
    "debian13-arm64": "builds/chromium/%s/chromium-headless-shell-linux-arm64.zip",
    "mac10.13": void 0,
    "mac10.14": void 0,
    "mac10.15": void 0,
    "mac11": cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip"),
    "mac11-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip"),
    "mac12": cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip"),
    "mac12-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip"),
    "mac13": cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip"),
    "mac13-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip"),
    "mac14": cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip"),
    "mac14-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip"),
    "mac15": cftUrl("mac-x64/chrome-headless-shell-mac-x64.zip"),
    "mac15-arm64": cftUrl("mac-arm64/chrome-headless-shell-mac-arm64.zip"),
    "win64": cftUrl("win64/chrome-headless-shell-win64.zip")
  },
