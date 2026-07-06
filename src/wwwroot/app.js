const messageBox = document.getElementById("message");
const loginPanel = document.getElementById("login-panel");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("login-form");
const logoutButton = document.getElementById("logout-button");
const targetText = document.getElementById("target-text");
const speedRange = document.getElementById("speed-range");
const speedDisplay = document.getElementById("speed-display");
const setManualButton = document.getElementById("set-manual");
const setAutoButton = document.getElementById("set-auto");
const refreshSensorsButton = document.getElementById("refresh-sensors");
const summaryCards = document.getElementById("summary-cards");
const fanCards = document.getElementById("fan-cards");
const AUTO_REFRESH_INTERVAL_MS = 10000;

let autoRefreshTimer = null;
let isRefreshingDashboard = false;

function showMessage(text, isError = false) {
  messageBox.textContent = text;
  messageBox.classList.remove("hidden", "error");
  if (isError) {
    messageBox.classList.add("error");
  }
}

function clearMessage() {
  messageBox.textContent = "";
  messageBox.classList.add("hidden");
  messageBox.classList.remove("error");
}

async function apiFetch(url, options = {}, allowUnauthorized = false) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin"
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    payload = await response.text();
  }

  if (!response.ok) {
    if (response.status === 401 && !allowUnauthorized) {
      enterLoggedOutState();
    }

    const errorText = typeof payload === "string" ? payload : payload?.error || payload?.title || "请求失败";
    throw new Error(errorText);
  }

  return payload;
}

function enterLoggedOutState() {
  stopAutoRefresh();
  loginPanel.classList.remove("hidden");
  dashboard.classList.add("hidden");
  logoutButton.classList.add("hidden");
  loginForm.reset();
}

function enterDashboardState(session) {
  loginPanel.classList.add("hidden");
  dashboard.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  targetText.textContent = session.targetHost
    ? `服务器IP：${session.targetHost}`
    : "服务器IP：服务端暂未配置";
}

function syncSpeed(value) {
  const safeValue = clamp(Number(value), 0, 100);
  speedRange.value = String(safeValue);
  speedDisplay.textContent = String(safeValue);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

async function login(event) {
  event.preventDefault();
  clearMessage();

  const payload = {
    username: document.getElementById("login-username").value.trim(),
    password: document.getElementById("login-password").value,
    rememberMe: document.getElementById("remember-me").checked
  };

  const session = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  }, true);

  if (!session.serverConfigured) {
    showMessage("登录成功，但服务端还没有配置好 IPMI 参数。", true);
    enterDashboardState(session);
    renderSensorDashboard([]);
    return;
  }

  enterDashboardState(session);
  startAutoRefresh();
  await loadDashboardData();
}

async function logout() {
  clearMessage();
  await apiFetch("/api/auth/logout", { method: "POST" });
  enterLoggedOutState();
  showMessage("已退出登录。");
}

async function setManualSpeed() {
  clearMessage();
  const percent = clamp(Number(speedRange.value), 0, 100);
  const result = await apiFetch("/api/fans/manual", {
    method: "POST",
    body: JSON.stringify({ percent })
  });
  showMessage(result.message || "手动转速已设置。");
}

async function setAutoMode() {
  clearMessage();
  const result = await apiFetch("/api/fans/auto", { method: "POST" });
  showMessage(result.message || "已恢复自动模式。");
}

async function refreshSensors() {
  clearMessage();
  const items = await apiFetch("/api/sensors");
  renderSensorDashboard(items);
  showMessage(`已刷新 ${items.length} 条传感器记录。`);
}

async function loadDashboardData() {
  if (isRefreshingDashboard) {
    return;
  }

  isRefreshingDashboard = true;

  try {
  const [system, sensors] = await Promise.all([
    apiFetch("/api/system"),
    apiFetch("/api/sensors")
  ]);

  targetText.textContent = system.targetHost
    ? `服务器IP：${system.targetHost}`
    : "服务器IP：服务端暂未配置";

  renderSensorDashboard(sensors);
  } finally {
    isRefreshingDashboard = false;
  }
}

