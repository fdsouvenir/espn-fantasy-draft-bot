(() => {
  const params = new URLSearchParams(window.location.search);
  const requestedDraft = params.get("draft");
  const draftKey = requestedDraft && /^[a-zA-Z0-9:._-]{1,180}$/.test(requestedDraft)
    ? requestedDraft
    : null;
  const mockMode = params.get("mock") === "1";
  const POLL_MS = 15_000;
  const TRANSPORT_STALE_MS = 35_000;

  const dom = {
    connectionPill: document.querySelector("#connection-pill"),
    connectionLabel: document.querySelector("#connection-label"),
    alertRegion: document.querySelector("#alert-region"),
    recommendationGrid: document.querySelector("#recommendation-grid"),
    recommendationContext: document.querySelector("#recommendation-context"),
    availableBody: document.querySelector("#available-body"),
    availableEmpty: document.querySelector("#available-empty"),
    rosterList: document.querySelector("#roster-list"),
    rosterCount: document.querySelector("#roster-count"),
    needsList: document.querySelector("#needs-list"),
    returnList: document.querySelector("#return-list"),
    rbBoard: document.querySelector("#rb-board"),
    pickLabel: document.querySelector("#pick-label"),
    roundLabel: document.querySelector("#round-label"),
    progressCopy: document.querySelector("#progress-copy"),
    progressFill: document.querySelector("#progress-fill"),
    progressBar: document.querySelector(".progress-track"),
    lastSync: document.querySelector("#last-sync"),
    nextPick: document.querySelector("#next-pick"),
    pickClock: document.querySelector("#pick-clock"),
    revisionLabel: document.querySelector("#revision-label"),
    buildLabel: document.querySelector("#build-label"),
    modeLabel: document.querySelector("#mode-label"),
    companionStatus: document.querySelector("#companion-status"),
    companionDevices: document.querySelector("#companion-devices")
  };

  async function loadCompanionDevices() {
    if (!dom.companionDevices) return;
    try {
      const response = await fetch("/api/v1/companion/devices", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`device list ${response.status}`);
      const payload = await response.json();
      const devices = Array.isArray(payload.devices) ? payload.devices : [];
      dom.companionDevices.replaceChildren();
      dom.companionStatus.textContent = devices.some((device) => !device.revokedAt) ? "Connected" : "Not connected";
      if (!devices.length) {
        dom.companionDevices.append(node("p", "section-note", "Open the Draftside laptop app. It will appear here automatically."));
        return;
      }
      devices.forEach((device) => {
        const row = node("div", "companion-device");
        const copy = node("div", "");
        copy.append(node("strong", "", device.name || "Draft laptop"));
        copy.append(node("span", "section-note", device.revokedAt ? "Revoked" : `Draftside ${device.version || ""} · connected`));
        const action = document.createElement("button");
        action.type = "button";
        action.className = device.revokedAt ? "filter-button" : "filter-button danger-button";
        action.textContent = device.revokedAt ? "Re-enable" : "Revoke";
        action.addEventListener("click", async () => {
          action.disabled = true;
          const verb = device.revokedAt ? "enable" : "revoke";
          const result = await fetch(`/api/v1/companion/devices/${encodeURIComponent(device.deviceId)}/${verb}`, {
            cache: "no-store",
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json" }
          });
          if (!result.ok) action.disabled = false;
          else await loadCompanionDevices();
        });
        row.append(copy, action);
        dom.companionDevices.append(row);
      });
    } catch (_error) {
      dom.companionStatus.textContent = "Unavailable";
      dom.companionDevices.replaceChildren(node("p", "section-note", "Companion controls are unavailable right now."));
    }
  }

  const app = {
    snapshot: null,
    position: "ALL",
    socket: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    pollingTimer: null,
    staleTimer: null,
    lastSuccessfulFetch: 0,
    connectionState: "loading",
    clockRemaining: null,
    clockTimer: null
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function firstArray(...values) {
    return values.find(Array.isArray) || [];
  }

  function clamp(value, min = 0, max = 100) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function percent(value) {
    const raw = number(value);
    return Math.round(raw <= 1 ? raw * 100 : raw);
  }

  function displayTier(value) {
    return String(value ?? "—").replace(/^T/i, "");
  }

  function timeAgo(iso) {
    if (!iso) return "No ingest yet";
    const elapsed = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(elapsed)) return "Sync time unknown";
    if (elapsed < 5_000) return "Synced now";
    if (elapsed < 60_000) return `Synced ${Math.floor(elapsed / 1000)}s ago`;
    return `Synced ${Math.floor(elapsed / 60_000)}m ago`;
  }

  function normalizePlayer(raw = {}, index = 0) {
    const returnProbability = raw.returnProbability ?? raw.likelyToReturn ?? raw.return_probability;
    return {
      id: String(raw.playerId ?? raw.player_id ?? raw.id ?? `player-${index}`),
      name: raw.name ?? raw.displayName ?? raw.fullName ?? "Unknown player",
      position: String(raw.position ?? raw.pos ?? "—").toUpperCase(),
      team: raw.nflTeam ?? raw.proTeam ?? raw.team ?? "FA",
      tier: displayTier(raw.tier ?? raw.positionTier),
      rank: number(raw.rank ?? raw.overallRank ?? raw.scoreRank ?? raw.pickNowRank, index + 1),
      score: clamp(raw.score ?? raw.recommendationScore ?? raw.draftScore ?? raw.pickNowScore ?? 0),
      adp: number(raw.adp ?? raw.averageDraftPosition, 0),
      value: number(raw.value ?? raw.adpValue ?? raw.valueOverAdp ?? (
        raw.adp !== undefined && raw.pickNowRank !== undefined ? number(raw.adp) - number(raw.pickNowRank) : 0
      ), 0),
      role: raw.role ?? raw.roleClass ?? raw.depthRole ?? "unknown",
      reason: raw.reason ?? firstArray(raw.reasons, raw.explanation).join(" · ") ?? "No explanation available.",
      risk: raw.risk ?? firstArray(raw.risks).join(" · ") ?? "",
      returnProbability: returnProbability === undefined ? null : percent(returnProbability),
      snapShare: percent(raw.snapShare ?? raw.snap_share_mid ?? raw.workload ?? 0),
      opportunity: number(raw.opportunity ?? raw.opportunityScore ?? raw.workloadScore, 0),
      depthOrdinal: raw.depthOrdinal ?? null,
      contingentUpside: raw.contingentUpside ?? raw.contingent_value ?? raw.upside ?? "",
      byeWeek: raw.byeWeek ?? raw.bye ?? null
    };
  }

  function normalizeSnapshot(raw) {
    const health = raw.health || {};
    const draft = raw.draft || raw.meta || {};
    const team = raw.managedTeam || raw.team || raw.myTeam || raw.cloudFootball || {};
    const recommendations = firstArray(raw.recommendations, raw.bestAvailable, raw.rankings)
      .map(normalizePlayer);
    const available = firstArray(raw.available, raw.availablePlayers, raw.players)
      .filter((player) => player.available !== false && player.drafted !== true)
      .map(normalizePlayer);
    const rbOpportunity = firstArray(raw.rbOpportunity, raw.rbOpportunityBoard, raw.runningBacks)
      .map(normalizePlayer);
    const roster = firstArray(team.roster, raw.roster, raw.managedRoster).map((player, index) => ({
      ...normalizePlayer(player, index),
      pick: player.overallPick ?? player.pick ?? player.draftedAt ?? null
    }));
    const likelyToReturn = firstArray(raw.likelyToReturn, raw.returnProbabilities)
      .map(normalizePlayer);
    const status = raw.status ?? draft.status ?? "unknown";
    const explicitCurrentPick = draft.currentPick ?? draft.current ?? raw.currentPick;
    const currentPick = status === "complete" || explicitCurrentPick === null
      ? null
      : number(explicitCurrentPick ?? (health.lastOverallPick !== undefined ? number(health.lastOverallPick) + 1 : 0), 0);
    const totalPicks = number(draft.totalPicks ?? raw.totalPicks ?? health.totalPickSlots ?? ((draft.expectedTeams || 0) * (draft.expectedRounds || 0)), 0);
    const persistedNeeds = raw.needs && !Array.isArray(raw.needs) && raw.needs.baseDeficits
      ? Object.entries(raw.needs.baseDeficits).map(([position, deficit]) => ({
          position,
          priority: number(deficit) > 0 ? "urgent" : "met"
        })).concat([{ position: "FLEX", priority: raw.needs.flexMet ? "met" : "open" }])
      : [];

    return {
      revision: number(raw.revision ?? draft.revision, 0),
      build: raw.buildVersion ?? health.buildVersion ?? "Local preview",
      status,
      recommendations,
      available,
      rbOpportunity: rbOpportunity.length ? rbOpportunity : available.filter((p) => p.position === "RB"),
      roster,
      needs: firstArray(team.needs, Array.isArray(raw.needs) ? raw.needs : null, persistedNeeds),
      likelyToReturn: likelyToReturn.length ? likelyToReturn : recommendations.filter((p) => p.returnProbability !== null),
      health: {
        missing: firstArray(health.missingOverallPicks, health.missingPicks, raw.missingOverallPicks),
        hasGap: Boolean(health.hasGap),
        conflicts: number(health.conflicts ?? health.conflictCount, 0),
        manualMode: Boolean(health.manualMode ?? raw.manualMode),
        stale: status !== "complete" && Boolean(health.stale || health.ingestorStatus === "stale" || health.ingestorStatus === "dead"),
        ingestorStatus: status === "complete" ? "healthy" : health.ingestorStatus ?? (health.lastIngestAt ? "unknown" : "never_seen"),
        staleAfterSeconds: number(health.staleAfterSeconds, 45),
        deadAfterSeconds: number(health.deadAfterSeconds, 120),
        lastIngestAt: health.lastIngestAt ?? health.lastIngestTime ?? draft.updatedAt ?? raw.serverTime ?? null
      },
      draft: {
        currentPick,
        totalPicks,
        round: number(draft.round ?? raw.currentRound, 0),
        roundPick: number(draft.roundPick ?? raw.roundPick, 0),
        nextTeamPick: draft.nextTeamPick ?? team.nextPick ?? raw.nextTeamPick ?? null,
        picksAway: draft.picksAway ?? team.picksAway ?? null,
        pickClockSeconds: draft.pickClockSeconds ?? raw.pickClockSeconds ?? null
      }
    };
  }

  function setConnection(state, detail) {
    app.connectionState = state;
    const labels = {
      loading: "Connecting",
      connected: "Live",
      reconnecting: "Reconnecting",
      stale: "Stale data",
      error: "Offline",
      mock: "Mock data"
    };
    dom.connectionPill.className = `connection-pill is-${state}`;
    dom.connectionLabel.textContent = detail || labels[state] || state;
  }

  function showSkeletons() {
    dom.recommendationGrid.replaceChildren();
    const template = document.querySelector("#recommendation-skeleton");
    for (let i = 0; i < 3; i += 1) dom.recommendationGrid.append(template.content.cloneNode(true));
  }

  function renderAlerts(snapshot) {
    dom.alertRegion.replaceChildren();
    const alerts = [];
    if (snapshot.health.hasGap || snapshot.health.missing.length) {
      const picks = snapshot.health.missing.slice(0, 8).join(", ");
      alerts.push(["warning", `Pick gap detected${picks ? `: ${picks}` : ""}. Recommendations are paused until the board is reconciled.`]);
    }
    if (snapshot.health.conflicts > 0) alerts.push(["error", `${snapshot.health.conflicts} conflicting pick event${snapshot.health.conflicts === 1 ? "" : "s"} require review.`]);
    if (snapshot.health.manualMode) alerts.push(["info", "Manual pick mode is active. Confirm entries against ESPN before acting."]);
    if (snapshot.health.ingestorStatus === "dead") alerts.push(["error", "The ESPN ingestor has stopped reporting. Recommendations are paused until ingestion recovers."]);
    else if (snapshot.health.stale) alerts.push(["warning", "The ESPN ingestor is stale. Verify the ESPN board before making a pick."]);
    alerts.forEach(([kind, message]) => {
      dom.alertRegion.append(node("div", `alert alert-${kind}`, message));
    });
  }

  function renderRecommendations(players, blocked) {
    dom.recommendationGrid.replaceChildren();
    dom.recommendationGrid.setAttribute("aria-busy", "false");
    if (blocked) {
      const empty = node("p", "empty-state", "Recommendations paused while the pick sequence is reconciled.");
      dom.recommendationGrid.append(empty);
      return;
    }
    if (!players.length) {
      dom.recommendationGrid.append(node("p", "empty-state", "No recommendations are available yet."));
      return;
    }

    players.slice(0, 3).forEach((player, index) => {
      const card = node("article", "recommendation-card");
      const top = node("div", "player-topline");
      top.append(node("span", "rank-chip", `#${index + 1}`));
      top.append(node("span", "score-ring", Math.round(player.score) || "—"));
      card.append(top);
      card.append(node("h3", "player-name", player.name));
      const meta = node("div", "player-meta");
      meta.append(node("span", "position-badge", player.position));
      meta.append(node("span", "", player.team));
      meta.append(node("span", "tier-pill", `Tier ${player.tier}`));
      card.append(meta);
      card.append(node("p", "reason", player.reason || "Ranked by current roster needs and board value."));
      card.append(node("p", "risk", player.risk ? `Watch: ${player.risk}` : "No material risk flag"));
      const footer = node("div", "card-footer");
      footer.append(node("span", "", player.adp ? `ADP ${player.adp.toFixed(1)}` : "ADP —"));
      footer.append(node("span", "return-prob", player.returnProbability === null
        ? "Experimental return estimate —"
        : `${player.returnProbability}% experimental return estimate`));
      card.append(footer);
      dom.recommendationGrid.append(card);
    });
  }

  function renderAvailable(players) {
    const filtered = players
      .filter((player) => app.position === "ALL" || player.position === app.position)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 24);
    dom.availableBody.replaceChildren();
    dom.availableEmpty.hidden = filtered.length > 0;
    filtered.forEach((player) => {
      const row = document.createElement("tr");
      const rankCell = node("td", "table-rank", player.rank);
      const playerCell = node("td", "table-player", player.name);
      playerCell.append(node("small", "", `${player.position} · ${player.team}`));
      const tierCell = node("td");
      tierCell.append(node("span", "tier-pill", `T${player.tier}`));
      const roleCell = node("td");
      roleCell.append(node("span", "role-pill", String(player.role).replaceAll("-", " ")));
      const adpCell = node("td", "", player.adp ? player.adp.toFixed(1) : "—");
      const valueCell = node("td", player.value >= 0 ? "value-up" : "value-down", `${player.value > 0 ? "+" : ""}${player.value.toFixed(1)}`);
      row.append(rankCell, playerCell, tierCell, roleCell, adpCell, valueCell);
      dom.availableBody.append(row);
    });
  }

  function renderRoster(roster, needs) {
    dom.rosterCount.textContent = roster.length;
    dom.rosterList.replaceChildren();
    dom.needsList.replaceChildren();
    const normalizedNeeds = needs.length ? needs : ["QB", "RB", "WR", "TE"].map((position) => ({ position, priority: "open" }));
    normalizedNeeds.forEach((rawNeed) => {
      const need = typeof rawNeed === "string" ? { position: rawNeed, priority: "open" } : rawNeed;
      const priority = String(need.priority ?? need.status ?? "open").toLowerCase();
      const className = priority === "urgent" || priority === "high" ? " is-urgent" : priority === "met" || priority === "filled" ? " is-met" : "";
      dom.needsList.append(node("span", `need-chip${className}`, `${need.position ?? need.slot ?? "FLEX"} · ${priority}`));
    });
    if (!roster.length) {
      const item = node("li", "empty-state", "No managed-team picks yet.");
      dom.rosterList.append(item);
      return;
    }
    roster.forEach((player) => {
      const item = node("li", "roster-item");
      item.append(node("span", "roster-pos", player.position));
      const identity = node("div");
      identity.append(node("div", "roster-name", player.name));
      identity.append(node("div", "roster-team", `${player.team}${player.byeWeek ? ` · Bye ${player.byeWeek}` : ""}`));
      item.append(identity);
      item.append(node("span", "roster-pick", player.pick ? `#${player.pick}` : "Keeper"));
      dom.rosterList.append(item);
    });
  }

  function renderReturns(players) {
    dom.returnList.replaceChildren();
    const usable = players.filter((p) => p.returnProbability !== null).slice(0, 6);
    if (!usable.length) {
      dom.returnList.append(node("li", "empty-state", "Experimental return estimates are not available yet."));
      return;
    }
    usable.forEach((player) => {
      const item = node("li", "return-item");
      const identity = node("div");
      identity.append(node("span", "return-name", player.name));
      identity.append(node("span", "return-meta", `${player.position} · ${player.team} · Tier ${player.tier}`));
      item.append(identity, node("span", "return-value", `${player.returnProbability}%`));
      dom.returnList.append(item);
    });
  }

  function roleLane(player) {
    if (player.depthOrdinal === 1) return "Starter / lead";
    if (player.depthOrdinal === 2) return "Committee";
    if (number(player.depthOrdinal) >= 3) return "Backup / contingent";
    const normalized = String(player.role).toLowerCase();
    if (normalized.includes("starter") || normalized.includes("lead")) return "Starter / lead";
    if (normalized.includes("committee") || normalized.includes("passing") || normalized.includes("goal")) return "Committee";
    return "Backup / contingent";
  }

  function renderRbBoard(players) {
    dom.rbBoard.replaceChildren();
    const lanes = ["Starter / lead", "Committee", "Backup / contingent"];
    lanes.forEach((laneName) => {
      const lanePlayers = players.filter((player) => roleLane(player) === laneName).slice(0, 5);
      const lane = node("section", "rb-lane");
      const heading = node("div", "lane-title");
      heading.append(node("span", "", laneName), node("span", "lane-count", lanePlayers.length));
      lane.append(heading);
      if (!lanePlayers.length) lane.append(node("p", "empty-state", "No backs in this lane."));
      lanePlayers.forEach((player) => {
        const entry = node("article", "rb-player");
        const head = node("div", "rb-player-head");
        head.append(node("strong", "", player.name), node("span", "", Math.round(player.opportunity || player.score) || "—"));
        entry.append(head);
        const upside = player.contingentUpside ? ` · ${player.contingentUpside}` : "";
        entry.append(node("p", "rb-player-meta", `${player.team} · ${String(player.role).replaceAll("-", " ")}${upside}`));
        const workload = node("div", "workload-track");
        const signal = player.snapShare || player.opportunity;
        workload.setAttribute("aria-label", `${player.name} opportunity signal ${Math.round(signal)} out of 100`);
        const fill = node("span");
        fill.style.width = `${clamp(signal)}%`;
        workload.append(fill);
        entry.append(workload);
        lane.append(entry);
      });
      dom.rbBoard.append(lane);
    });
  }

  function renderProgress(snapshot) {
    const { currentPick, totalPicks, round, roundPick, nextTeamPick, picksAway, pickClockSeconds } = snapshot.draft;
    const completedPicks = currentPick ? Math.max(0, currentPick - 1) : totalPicks;
    const progress = totalPicks ? clamp((completedPicks / totalPicks) * 100) : 0;
    dom.pickLabel.textContent = currentPick ? `Pick ${currentPick} of ${totalPicks || "—"}` : "Draft complete";
    dom.roundLabel.textContent = round ? `Round ${round}${roundPick ? ` · Pick ${roundPick}` : ""}` : "";
    dom.progressCopy.textContent = totalPicks ? `${completedPicks} picks complete · ${Math.round(progress)}%` : `${completedPicks} picks complete`;
    dom.progressFill.style.width = `${progress}%`;
    dom.progressBar.setAttribute("aria-valuenow", String(Math.round(progress)));
    dom.lastSync.textContent = timeAgo(snapshot.health.lastIngestAt);
    dom.nextPick.textContent = currentPick === null
      ? "Complete"
      : nextTeamPick
        ? `#${nextTeamPick}${picksAway !== null ? ` · ${picksAway} away` : ""}`
        : "Calculating";
    if (pickClockSeconds !== null) startClock(number(pickClockSeconds));
  }

  function startClock(seconds) {
    app.clockRemaining = Math.max(0, seconds);
    if (app.clockTimer) clearInterval(app.clockTimer);
    const tick = () => {
      const mins = Math.floor(app.clockRemaining / 60);
      const secs = app.clockRemaining % 60;
      dom.pickClock.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      if (app.clockRemaining > 0) app.clockRemaining -= 1;
    };
    tick();
    app.clockTimer = window.setInterval(tick, 1000);
  }

  function render(raw) {
    const snapshot = normalizeSnapshot(raw);
    app.snapshot = snapshot;
    const blocked = snapshot.health.hasGap || snapshot.health.missing.length > 0 || snapshot.health.conflicts > 0 || snapshot.health.stale;
    if (!mockMode && snapshot.status === "complete") setConnection("connected", "Draft complete");
    else if (!mockMode && snapshot.health.ingestorStatus === "dead") setConnection("error", "Ingestor stopped");
    else if (!mockMode && snapshot.health.stale) setConnection("stale", "Ingestor stale");
    else if (!mockMode && app.socket?.readyState === WebSocket.OPEN) setConnection("connected");
    renderAlerts(snapshot);
    renderRecommendations(snapshot.recommendations, blocked);
    renderAvailable(snapshot.available);
    renderRoster(snapshot.roster, snapshot.needs);
    renderReturns(snapshot.likelyToReturn);
    renderRbBoard(snapshot.rbOpportunity);
    renderProgress(snapshot);
    dom.revisionLabel.textContent = `Revision ${snapshot.revision}`;
    dom.buildLabel.textContent = snapshot.build;
    dom.recommendationContext.textContent = snapshot.status === "complete"
      ? "Final board state. Recommendations are retained for review."
      : blocked
        ? "Recommendations paused until board integrity is restored."
        : "Recommendations update with every confirmed pick.";
  }

  async function fetchSnapshot({ quiet = false } = {}) {
    if (mockMode) {
      render(MOCK_SNAPSHOT);
      app.lastSuccessfulFetch = Date.now();
      setConnection("mock");
      return;
    }
    try {
      const response = await fetch(`/api/v1/drafts/${encodeURIComponent(draftKey)}/snapshot`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
      const payload = await response.json();
      render(payload);
      app.lastSuccessfulFetch = Date.now();
      if ((!app.socket || app.socket.readyState !== WebSocket.OPEN) && !app.snapshot.health.stale) {
        setConnection("reconnecting", "Polling");
      }
    } catch (error) {
      if (!quiet || !app.snapshot) showFetchError(error);
      if (!app.snapshot) setConnection("error");
    }
  }

  function showFetchError(error) {
    dom.alertRegion.replaceChildren();
    const message = error instanceof Error ? error.message : "Unable to load the draft snapshot.";
    dom.alertRegion.append(node("div", "alert alert-error", `${message} Retrying automatically.`));
    if (!app.snapshot) {
      dom.recommendationGrid.replaceChildren(node("p", "empty-state", "The draft board could not be loaded."));
      dom.recommendationGrid.setAttribute("aria-busy", "false");
    }
  }

  function connectSocket() {
    if (mockMode || !draftKey) return;
    if (app.socket) app.socket.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/v1/drafts/${encodeURIComponent(draftKey)}/ws`;
    setConnection(app.snapshot ? "reconnecting" : "loading");
    const socket = new WebSocket(url);
    app.socket = socket;

    socket.addEventListener("open", () => {
      app.reconnectAttempt = 0;
      if (!app.snapshot?.health.stale) setConnection("connected");
      fetchSnapshot({ quiet: true });
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        const incomingRevision = number(message.revision, 0);
        const currentRevision = app.snapshot?.revision || 0;
        if (message.type === "snapshot_required" || incomingRevision > currentRevision) {
          if (incomingRevision > currentRevision + 1 && currentRevision > 0) {
            setConnection("reconnecting", "Syncing gap");
          }
          fetchSnapshot({ quiet: true });
        }
      } catch (_error) {
        fetchSnapshot({ quiet: true });
      }
    });
    socket.addEventListener("close", () => scheduleReconnect());
    socket.addEventListener("error", () => socket.close());
  }

  function scheduleReconnect() {
    if (mockMode) return;
    setConnection(app.snapshot ? "reconnecting" : "error");
    const delay = Math.min(30_000, 1000 * (2 ** app.reconnectAttempt));
    app.reconnectAttempt += 1;
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = window.setTimeout(connectSocket, delay);
  }

  function checkStale() {
    if (mockMode || !app.lastSuccessfulFetch) return;
    if (Date.now() - app.lastSuccessfulFetch > TRANSPORT_STALE_MS) {
      setConnection("error", "Dashboard offline");
    }
    if (app.snapshot) {
      const lastIngest = Date.parse(app.snapshot.health.lastIngestAt || "");
      const elapsedSeconds = Number.isFinite(lastIngest) ? (Date.now() - lastIngest) / 1000 : 0;
      if (app.snapshot.status === "live" && elapsedSeconds >= app.snapshot.health.staleAfterSeconds) {
        app.snapshot.health.stale = true;
        app.snapshot.health.ingestorStatus = elapsedSeconds >= app.snapshot.health.deadAfterSeconds ? "dead" : "stale";
        setConnection(app.snapshot.health.ingestorStatus === "dead" ? "error" : "stale", app.snapshot.health.ingestorStatus === "dead" ? "Ingestor stopped" : "Ingestor stale");
        renderAlerts(app.snapshot);
      }
      dom.lastSync.textContent = timeAgo(app.snapshot.health.lastIngestAt);
    }
  }

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      app.position = button.dataset.position;
      document.querySelectorAll(".filter-button").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      if (app.snapshot) renderAvailable(app.snapshot.available);
    });
  });

  const MOCK_SNAPSHOT = {
    revision: 47,
    buildVersion: "Portfolio demo · sample",
    serverTime: new Date().toISOString(),
    status: "inProgress",
    draft: { currentPick: 58, totalPicks: 192, round: 5, roundPick: 10, nextTeamPick: 63, picksAway: 5, pickClockSeconds: 84 },
    health: { hasGap: false, missingOverallPicks: [], conflictCount: 0, manualMode: false, lastIngestAt: new Date().toISOString() },
    recommendations: [
      { playerId: "sample-1", name: "Devin Mercer", position: "RB", nflTeam: "ARI", tier: 3, rank: 27, score: 94, adp: 66.2, value: 9.2, role: "starter", snapShare: .68, opportunityScore: 91, contingentUpside: "Secure goal-line role", reason: "Clear three-down path in a thinning RB tier; fills the highest-priority roster need.", risk: "New offensive coordinator", returnProbability: .18 },
      { playerId: "sample-2", name: "Malik Rowan", position: "WR", nflTeam: "SEA", tier: 3, rank: 31, score: 89, adp: 61.8, value: 4.8, role: "starter", snapShare: .84, reason: "Best remaining target-share projection with a meaningful value cushion against ADP.", risk: "Volatile weekly volume", returnProbability: .34 },
      { playerId: "sample-3", name: "Trey Holloway", position: "TE", nflTeam: "LAC", tier: 2, rank: 38, score: 84, adp: 72.4, value: 12.4, role: "starter", snapShare: .77, reason: "Last player in the current TE tier and unlikely to survive the turn after the recent run.", risk: "Rookie efficiency uncertainty", returnProbability: .11 }
    ],
    availablePlayers: [
      { name: "Devin Mercer", position: "RB", nflTeam: "ARI", tier: 3, rank: 27, adp: 66.2, value: 9.2, role: "starter", snapShare: .68, opportunityScore: 91, contingentUpside: "Goal-line lead" },
      { name: "Malik Rowan", position: "WR", nflTeam: "SEA", tier: 3, rank: 31, adp: 61.8, value: 4.8, role: "starter" },
      { name: "Trey Holloway", position: "TE", nflTeam: "LAC", tier: 2, rank: 38, adp: 72.4, value: 12.4, role: "starter" },
      { name: "Jordan Banks", position: "RB", nflTeam: "DEN", tier: 3, rank: 42, adp: 59.7, value: 2.7, role: "lead-committee", snapShare: .56, opportunityScore: 82, contingentUpside: "Lead if one injury" },
      { name: "Cam Reddick", position: "WR", nflTeam: "BUF", tier: 4, rank: 45, adp: 64.1, value: 1.1, role: "starter" },
      { name: "Nolan Price", position: "QB", nflTeam: "MIN", tier: 4, rank: 48, adp: 78.5, value: 13.5, role: "starter" },
      { name: "Isaiah Cole", position: "RB", nflTeam: "TB", tier: 4, rank: 52, adp: 74.9, value: 9.9, role: "committee", snapShare: .45, opportunityScore: 72, contingentUpside: "Passing-down floor" },
      { name: "Andre Bishop", position: "WR", nflTeam: "NE", tier: 4, rank: 55, adp: 69.3, value: 3.3, role: "starter" },
      { name: "Keon Mills", position: "RB", nflTeam: "KC", tier: 5, rank: 62, adp: 82.7, value: 5.7, role: "backup", snapShare: .28, opportunityScore: 67, contingentUpside: "Lead if one injury" },
      { name: "Miles Grant", position: "TE", nflTeam: "NYJ", tier: 3, rank: 66, adp: 76.1, value: 0.1, role: "starter" },
      { name: "Darius Knox", position: "RB", nflTeam: "DAL", tier: 5, rank: 69, adp: 91.2, value: 15.2, role: "goal-line", snapShare: .31, opportunityScore: 65, contingentUpside: "Goal-line role" },
      { name: "Evan Lake", position: "QB", nflTeam: "ATL", tier: 5, rank: 72, adp: 83.8, value: 4.8, role: "starter" }
    ],
    managedTeam: {
      nextPick: 63,
      needs: [{ position: "RB", priority: "urgent" }, { position: "WR", priority: "open" }, { position: "QB", priority: "open" }, { position: "TE", priority: "met" }],
      roster: [
        { name: "Jalen Cross", position: "WR", nflTeam: "MIA", overallPick: 15, byeWeek: 8 },
        { name: "Marcus Bell", position: "RB", nflTeam: "GB", overallPick: 34, byeWeek: 5 },
        { name: "Theo Warren", position: "TE", nflTeam: "DET", overallPick: 39, byeWeek: 9 },
        { name: "Chris Vaughn", position: "WR", nflTeam: "CIN", overallPick: 58, byeWeek: 10 }
      ]
    },
    likelyToReturn: [
      { name: "Malik Rowan", position: "WR", nflTeam: "SEA", tier: 3, returnProbability: .34 },
      { name: "Isaiah Cole", position: "RB", nflTeam: "TB", tier: 4, returnProbability: .61 },
      { name: "Nolan Price", position: "QB", nflTeam: "MIN", tier: 4, returnProbability: .76 },
      { name: "Cam Reddick", position: "WR", nflTeam: "BUF", tier: 4, returnProbability: .83 }
    ]
  };

  function showDraftRequired() {
    setConnection("error", "Draft not selected");
    dom.modeLabel.textContent = "No draft selected";
    dom.alertRegion.replaceChildren(node("div", "alert alert-info", "Open this private dashboard with a valid ?draft= key. No league is selected by default."));
    dom.recommendationGrid.replaceChildren(node("p", "empty-state", "Select an initialized draft to load recommendations."));
    dom.recommendationGrid.setAttribute("aria-busy", "false");
    dom.availableBody.replaceChildren();
    dom.availableEmpty.hidden = false;
  }

  if (!mockMode && !draftKey) {
    showDraftRequired();
  } else {
    showSkeletons();
    loadCompanionDevices();
    window.setInterval(loadCompanionDevices, 15_000);
    dom.modeLabel.textContent = mockMode ? "Sanitized mock mode" : `Draft ${draftKey}`;
    fetchSnapshot();
    if (!mockMode) connectSocket();
    app.pollingTimer = window.setInterval(() => fetchSnapshot({ quiet: true }), POLL_MS);
    app.staleTimer = window.setInterval(checkStale, 5_000);
  }
})();
