import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, getError) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server uji tidak aktif. ${getError()}`);
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, cookie, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Requested-With": "MNNQuotationDesk",
      ...(options.headers || {}),
    },
  });
}

test("server enforces Manager user scope and exposes verified backups and reports", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnn-server-roadmap-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: appDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      QUOTATION_DATA_DIR: dataDir,
      NODE_ENV: "test",
      MNN_BOOTSTRAP_ADMIN_PASSWORD: "Admin@MNN2026",
      MNN_BOOTSTRAP_SUPPORT_PASSWORD: "Support@MNN2026",
      MNN_BOOTSTRAP_MANAGER_PASSWORD: "Manager@MNN2026",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const health = await waitForHealth(baseUrl, () => stderr);
    assert.equal(health.version, "0.8.5");
    const rememberedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "support", password: "Support@MNN2026", rememberMe: true }),
    });
    assert.equal(rememberedLogin.status, 200);
    assert.match(rememberedLogin.headers.get("set-cookie"), /Max-Age=2592000/);
    assert.doesNotMatch(rememberedLogin.headers.get("set-cookie"), /Support@MNN2026/);
    assert.equal((await rememberedLogin.json()).remembered, true);
    const managerCookie = await login(baseUrl, "manager", "Manager@MNN2026");
    const createdSupport = await request(baseUrl, managerCookie, "/api/users", {
      method: "POST",
      body: JSON.stringify({ username: "support.api", displayName: "Support API", role: "SUPPORT", password: "Support#Api2026" }),
    });
    assert.equal(createdSupport.status, 201);
    const createdSupportPayload = await createdSupport.json();
    const forbiddenAdmin = await request(baseUrl, managerCookie, "/api/users", {
      method: "POST",
      body: JSON.stringify({ username: "admin.api", displayName: "Admin API", role: "ADMIN", password: "Admin#Api2026" }),
    });
    assert.equal(forbiddenAdmin.status, 400);
    const managerUsers = await request(baseUrl, managerCookie, "/api/users");
    const managerUserPayload = await managerUsers.json();
    assert.equal(managerUserPayload.items.every((item) => ["SUPPORT", "PRESALES", "LOGISTICS"].includes(item.role)), true);
    const backupResponse = await request(baseUrl, managerCookie, "/api/backups", { method: "POST", body: "{}" });
    assert.equal(backupResponse.status, 201);
    const backupPayload = await backupResponse.json();
    assert.equal(backupPayload.item.integrity, "ok");
    assert.equal(fs.existsSync(path.join(dataDir, "backups", backupPayload.item.id, "manifest.json")), true);
    const reportResponse = await request(baseUrl, managerCookie, "/api/reports/management?year=2026");
    assert.equal(reportResponse.status, 200);

    const adminCookie = await login(baseUrl, "admin", "Admin@MNN2026");
    const supportCookie = await login(baseUrl, "support.api", "Support#Api2026");
    const renamedSupport = await request(
      baseUrl,
      adminCookie,
      `/api/users/${encodeURIComponent(createdSupportPayload.user.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          username: "support.renamed",
          displayName: "Support API",
          role: "SUPPORT",
          active: true,
        }),
      },
    );
    assert.equal(renamedSupport.status, 200);
    const renamedPayload = await renamedSupport.json();
    assert.equal(renamedPayload.usernameChanged, true);
    assert.equal(renamedPayload.user.username, "support.renamed");
    assert.equal((await request(baseUrl, supportCookie, "/api/bootstrap")).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "support.api", password: "Support#Api2026" }),
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "support.renamed", password: "Support#Api2026" }),
    })).status, 200);
    const createdAdmin = await request(baseUrl, adminCookie, "/api/users", {
      method: "POST",
      body: JSON.stringify({ username: "admin.api", displayName: "Admin API", role: "ADMIN", password: "Admin#Api2026" }),
    });
    assert.equal(createdAdmin.status, 201);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