function renderSensorDashboard(items) {
  if (!Array.isArray(items) || items.length === 0) {
    summaryCards.innerHTML = '<p class="muted">暂无关键指标。</p>';
    fanCards.innerHTML = '<p class="muted">暂无风扇数据。</p>';
    return;
  }

  const normalized = items.map(normalizeSensor);
  const grouped = groupSensors(normalized);
  renderSummary(normalized, grouped);
}

function normalizeSensor(item) {
  const name = String(item.name || "").trim();
  const value = String(item.value || "").trim();
  const status = String(item.status || "").trim();
  const raw = String(item.raw || "").trim();
  const lowerName = name.toLowerCase();
  const lowerValue = value.toLowerCase();
  const lowerStatus = status.toLowerCase();
  const number = extractNumber(value);
  const category = getCategory(lowerName, lowerValue);
  const severity = getSeverity(lowerStatus, lowerValue);

  return {
    name,
    displayName: translateSensorName(name),
    value,
    displayValue: translateSensorValue(name, value, status, category),
    status,
    raw,
    number,
    category,
    severity,
    description: describeSensor(lowerName, category, value),
    quickTip: buildSensorTip(lowerName, category, severity, value, status)
  };
}

function groupSensors(items) {
  const groups = {
    temperature: [],
    fan: [],
    power: [],
    status: [],
    other: []
  };

  items.forEach((item) => {
    if (groups[item.category]) {
      groups[item.category].push(item);
      return;
    }

    groups.other.push(item);
  });

  return groups;
}

function renderSummary(items, groups) {
  const temperatures = groups.temperature.filter((item) => Number.isFinite(item.number));
  const fans = groups.fan.filter((item) => Number.isFinite(item.number));
  const cpuTemps = temperatures
    .filter((item) => isCpuTemperatureCandidate(item))
    .sort(compareByNaturalLabel);
  const inletTemp = temperatures.find((item) => item.name.toLowerCase().includes("inlet"));
  const exhaustTemp = temperatures.find((item) => item.name.toLowerCase().includes("exhaust"));
  const wattReading = findPowerReading(items);

  const cards = [];

  if (cpuTemps.length > 0) {
    cpuTemps.forEach((item, index) => {
      cards.push({
        label: cpuTemps.length === 1 ? "CPU 温度" : `CPU${index + 1} 温度`,
        value: `${formatNumber(item.number)}°C`,
        state: getTemperatureState(item)
      });
    });
  } else if (temperatures.length > 0) {
    const fallbackTemps = temperatures
      .filter((item) => item.number > 0)
      .filter((item) => {
        const lowerName = String(item.name || "").toLowerCase();
        return !lowerName.includes("inlet") &&
          !lowerName.includes("exhaust") &&
          !lowerName.includes("ambient");
      });

    if (fallbackTemps.length > 0) {
      const highestTemp = getHighestReading(fallbackTemps);
      cards.push({
        label: "CPU 温度",
        value: `${formatNumber(highestTemp.number)}°C`,
        state: getTemperatureState(highestTemp)
      });
    }
  }

  if (inletTemp) {
    cards.push({
      label: "进风口",
      value: `${formatNumber(inletTemp.number)}°C`,
      state: getTemperatureState(inletTemp)
    });
  }

  if (exhaustTemp) {
    cards.push({
      label: "出风口",
      value: `${formatNumber(exhaustTemp.number)}°C`,
      state: getTemperatureState(exhaustTemp)
    });
  }

  if (wattReading) {
    cards.push({
      label: "功率",
      value: formatIntegerDisplayValue(wattReading.displayValue, "瓦"),
      state: getPowerState(wattReading)
    });
  }

  summaryCards.innerHTML = cards.length > 0
    ? cards.map((card) => renderSummaryCard(card)).join("")
    : '<p class="muted">暂无关键指标。</p>';

  renderFanCards(fans);
}

function getHighestReading(items) {
  return items.reduce((current, item) => item.number > current.number ? item : current);
}

function getTemperatureState(item) {
  if (!item || !Number.isFinite(item.number)) {
    return "neutral";
  }

  if (item.severity === "danger" || item.number >= 65) {
    return "danger";
  }

  if (item.severity === "warning" || item.number >= 50) {
    return "warning";
  }

  return "good";
}

function getReadingState(item) {
  if (!item) {
    return "neutral";
  }

  if (item.severity === "danger") {
    return "danger";
  }

  if (item.severity === "warning") {
    return "warning";
  }

  if (item.severity === "good") {
    return "good";
  }

  return "neutral";
}

