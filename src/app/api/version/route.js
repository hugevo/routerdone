import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { APP_CONFIG } from "@/shared/constants/config";

const APP_GITHUB_REPO = "thoa100m/routerdone";
const UPSTREAM_GITHUB_REPO = "decolua/9router";

// Fetch latest GitHub release tag (strips leading "v")
function fetchGithubLatestRelease(repo) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        timeout: 4000,
        headers: {
          "User-Agent": "routerdone-version-check",
          "Accept": "application/vnd.github.v3+json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const tag = JSON.parse(data).tag_name || "";
            resolve(tag.replace(/^v/, "") || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export async function GET() {
  const [latestVersion, githubLatestVersion] = await Promise.all([
    fetchGithubLatestRelease(UPSTREAM_GITHUB_REPO),
    fetchGithubLatestRelease(APP_GITHUB_REPO),
  ]);
  const currentVersion = pkg.version;
  const coreVersion = APP_CONFIG.coreVersion;
  const hasCoreUpdate = latestVersion ? compareVersions(latestVersion, coreVersion) > 0 : false;
  const hasAppUpdate = githubLatestVersion ? compareVersions(githubLatestVersion, currentVersion) > 0 : false;
  const hasUpdate = hasCoreUpdate || hasAppUpdate;

  return Response.json({ currentVersion, latestVersion, githubLatestVersion, coreVersion, hasCoreUpdate, hasAppUpdate, hasUpdate });
}