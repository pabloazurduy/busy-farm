import http from "node:http";
import { pathToFileURL } from "node:url";

const port = Number(process.env.BUSY_FARM_PORT ?? 8787);
let device = startMode("idle");

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  if (request.method === "GET" && isSnapshotPath(url.pathname)) {
    sendJson(response, 200, snapshotFor(device));
    return;
  }

  if (request.method === "POST" && url.pathname === "/control") {
    const mode = url.searchParams.get("mode") ?? "idle";
    if (!new Set(["idle", "work", "paused", "break", "infinite", "error"]).has(mode)) {
      sendJson(response, 400, { error: "Unknown simulator mode" });
      return;
    }
    device = startMode(mode);
    response.writeHead(303, { Location: "/" }).end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(controlPage());
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.on("error", (error) => {
    console.error(`Busy Farm simulator could not start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Busy Farm simulator running at http://127.0.0.1:${port}`);
    console.log(`Configure the extension with base address http://127.0.0.1:${port}/api and connection type USB network.`);
  });
}

export function startMode(mode, now = Date.now()) {
  return { mode, startedAt: now };
}

export function isSnapshotPath(pathname) {
  return new Set([
    "/api/busybar/busy/snapshot",
    "/busybar/busy/snapshot",
    "/busy/snapshot",
  ]).has(pathname);
}

export function snapshotFor(deviceState, now = Date.now()) {
  const elapsed = now - deviceState.startedAt;
  const busyBarSettings = { theme: "on_air", show_work_phase_only: false, trigger_smart_home: false };

  if (deviceState.mode === "error") return { simulator_error: true };
  if (deviceState.mode === "idle") {
    return { snapshot: { type: "NOT_STARTED", busy_bar_settings: busyBarSettings }, snapshot_timestamp_ms: now };
  }
  if (deviceState.mode === "infinite") {
    return {
      snapshot: { type: "INFINITE", card_id: "00000000-0000-0000-0000-000000000001", is_paused: false, busy_bar_settings: busyBarSettings },
      snapshot_timestamp_ms: now,
    };
  }
  if (deviceState.mode === "break") {
    const total = 5 * 60 * 1000;
    return {
      snapshot: {
        type: "INTERVAL",
        card_id: "00000000-0000-0000-0000-000000000002",
        current_interval: 2,
        current_interval_time_total_ms: total,
        current_interval_time_left_ms: Math.max(0, total - elapsed),
        is_paused: false,
        interval_settings: {
          type: "INTERVAL",
          interval_work_ms: 25 * 60 * 1000,
          interval_rest_ms: total,
          interval_work_cycles_count: 4,
          is_autostart_enabled: false,
        },
        busy_bar_settings: busyBarSettings,
      },
      snapshot_timestamp_ms: now,
    };
  }

  const total = 25 * 60 * 1000;
  return {
    snapshot: {
      type: "SIMPLE",
      card_id: "00000000-0000-0000-0000-000000000003",
      time_left_ms: deviceState.mode === "paused" ? total : Math.max(0, total - elapsed),
      is_paused: deviceState.mode === "paused",
      busy_bar_settings: busyBarSettings,
    },
    snapshot_timestamp_ms: now,
  };
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Accept, Authorization, X-Api-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

function controlPage() {
  const modes = [
    ["idle", "Idle"],
    ["work", "Focus running"],
    ["paused", "Focus paused"],
    ["break", "Break running"],
    ["infinite", "Infinite focus"],
    ["error", "Malformed response"],
  ];
  const buttons = modes.map(([value, label]) =>
    `<form method="post" action="/control?mode=${value}"><button${device.mode === value ? " class=active" : ""}>${label}</button></form>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Busy Farm simulator</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,monospace;background:#10141a;color:#f3f6f2}body{max-width:680px;margin:8vh auto;padding:24px}main{padding:28px;border:1px solid #313a45;border-radius:12px;background:#181e26}h1{margin-top:0;font-size:25px}p,code{color:#98a29f;line-height:1.6}code{color:#a9eee4}section{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:24px}form{margin:0}button{width:100%;padding:13px;border:1px solid #46515e;border-radius:7px;background:#202731;color:#f3f6f2;font:inherit;cursor:pointer}button:hover{border-color:#5eead4}button.active{border-color:#5eead4;background:#245c58;color:#d8fff9}@media(max-width:520px){section{grid-template-columns:1fr}}
</style></head><body><main><p>LOCAL DEVICE / TEST RIG</p><h1>Busy Farm BUSY simulator</h1>
<p>Current mode: <strong>${device.mode}</strong>. Set the extension base address to <code>http://127.0.0.1:${port}/api</code> and choose <strong>USB network</strong>.</p>
<section>${buttons}</section></main></body></html>`;
}