function getPowerState(item) {
  if (!item || !Number.isFinite(item.number)) {
    return getReadingState(item);
  }

  if (item.number > 160) {
    return "danger";
  }

  if (item.number > 130) {
    return "warning";
  }

  return "good";
}

function renderSummaryCard(card) {
  return `
    <article class="summary-card card" data-state="${escapeHtml(card.state)}">
      <p class="summary-label">${escapeHtml(card.label)}</p>
      <p class="summary-value">${escapeHtml(card.value)}</p>
    </article>
  `;
}

function renderFanCards(fans) {
  const sortedFans = fans
    .filter(isFanTelemetry)
    .sort(compareByNaturalLabel);

  fanCards.innerHTML = sortedFans.length > 0
    ? sortedFans.map((fan, index) => `
      <article class="fan-card" data-state="${escapeHtml(getReadingState(fan))}">
        <p class="fan-label">${escapeHtml(getCompactFanLabel(fan.name, index))}</p>
        <p class="fan-value">${escapeHtml(formatIntegerDisplayValue(fan.displayValue, "RPM"))}</p>
      </article>
    `).join("")
    : '<p class="muted">暂无风扇数据。</p>';
}

function getCompactFanLabel(name, index) {
  const normalized = String(name || "").trim().toLowerCase();
  const fanMatch = normalized.match(/fan(?:\s*mod)?\s*([0-9]+[a-z]?)/i);
  if (fanMatch) {
    return `fan${fanMatch[1].toLowerCase()}`;
  }

  const fallbackMatch = normalized.match(/([0-9]+[a-z]?)/i);
  return fallbackMatch ? `fan${fallbackMatch[1].toLowerCase()}` : `fan${index + 1}`;
}

function compareByNaturalLabel(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
}

function isFanTelemetry(item) {
  const lowerName = String(item.name || "").toLowerCase();
  const lowerValue = String(item.value || "").toLowerCase();

  if (!lowerName.includes("fan") && !lowerValue.includes("rpm")) {
    return false;
  }

  if (lowerName.includes("redund")) {
    return false;
  }

  return lowerValue.includes("rpm") || Number.isFinite(item.number);
}

function isCpuTemperatureCandidate(item) {
  if (!item || !Number.isFinite(item.number) || item.number <= 0) {
    return false;
  }

  const lowerName = String(item.name || "").toLowerCase();

  if (lowerName.includes("inlet") || lowerName.includes("exhaust") || lowerName.includes("ambient")) {
    return false;
  }

  return lowerName.includes("cpu") ||
    lowerName.includes("proc") ||
    lowerName.includes("processor") ||
    lowerName.includes("core") ||
    /^p[12]\b/.test(lowerName) ||
    /cpu\s*\d+/i.test(item.name) ||
    /proc(?:essor)?\s*\d+/i.test(item.name);
}

