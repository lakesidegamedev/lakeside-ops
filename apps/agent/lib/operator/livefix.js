"use strict";
const { execFile } = require("node:child_process");
const { GITHUB_OWNER } = require("./github");
// Branch ancestry is source evidence. Only the commit a production service is
// actually running proves that source has reached players. Production runs on
// the self-hosted US box: the deployed commit comes from a successful GitHub
// deployment for that service when one exists, otherwise from the box's live
// probe. Anything unknown fails closed.
const blast = require("./blastradius");
const REPO = `repos/${GITHUB_OWNER}/AHDGame`;
const SHA = /^[0-9a-f]{40}$/;
const includesFix = (comparison) => ["behind", "identical"].includes(comparison?.status);
const SERVICES = {
  web: { environment: "box/ahd-us-web", label: "the main server" },
  worker: { environment: "box/ahd-us-worker", label: "the turn worker" },
};
const deployedShaCmd = () => process.env.KEIR_DEPLOYED_SHA_CMD || "/opt/lakeside-platform/host/ahd-deployed-sha.sh";
const healthUrl = () => process.env.KEIR_AHD_HEALTH_URL || "https://ahousedividedgame.com/api/health";

const execDefault = (command, args, options) => new Promise((resolve, reject) => execFile(command, args, { maxBuffer: 64 * 1024, ...options }, (err, stdout) => err ? reject(err) : resolve(stdout)));
// The box script prints the running 40-hex sha, or exits 1 with empty output.
const probeWith = (exec = execDefault) => async (service, signal) => {
  try {
    const sha = String(await exec(deployedShaCmd(), [service], { timeout: 45000, ...(signal ? { signal } : {}) }) || "").trim();
    return SHA.test(sha) ? sha : null;
  } catch { return null; }
};
const probeSha = probeWith();

// Only the US box environments count. Railway still posts "production"
// deployments for this repo; those are not prod and are never read.
async function githubDeploymentSha(api, service) {
  try {
    const rows = await api([`${REPO}/deployments?environment=${encodeURIComponent(SERVICES[service].environment)}&per_page=1`]);
    const newest = Array.isArray(rows) ? rows[0] : null;
    if (!newest?.id || !SHA.test(newest.sha || "")) return null;
    const statuses = await api([`${REPO}/deployments/${newest.id}/statuses?per_page=1`]);
    return Array.isArray(statuses) && statuses[0]?.state === "success" ? newest.sha : null;
  } catch { return null; }
}

async function deployedCommit({ api, service, signal, probe = probeSha }) {
  const fromGithub = await githubDeploymentSha(api, service);
  if (fromGithub) return { sha: fromGithub, source: "github-deployment" };
  const live = await probe(service, signal);
  return live ? { sha: live, source: "live-probe" } : null;
}

async function siteHealth({ signal, fetchImpl = fetch } = {}) {
  try {
    const timeout = AbortSignal.timeout(10000);
    const res = await fetchImpl(healthUrl(), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: "application/json" } });
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = await res.json().catch(() => null);
    return { ok: body?.status === "ok", status: res.status };
  } catch { return { ok: false, status: null }; }
}

// What production runs right now: the web and turn worker commits plus site health.
async function liveDeployment({ api, signal, probe, fetchImpl } = {}) {
  const [web, worker, health] = await Promise.all([
    deployedCommit({ api, service: "web", signal, probe }),
    deployedCommit({ api, service: "worker", signal, probe }),
    siteHealth({ signal, fetchImpl }),
  ]);
  return { web, worker, health };
}

async function verifyLiveFix({ api, number, signal, probe, fetchImpl }) {
  try {
    const pr = await api([`${REPO}/pulls/${number}`]);
    if (!pr?.merged || !pr.merge_commit_sha) return { live: false, reason: "the fix PR is not merged", pr };
    const files = [];
    let complete = false;
    for (let page = 1; page <= 30; page++) {
      const rows = await api([`${REPO}/pulls/${number}/files?per_page=100&page=${page}`]);
      if (!Array.isArray(rows)) return { live: false, reason: "fix file list unavailable", pr };
      files.push(...rows.flatMap((r) => [r.filename, ...(r.previous_filename ? [r.previous_filename] : [])]));
      if (rows.length < 100) { complete = true; break; }
    }
    if (!complete) return { live: false, reason: "fix file list incomplete", pr };
    const worker = files.some((f) => blast.ECONOMY_PATHS.test(f) || blast.WORKER_PATHS.test(f));
    const where = {}, deployment = {};
    for (const service of ["web", ...(worker ? ["worker"] : [])]) {
      const { label } = SERVICES[service];
      const running = await deployedCommit({ api, service, signal, probe });
      if (!running) return { live: false, reason: `${label} deployed commit unavailable`, pr, files, where };
      where[service] = includesFix(await api([`${REPO}/compare/${running.sha}...${pr.merge_commit_sha}`]));
      if (!where[service]) return { live: false, reason: `the fix is not deployed on ${label}`, pr, files, where };
      deployment[service] = running;
    }
    const health = await siteHealth({ signal, fetchImpl });
    if (!health.ok) return { live: false, reason: "the main server health check is not ok", pr, files, where, deployment };
    return { live: true, pr, files, where, deployment };
  } catch (e) { return { live: false, reason: `deployment evidence unavailable: ${String(e.message).slice(0, 160)}` }; }
}

module.exports = { verifyLiveFix, liveDeployment, deployedCommit, siteHealth, probeWith, SERVICES };
