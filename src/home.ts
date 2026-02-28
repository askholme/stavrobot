import http from "http";
import type pg from "pg";
import type { Config } from "./config.js";

const startTime = Date.now();

function formatUptime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.join(", ");
}

interface MessageStats {
  total: string;
  signal: string;
  telegram: string;
  whatsapp: string;
  web: string;
  agent: string;
}

function buildHtml(config: Config, uptime: string, stats: MessageStats): string {
  const services = [
    { name: "Signal", enabled: config.signal !== undefined },
    { name: "Telegram", enabled: config.telegram !== undefined },
    { name: "WhatsApp", enabled: config.whatsapp !== undefined },
    { name: "STT", enabled: config.stt !== undefined },
    { name: "Coder", enabled: config.coder !== undefined },
  ];

  const serviceRows = services
    .map(
      (service) =>
        `<div class="stat-row">
      <span class="stat-label">${service.name}</span>
      <span class="stat-value ${service.enabled ? "enabled" : "disabled"}">${service.enabled ? "Enabled" : "Disabled"}</span>
    </div>`,
    )
    .join("\n    ");

  const navLinkHtml = `<a href="/explorer">Database explorer</a>
    <a href="/settings">Settings</a>
    <a href="/settings/allowlist" style="margin-left: 24px">Allowlist</a>
    <a href="/settings/plugins" style="margin-left: 24px">Plugins</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stavrobot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f8f9fa;
      color: #1a1a1a;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    @media (max-width: 480px) {
      body { padding: 12px; }
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .section {
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .section a {
      display: block;
      font-size: 15px;
      color: #d97706;
      text-decoration: none;
      padding: 4px 0;
    }
    .section a:hover {
      text-decoration: underline;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 14px;
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #555; }
    .stat-value { font-weight: 500; }
    .enabled { color: #15803d; }
    .disabled { color: #9ca3af; }
  </style>
</head>
<body>
  <h1>Stavrobot</h1>

  <div class="section">
    <h2>Bot info</h2>
    <div class="stat-row">
      <span class="stat-label">Provider</span>
      <span class="stat-value">${config.provider}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Model</span>
      <span class="stat-value">${config.model}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Uptime</span>
      <span class="stat-value">${uptime}</span>
    </div>
  </div>

  <div class="section">
    <h2>Services</h2>
    ${serviceRows}
  </div>

  <div class="section">
    <h2>Message statistics</h2>
    <div class="stat-row">
      <span class="stat-label">Total inbound messages</span>
      <span class="stat-value">${stats.total}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Signal</span>
      <span class="stat-value">${stats.signal}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Telegram</span>
      <span class="stat-value">${stats.telegram}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">WhatsApp</span>
      <span class="stat-value">${stats.whatsapp}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Web API</span>
      <span class="stat-value">${stats.web}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Agents</span>
      <span class="stat-value">${stats.agent}</span>
    </div>
  </div>

  <div class="section">
    <h2>Navigation</h2>
    ${navLinkHtml}
  </div>
</body>
</html>`;
}

export async function serveHomePage(
  response: http.ServerResponse,
  config: Config,
  pool: pg.Pool,
): Promise<void> {
  try {
    console.log("[stavrobot] serveHomePage: querying message stats");

    const result = await pool.query<MessageStats>(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE ii.service = 'signal') AS signal,
        COUNT(*) FILTER (WHERE ii.service = 'telegram') AS telegram,
        COUNT(*) FILTER (WHERE ii.service = 'whatsapp') AS whatsapp,
        COUNT(*) FILTER (WHERE m.sender_identity_id IS NULL AND m.sender_agent_id IS NULL) AS web,
        COUNT(*) FILTER (WHERE m.sender_agent_id IS NOT NULL) AS agent
      FROM messages m
      LEFT JOIN interlocutor_identities ii ON ii.id = m.sender_identity_id
      WHERE m.role = 'user'
    `);

    const stats = result.rows[0];
    const uptime = formatUptime(Date.now() - startTime);
    const html = buildHtml(config, uptime, stats);

    console.log("[stavrobot] serveHomePage: serving home page");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  } catch (error) {
    console.error("[stavrobot] Error serving home page:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: errorMessage }));
  }
}