function findPowerReading(items) {
  const candidates = items.filter((item) => {
    const lowerName = String(item.name || "").toLowerCase();
    const lowerValue = String(item.value || "").toLowerCase();
    return lowerValue.includes("watt") ||
      lowerName.includes("watt") ||
      lowerName.includes("pwr") ||
      lowerName.includes("consumption") ||
      lowerName.includes("power");
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => {
    const aScore = getPowerReadingScore(a);
    const bScore = getPowerReadingScore(b);
    return bScore - aScore;
  })[0];
}

function getPowerReadingScore(item) {
  const lowerName = String(item.name || "").toLowerCase();
  const lowerValue = String(item.value || "").toLowerCase();
  let score = 0;

  if (lowerValue.includes("watt")) {
    score += 5;
  }
  if (lowerName.includes("consumption")) {
    score += 4;
  }
  if (lowerName.includes("pwr")) {
    score += 3;
  }
  if (lowerName.includes("power")) {
    score += 2;
  }
  if (Number.isFinite(item.number)) {
    score += 1;
  }

  return score;
}

function formatIntegerDisplayValue(value, unit) {
  const number = extractNumber(value);
  if (!Number.isFinite(number)) {
    return value;
  }

  return `${Math.round(number)} ${unit}`;
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    loadDashboardData().catch(() => {
      // Errors are handled by existing action flows and auth redirects.
    });
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function translateSensorName(name) {
  const trimmedName = String(name || "").trim();
  const lowerName = trimmedName.toLowerCase();

  const exactMappings = {
    "inlet temp": "进风口温度",
    "exhaust temp": "出风口温度",
    "ambient temp": "环境温度",
    "system board temp": "主板温度",
    "mb temp": "主板温度",
    "cpu1 temp": "CPU1 温度",
    "cpu2 temp": "CPU2 温度",
    "cpu temp": "CPU 温度",
    "fan redundancy": "风扇冗余状态",
    "intrusion": "机箱入侵状态",
    "presence": "设备在位状态",
    "status": "状态",
    "ps redundant": "电源冗余状态",
    "pwr consumption": "整机功耗",
    "power consumption": "整机功耗"
  };

  if (exactMappings[lowerName]) {
    return exactMappings[lowerName];
  }

  let matched = lowerName.match(/^fan\s*(\d+)$/);
  if (matched) {
    return `风扇 ${matched[1]}`;
  }

  matched = lowerName.match(/^fan\s*(\d+)\s*rpm$/);
  if (matched) {
    return `风扇 ${matched[1]} 转速`;
  }

  matched = lowerName.match(/^fan\s*(\d+)\s*duty$/);
  if (matched) {
    return `风扇 ${matched[1]} 占空比`;
  }

  matched = lowerName.match(/^cpu\s*(\d+)\s*temp$/);
  if (matched) {
    return `CPU${matched[1]} 温度`;
  }

  matched = lowerName.match(/^temp\s*(\d+)$/);
  if (matched) {
    return `温度传感器 ${matched[1]}`;
  }

  matched = lowerName.match(/^psu\s*(\d+)\s*status$/);
  if (matched) {
    return `电源 ${matched[1]} 状态`;
  }

  matched = lowerName.match(/^psu\s*(\d+)\s*power$/);
  if (matched) {
    return `电源 ${matched[1]} 功率`;
  }

  matched = lowerName.match(/^psu\s*(\d+)\s*current$/);
  if (matched) {
    return `电源 ${matched[1]} 电流`;
  }

  matched = lowerName.match(/^psu\s*(\d+)\s*voltage$/);
  if (matched) {
    return `电源 ${matched[1]} 电压`;
  }

  if (lowerName.includes("inlet")) {
    return "进风口温度";
  }

  if (lowerName.includes("exhaust")) {
    return "出风口温度";
  }

  if (lowerName.includes("ambient")) {
    return "环境温度";
  }

  if (lowerName.includes("system board") || lowerName.includes("mb")) {
    return "主板温度";
  }

  if (lowerName.includes("redund")) {
    return "冗余状态";
  }

  if (lowerName.includes("intrusion")) {
    return "机箱入侵状态";
  }

  if (lowerName.includes("voltage")) {
    return "电压";
  }

  if (lowerName.includes("current")) {
    return "电流";
  }

  if (lowerName.includes("power")) {
    return "功率";
  }

  return trimmedName;
}

function getCategory(lowerName, lowerValue) {
  if (lowerName.includes("fan") || lowerValue.includes("rpm")) {
    return "fan";
  }

  if (lowerName.includes("temp") || lowerName.includes("ambient") || lowerName.includes("inlet") || lowerName.includes("exhaust") || lowerName.includes("cpu") || lowerValue.includes("degrees c")) {
    return "temperature";
  }

  if (lowerName.includes("power") || lowerName.includes("pwr") || lowerName.includes("consumption") || lowerName.includes("watt") || lowerName.includes("psu") || lowerName.includes("voltage") || lowerName.includes("volt") || lowerName.includes("current") || lowerName.includes("amp") || lowerValue.includes("volts") || lowerValue.includes("watts")) {
    return "power";
  }

  if (lowerValue === "0x0" || lowerValue === "0x1" || lowerName.includes("status") || lowerName.includes("intrusion")) {
    return "status";
  }

  return "other";
}

function getSeverity(lowerStatus, lowerValue) {
  if (lowerStatus.includes("ok") || lowerStatus.includes("ns")) {
    return "good";
  }

  if (lowerStatus.includes("cr") || lowerStatus.includes("nr") || lowerStatus.includes("fail")) {
    return "danger";
  }

  if (lowerValue === "na" || lowerStatus.includes("nc")) {
    return "warning";
  }

  return "neutral";
}

function translateSensorValue(name, value, status, category) {
  const trimmedValue = String(value || "").trim();
  const lowerName = String(name || "").trim().toLowerCase();
  const lowerValue = trimmedValue.toLowerCase();
  const lowerStatus = String(status || "").trim().toLowerCase();

  if (!trimmedValue || lowerValue === "na") {
    return "暂无数据";
  }

  if (trimmedValue === "0x0" || trimmedValue === "0x1") {
    return translateDiscreteValue(lowerName, trimmedValue, lowerStatus);
  }

  if (lowerValue === "presence detected") {
    return "已检测到设备";
  }

  if (lowerValue === "entity present") {
    return "设备在线";
  }

  if (lowerValue === "entity absent") {
    return "设备不在线";
  }

  if (lowerValue === "fully redundant") {
    return "完全冗余";
  }

  if (lowerValue === "redundancy lost") {
    return "冗余丢失";
  }

  if (lowerValue === "predictive failure asserted") {
    return "预测到故障";
  }

  if (lowerValue === "disabled") {
    return "已禁用";
  }

  if (lowerValue === "enabled") {
    return "已启用";
  }

  if (lowerValue.endsWith("degrees c")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${formatNumber(number)} 摄氏度` : trimmedValue.replace(/degrees c/i, "摄氏度");
  }

  if (lowerValue.endsWith("rpm")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${Math.round(number)} 转/分` : trimmedValue.replace(/rpm/i, "转/分");
  }

  if (lowerValue.endsWith("volts")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${formatNumber(number)} 伏` : trimmedValue.replace(/volts/i, "伏");
  }

  if (lowerValue.endsWith("amps")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${formatNumber(number)} 安` : trimmedValue.replace(/amps/i, "安");
  }

  if (lowerValue.endsWith("watts")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${formatNumber(number)} 瓦` : trimmedValue.replace(/watts/i, "瓦");
  }

  if (lowerValue.endsWith("%")) {
    const number = extractNumber(trimmedValue);
    return Number.isFinite(number) ? `${formatNumber(number)}%` : trimmedValue;
  }

  if (category === "status" && lowerStatus === "ok") {
    return "正常";
  }

  return trimmedValue;
}

function translateDiscreteValue(lowerName, value, lowerStatus) {
  if (lowerName.includes("intrusion")) {
    return value === "0x0" ? "未触发入侵" : "检测到入侵";
  }

  if (lowerName.includes("presence")) {
    return value === "0x0" ? "设备不在位" : "设备在位";
  }

  if (lowerName.includes("redund")) {
    return value === "0x0" ? "已冗余" : "冗余异常";
  }

  if (lowerName.includes("status")) {
    if (lowerStatus === "ok") {
      return value === "0x0" ? "正常" : `状态值 ${value}`;
    }

    return `异常状态 ${value}`;
  }

  return value === "0x0" ? "关闭 / 未触发" : "开启 / 已触发";
}

function buildSensorTip(lowerName, category, severity, value, status) {
  const lowerValue = String(value || "").trim().toLowerCase();
  const lowerStatus = String(status || "").trim().toLowerCase();

  if (!value || lowerValue === "na") {
    return "可能不支持该项，或当前没有读取到有效数据。";
  }

  if (severity === "danger") {
    if (category === "temperature") {
      return "温度状态异常，建议尽快检查散热和风扇策略。";
    }

    if (category === "fan") {
      return "风扇状态异常，建议检查风扇模块和转速设置。";
    }

    if (category === "power") {
      return "供电状态异常，建议检查电源模块和输入电压。";
    }

    return "当前项目状态异常，建议尽快排查。";
  }

  if (severity === "warning") {
    if (category === "temperature") {
      return "温度读数需要关注，建议留意后续变化。";
    }

    if (category === "fan") {
      return "风扇读数不完整或状态一般，建议观察是否持续异常。";
    }

    if (category === "power") {
      return "供电信息存在告警，建议结合电源状态一起看。";
    }

    return "当前项目建议关注，但不一定代表故障。";
  }

  if (lowerName.includes("intrusion")) {
    return lowerValue === "0x0" ? "机箱未触发入侵，当前正常。" : "检测到机箱入侵记录，建议确认是否为历史事件。";
  }

  if (lowerName.includes("presence")) {
    return lowerValue === "0x1" || lowerValue === "presence detected"
      ? "设备已识别在位。"
      : "设备可能未在位，建议确认硬件连接。";
  }

  if (lowerName.includes("redund")) {
    return lowerValue === "0x0" || lowerValue === "fully redundant"
      ? "冗余状态正常。"
      : "冗余能力可能下降，建议检查对应模块。";
  }

  if (category === "temperature") {
    return "这是温度监控项，可用于判断当前散热是否稳定。";
  }

  if (category === "fan") {
    return "这是风扇实时转速，可用来观察当前散热强度。";
  }

  if (category === "power") {
    return "这是供电相关读数，通常用来辅助排查电源问题。";
  }

  if (category === "status") {
    return lowerStatus === "ok" ? "当前状态正常。" : "这是状态位项目，可结合原始返回进一步判断。";
  }

  return "当前项目看起来正常，如有疑问可展开查看原始返回。";
}

function describeSensor(lowerName, category, value) {
  if (lowerName.includes("inlet")) {
    return "进风口温度，接近机房环境温度。";
  }

  if (lowerName.includes("exhaust")) {
    return "出风口温度，用来观察整机排热情况。";
  }

  if (lowerName.includes("cpu")) {
    return "处理器相关温度，偏高时通常会触发更高风扇转速。";
  }

  if (lowerName.includes("fan")) {
    return "风扇当前转速，数值越高代表转得越快。";
  }

  if (category === "power") {
    return "供电或电压相关项目，通常用于查看电源工作是否稳定。";
  }

  if (category === "status") {
    return "状态类项目，通常不是连续数值，而是正常/异常标志。";
  }

  if (value.toLowerCase() === "na") {
    return "当前没有读取到有效值，可能是该机型不支持或该项未启用。";
  }

  return "这是 BMC 返回的监控项，已尽量按用途归类展示。";
}

function formatStatus(status, value = "") {
  const lowerStatus = String(status || "").toLowerCase();
  const lowerValue = String(value || "").toLowerCase();
  if (lowerStatus === "ok") {
    return "正常";
  }
  if (lowerStatus === "ns") {
    return lowerValue === "na" ? "未提供状态" : "已启用";
  }
  if (lowerStatus === "nc") {
    return "无连接";
  }
  if (lowerStatus === "cr") {
    return "临界";
  }
  if (lowerStatus === "nr") {
    return "严重";
  }
  return status || "未知";
}

function formatValue(value) {
  if (!value || String(value).trim().toLowerCase() === "na") {
    return "暂无数据";
  }
  return String(value).trim();
}

function extractNumber(text) {
  const match = String(text || "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

loginForm.addEventListener("submit", async (event) => {
  try {
    await login(event);
  } catch (error) {
    showMessage(error.message, true);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await logout();
  } catch (error) {
    showMessage(error.message, true);
  }
});

speedRange.addEventListener("input", () => syncSpeed(speedRange.value));

document.querySelectorAll(".preset-button").forEach((button) => {
  button.addEventListener("click", () => {
    syncSpeed(button.dataset.speed);
  });
});

setManualButton.addEventListener("click", async () => {
  try {
    await setManualSpeed();
  } catch (error) {
    showMessage(error.message, true);
  }
});

setAutoButton.addEventListener("click", async () => {
  try {
    await setAutoMode();
  } catch (error) {
    showMessage(error.message, true);
  }
});

refreshSensorsButton.addEventListener("click", async () => {
  try {
    await refreshSensors();
  } catch (error) {
    showMessage(error.message, true);
  }
});

async function initialize() {
  syncSpeed(speedRange.value);

  try {
    const session = await apiFetch("/api/auth/session", {}, true);
    if (!session.authenticated) {
      enterLoggedOutState();
      return;
    }

    enterDashboardState(session);
    if (!session.serverConfigured) {
      renderSensorDashboard([]);
      showMessage("服务端已登录，但还没有配置好 IPMI 参数。", true);
      return;
    }

    startAutoRefresh();
    await loadDashboardData();
  } catch (error) {
    enterLoggedOutState();
    showMessage(error.message, true);
  }
}

initialize();
