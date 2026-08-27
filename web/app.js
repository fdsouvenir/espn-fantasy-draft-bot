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
    inventoryList: document.querySelector("#inventory-list"),
    researchCoverage: document.querySelector("#research-coverage"),
    availableBody: document.querySelector("#available-body"),
    availableEmpty: document.querySelector("#available-empty"),
    inspector: document.querySelector("#research-inspector"),
    rosterList: document.querySelector("#roster-list"),
    rosterCount: document.querySelector("#roster-count"),
    needsList: document.querySelector("#needs-list"),
    returnList: document.querySelector("#return-list"),
    pickLabel: document.querySelector("#pick-label"),
    roundLabel: document.querySelector("#round-label"),
    progressCopy: document.querySelector("#progress-copy"),
    progressFill: document.querySelector("#progress-fill"),
    progressBar: document.querySelector(".progress-track"),
    lastSync: document.querySelector("#last-sync"),
    nextPick: document.querySelector("#next-pick"),
    pickClock: document.querySelector("#pick-clock"),
    revisionLabel: document.querySelector("#revision-label"),
    researchLabel: document.querySelector("#research-label"),
    buildLabel: document.querySelector("#build-label"),
    modeLabel: document.querySelector("#mode-label"),
    companionStatus: document.querySelector("#companion-status"),
    companionDevices: document.querySelector("#companion-devices"),
  };

  const app = {
    snapshot: null,
    position: "ALL",
    bucket: null,
    selectedPlayerId: null,
    socket: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    pollingTimer: null,
    staleTimer: null,
    lastSuccessfulFetch: 0,
    connectionState: "loading",
    clockRemaining: null,
    clockTimer: null,
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

  function titleCase(value) {
    return String(value ?? "")
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function timeAgo(iso, prefix = "Synced") {
    if (!iso) return "No ingest yet";
    const elapsed = Date.now() - Date.parse(iso);
    if (!Number.isFinite(elapsed)) return "Time unknown";
    if (elapsed < 5_000) return `${prefix} now`;
    if (elapsed < 60_000) return `${prefix} ${Math.floor(elapsed / 1000)}s ago`;
    if (elapsed < 3_600_000) return `${prefix} ${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${prefix} ${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${prefix} ${Math.floor(elapsed / 86_400_000)}d ago`;
  }

  function isExpired(profile) {
    return profile && Number.isFinite(Date.parse(profile.expiresAt)) && Date.parse(profile.expiresAt) <= Date.now();
  }

  function normalizeProfile(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      profileId: String(raw.profileId ?? ""),
      position: String(raw.position ?? "").toUpperCase(),
      role: raw.researchedRole ?? null,
      researchState: raw.researchState ?? "insufficient-evidence",
      unknownReason: raw.unknownReason ?? null,
      taxonomyState: raw.taxonomyState ?? "matched",
      publicationStatus: raw.publicationStatus ?? "needs-review",
      headline: raw.warRoomHeadline ?? "No War Room headline published.",
      currentRole: raw.currentRoleSummary ?? "",
      opportunity: raw.opportunitySummary ?? "",
      competition: raw.competitionSummary ?? "",
      availability: raw.availabilitySummary ?? "",
      draftImplication: raw.draftImplication ?? "",
      contingency: raw.contingency ?? null,
      confidence: raw.confidence ?? "unknown",
      confidenceReason: raw.confidenceReason ?? "",
      alternatives: firstArray(raw.alternativesConsidered),
      unresolved: firstArray(raw.unresolvedQuestions),
      supportingIds: firstArray(raw.supportingObservationIds),
      contradictingIds: firstArray(raw.contradictingObservationIds),
      sources: firstArray(raw.sourceUrls).filter((url) => typeof url === "string" && url.startsWith("https://")),
      findings: raw.structuredFindings && typeof raw.structuredFindings === "object"
        ? raw.structuredFindings
        : {},
      additionalFindings: raw.additionalFindings && typeof raw.additionalFindings === "object"
        ? raw.additionalFindings
        : {},
      researchedAt: raw.researchedAt ?? null,
      classifiedAt: raw.classifiedAt ?? null,
      expiresAt: raw.expiresAt ?? null,
      classifiedBy: raw.classifiedBy ?? "Verl",
    };
  }

  function normalizePlayer(raw = {}, index = 0) {
    const returnProbability = raw.returnProbability ?? raw.likelyToReturn ?? raw.return_probability;
    const profile = normalizeProfile(raw.researchProfile);
    return {
      id: String(raw.playerId ?? raw.player_id ?? raw.id ?? `player-${index}`),
      name: raw.name ?? raw.displayName ?? raw.fullName ?? "Unknown player",
      position: String(raw.position ?? raw.pos ?? "—").toUpperCase().replace("DST", "D/ST"),
      team: raw.nflTeam ?? raw.proTeam ?? raw.team ?? "FA",
      rank: number(raw.rank ?? raw.overallRank ?? raw.pickNowRank, index + 1),
      adp: number(raw.adp ?? raw.averageDraftPosition, 0),
      providerRole: raw.roleClass ?? raw.depthRole ?? "unknown",
      researchBucket: raw.researchInventoryBucket ?? null,
      profile,
      returnProbability: returnProbability === undefined || returnProbability === null
        ? null
        : percent(returnProbability),
      byeWeek: raw.byeWeek ?? raw.bye ?? null,
    };
  }

  function normalizeSnapshot(raw) {
    const health = raw.health || {};
    const draft = raw.draft || raw.meta || {};
    const team = raw.managedTeam || raw.team || raw.myTeam || {};
    const available = firstArray(raw.available, raw.availablePlayers, raw.players)
      .filter((player) => player.available !== false && player.drafted !== true)
      .map(normalizePlayer);
    const roster = firstArray(team.roster, raw.roster, raw.managedRoster).map((player, index) => ({
      ...normalizePlayer(player, index),
      pick: player.overallPick ?? player.pick ?? player.draftedAt ?? null,
    }));
    const likelyToReturn = firstArray(raw.likelyToReturn, raw.returnProbabilities)
      .map(normalizePlayer);
    const status = raw.status ?? draft.status ?? "unknown";
    const explicitCurrentPick = draft.currentPick ?? draft.current ?? raw.currentPick;
    const currentPick = status === "complete" || explicitCurrentPick === null
      ? null
      : number(explicitCurrentPick ?? (health.lastOverallPick !== undefined ? number(health.lastOverallPick) + 1 : 0), 0);
    const totalPicks = number(
      draft.totalPicks ?? raw.totalPicks ?? health.totalPickSlots ??
        ((draft.expectedTeams || 0) * (draft.expectedRounds || 0)),
      0,
    );
    const persistedNeeds = raw.needs && !Array.isArray(raw.needs) && raw.needs.baseDeficits
      ? Object.entries(raw.needs.baseDeficits).map(([position, deficit]) => ({
          position,
          priority: number(deficit) > 0 ? "urgent" : "met",
        })).concat([{ position: "FLEX", priority: raw.needs.flexMet ? "met" : "open" }])
      : [];

    return {
      revision: number(raw.revision ?? draft.revision, 0),
      build: raw.buildVersion ?? health.buildVersion ?? "Local preview",
      status,
      available,
      roster,
      needs: firstArray(team.needs, Array.isArray(raw.needs) ? raw.needs : null, persistedNeeds),
      likelyToReturn: likelyToReturn.length
        ? likelyToReturn
        : available.filter((player) => player.returnProbability !== null),
      research: raw.research ?? null,
      health: {
        missing: firstArray(health.missingOverallPicks, health.missingPicks, raw.missingOverallPicks),
        hasGap: Boolean(health.hasGap),
        conflicts: number(health.conflicts ?? health.conflictCount, 0),
        manualMode: Boolean(health.manualMode ?? raw.manualMode),
        stale: status !== "complete" && Boolean(
          health.stale || health.ingestorStatus === "stale" || health.ingestorStatus === "dead"
        ),
        ingestorStatus: status === "complete"
          ? "healthy"
          : health.ingestorStatus ?? (health.lastIngestAt ? "unknown" : "never_seen"),
        staleAfterSeconds: number(health.staleAfterSeconds, 45),
        deadAfterSeconds: number(health.deadAfterSeconds, 120),
        lastIngestAt: health.lastIngestAt ?? health.lastIngestTime ?? draft.updatedAt ?? raw.serverTime ?? null,
      },
      draft: {
        currentPick,
        totalPicks,
        round: number(draft.round ?? raw.currentRound, 0),
        roundPick: number(draft.roundPick ?? raw.roundPick, 0),
        nextTeamPick: draft.nextTeamPick ?? team.nextPick ?? raw.nextTeamPick ?? null,
        picksAway: draft.picksAway ?? team.picksAway ?? null,
        pickClockSeconds: draft.pickClockSeconds ?? raw.pickClockSeconds ?? null,
      },
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
      mock: "Rehearsal",
    };
    dom.connectionPill.className = `connection-pill is-${state}`;
    dom.connectionLabel.textContent = detail || labels[state] || state;
  }

  function showAlert(kind, message) {
    dom.alertRegion.append(node("div", `alert alert-${kind}`, message));
  }

  function renderAlerts(snapshot) {
    dom.alertRegion.replaceChildren();
    if (snapshot.health.hasGap || snapshot.health.missing.length) {
      const picks = snapshot.health.missing.slice(0, 8).join(", ");
      showAlert("warning", `Pick gap detected${picks ? `: ${picks}` : ""}. Confirm the ESPN board before acting.`);
    }
    if (snapshot.health.conflicts > 0) {
      showAlert("error", `${snapshot.health.conflicts} conflicting pick event${snapshot.health.conflicts === 1 ? "" : "s"} require review.`);
    }
    if (snapshot.health.manualMode) showAlert("info", "Manual pick mode is active. Confirm entries against ESPN.");
    if (snapshot.health.ingestorStatus === "dead") showAlert("error", "The ESPN ingestor has stopped reporting.");
    else if (snapshot.health.stale) showAlert("warning", "The ESPN ingestor is stale. Verify availability in ESPN.");
    const warningCount = snapshot.research?.warnings?.length ?? 0;
    if (warningCount > 0) {
      showAlert("research", `${warningCount} research exception${warningCount === 1 ? "" : "s"} remain visible as needs-review; Verl’s labels were not changed.`);
    }
  }

  function positionPlayers(players) {
    return players.filter((player) => app.position === "ALL" || player.position === app.position);
  }

  function inventoryKey(player) {
    if (!player.profile || !player.researchBucket) return `${player.position}::Unresearched`;
    return `${player.position}::${player.researchBucket}`;
  }

  function filteredPlayers(players) {
    return positionPlayers(players)
      .filter((player) => !app.bucket || inventoryKey(player) === app.bucket)
      .sort((left, right) => {
        const leftAdp = left.adp > 0 ? left.adp : Number.POSITIVE_INFINITY;
        const rightAdp = right.adp > 0 ? right.adp : Number.POSITIVE_INFINITY;
        return leftAdp - rightAdp || left.rank - right.rank || left.name.localeCompare(right.name);
      });
  }

  function renderInventory(players) {
    const scoped = positionPlayers(players);
    const counts = new Map();
    for (const player of scoped) counts.set(inventoryKey(player), (counts.get(inventoryKey(player)) ?? 0) + 1);
    if (app.bucket && !counts.has(app.bucket)) app.bucket = null;
    dom.inventoryList.replaceChildren();
    const allButton = node("button", `inventory-item${app.bucket === null ? " is-active" : ""}`);
    allButton.type = "button";
    allButton.dataset.bucket = "";
    allButton.append(node("strong", "inventory-count", scoped.length), node("span", "inventory-label", "All available"));
    dom.inventoryList.append(allButton);
    [...counts.entries()]
      .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
      .forEach(([key, count]) => {
        const [position, bucket] = key.split("::");
        const button = node("button", `inventory-item${app.bucket === key ? " is-active" : ""}`);
        button.type = "button";
        button.dataset.bucket = key;
        const label = app.position === "ALL" ? `${position} · ${bucket}` : bucket;
        button.append(node("strong", "inventory-count", count), node("span", "inventory-label", label));
        dom.inventoryList.append(button);
      });
  }

  function profileStatus(player) {
    const profile = player.profile;
    if (!profile) return { label: "Unresearched", detail: "No Verl profile", className: "status-muted" };
    if (profile.researchState === "stale" || isExpired(profile)) {
      return { label: "Stale", detail: timeAgo(profile.expiresAt, "Expired"), className: "status-warn" };
    }
    if (
      profile.publicationStatus === "needs-review" ||
      profile.taxonomyState === "taxonomy-gap" ||
      profile.researchState !== "complete"
    ) {
      return { label: "Review", detail: titleCase(profile.unknownReason ?? profile.taxonomyState), className: "status-warn" };
    }
    return {
      label: titleCase(profile.confidence),
      detail: timeAgo(profile.researchedAt, "Researched"),
      className: profile.confidence === "low" || profile.confidence === "unknown" ? "status-warn" : "status-good",
    };
  }

  function selectPlayer(playerId) {
    app.selectedPlayerId = playerId;
    renderAvailable(app.snapshot.available);
    renderInspector(app.snapshot.available);
  }

  function renderAvailable(players) {
    const filtered = filteredPlayers(players).slice(0, 60);
    dom.availableBody.replaceChildren();
    dom.availableEmpty.hidden = filtered.length > 0;
    if (!filtered.some((player) => player.id === app.selectedPlayerId)) {
      app.selectedPlayerId = filtered[0]?.id ?? null;
    }
    for (const player of filtered) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.className = player.id === app.selectedPlayerId ? "is-selected" : "";
      row.setAttribute("aria-selected", String(player.id === app.selectedPlayerId));
      row.addEventListener("click", () => selectPlayer(player.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectPlayer(player.id);
        }
      });
      row.append(node("td", "adp-cell", player.adp ? player.adp.toFixed(1) : "—"));
      const playerCell = node("td", "player-cell");
      playerCell.append(node("strong", "", player.name), node("small", "", `${player.position} · ${player.team}`));
      row.append(playerCell);
      const roleCell = node("td", "research-role-cell");
      if (player.profile) {
        roleCell.append(
          node("strong", "", titleCase(player.profile.role ?? "Unresolved role")),
          node("small", "", player.profile.headline),
        );
      } else {
        roleCell.append(
          node("strong", "unresearched-label", "Not researched"),
          node("small", "", `Provider depth context: ${titleCase(player.providerRole)}`),
        );
      }
      row.append(roleCell);
      const status = profileStatus(player);
      const statusCell = node("td", `status-cell ${status.className}`);
      statusCell.append(node("strong", "", status.label), node("small", "", status.detail));
      row.append(statusCell);
      dom.availableBody.append(row);
    }
    const researched = filtered.filter((player) => player.profile).length;
    const publication = app.snapshot.research;
    dom.researchCoverage.textContent = publication
      ? `${researched} of ${filtered.length} in this lens · publication ${publication.researchRevision}`
      : `${researched} of ${filtered.length} in this lens · no published batch`;
  }

  function appendInspectorSection(parent, label, copy) {
    if (!copy) return;
    const section = node("section", "brief-section");
    section.append(node("h3", "brief-label", label), node("p", "brief-copy", copy));
    parent.append(section);
  }

  function inspectorHeading(text) {
    const heading = node("h2", "", text);
    heading.id = "inspector-title";
    return heading;
  }

  function formatFinding(key, value) {
    if (value && typeof value === "object" && Number.isFinite(value.low) && Number.isFinite(value.high)) {
      if (/share|probability/i.test(key)) return `${Math.round(value.low * 100)}–${Math.round(value.high * 100)}%`;
      return `${number(value.low).toFixed(1)}–${number(value.high).toFixed(1)}`;
    }
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
    return titleCase(value);
  }

  function renderFindings(profile) {
    const findings = Object.entries(profile.findings)
      .filter(([key, value]) => key !== "position" && value !== undefined && value !== null)
      .slice(0, 8);
    if (!findings.length) return null;
    const section = node("section", "brief-section findings-section");
    section.append(node("h3", "brief-label", "Structured findings"));
    const grid = node("dl", "finding-grid");
    for (const [key, value] of findings) {
      grid.append(node("dt", "", titleCase(key)), node("dd", "", formatFinding(key, value)));
    }
    section.append(grid);
    return section;
  }

  function renderInspector(players) {
    const player = players.find((candidate) => candidate.id === app.selectedPlayerId);
    dom.inspector.replaceChildren();
    dom.inspector.classList.remove("inspector-enter");
    void dom.inspector.offsetWidth;
    dom.inspector.classList.add("inspector-enter");
    dom.inspector.append(node("p", "eyebrow", "Research brief"));
    if (!player) {
      dom.inspector.append(inspectorHeading("No player selected"));
      dom.inspector.append(node("p", "empty-copy", "Choose an available player to inspect Verl’s conclusion."));
      return;
    }
    const identity = node("div", "inspector-identity");
    const title = node("div", "");
    title.append(
      inspectorHeading(player.name),
      node("p", "player-meta", `${player.position} · ${player.team} · ESPN ADP ${player.adp ? player.adp.toFixed(1) : "—"}`),
    );
    identity.append(title);
    dom.inspector.append(identity);
    const profile = player.profile;
    if (!profile) {
      dom.inspector.append(node("span", "role-badge is-muted", "Not researched"));
      dom.inspector.append(node("p", "empty-copy", "Verl has not published a profile for this player. The War Room will not invent one."));
      appendInspectorSection(dom.inspector, "Provider context", titleCase(player.providerRole));
      return;
    }
    const status = profileStatus(player);
    const badgeRow = node("div", "badge-row");
    badgeRow.append(
      node("span", "role-badge", titleCase(profile.role ?? "Unresolved role")),
      node("span", `confidence-badge ${status.className}`, status.label),
    );
    dom.inspector.append(badgeRow);
    dom.inspector.append(node("p", "profile-headline", profile.headline));
    if (profile.draftImplication) {
      const callout = node("div", "decision-callout");
      callout.append(node("span", "callout-label", "Draft implication"), node("p", "", profile.draftImplication));
      dom.inspector.append(callout);
    }
    appendInspectorSection(dom.inspector, "Current role", profile.currentRole);
    appendInspectorSection(dom.inspector, "Opportunity", profile.opportunity);
    appendInspectorSection(dom.inspector, "Competition", profile.competition);
    appendInspectorSection(dom.inspector, "Availability", profile.availability);
    if (profile.contingency) {
      appendInspectorSection(
        dom.inspector,
        `Contingency · ${titleCase(profile.contingency.researchedRole ?? "Unresolved")}`,
        `${profile.contingency.trigger}: ${profile.contingency.summary}`,
      );
    }
    const findings = renderFindings(profile);
    if (findings) dom.inspector.append(findings);
    if (profile.unresolved.length) {
      appendInspectorSection(dom.inspector, "Still unresolved", profile.unresolved.join(" · "));
    }
    appendInspectorSection(dom.inspector, `${titleCase(profile.confidence)} confidence`, profile.confidenceReason);
    const evidence = node("section", "brief-section evidence-section");
    evidence.append(node("h3", "brief-label", "Evidence"));
    const meta = node("p", "evidence-meta", `${profile.supportingIds.length} supporting · ${profile.contradictingIds.length} contradicting · ${timeAgo(profile.researchedAt, "researched")}`);
    evidence.append(meta);
    if (profile.sources.length) {
      const links = node("div", "source-links");
      profile.sources.slice(0, 6).forEach((url, index) => {
        const link = node("a", "source-link", `Source ${index + 1}`);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        links.append(link);
      });
      evidence.append(links);
    }
    dom.inspector.append(evidence);
  }

  function renderRoster(roster, needs) {
    dom.rosterCount.textContent = roster.length;
    dom.rosterList.replaceChildren();
    dom.needsList.replaceChildren();
    const normalizedNeeds = needs.length
      ? needs
      : ["QB", "RB", "WR", "TE"].map((position) => ({ position, priority: "open" }));
    for (const rawNeed of normalizedNeeds) {
      const need = typeof rawNeed === "string" ? { position: rawNeed, priority: "open" } : rawNeed;
      const priority = String(need.priority ?? need.status ?? "open").toLowerCase();
      const className = priority === "urgent" || priority === "high"
        ? " is-urgent"
        : priority === "met" || priority === "filled" ? " is-met" : "";
      dom.needsList.append(node("span", `need-chip${className}`, `${need.position ?? need.slot ?? "FLEX"} · ${priority}`));
    }
    if (!roster.length) {
      dom.rosterList.append(node("li", "empty-state", "No managed-team picks yet."));
      return;
    }
    for (const player of roster) {
      const item = node("li", "roster-item");
      item.append(node("span", "roster-pos", player.position));
      const identity = node("div", "");
      identity.append(node("div", "roster-name", player.name));
      identity.append(node("div", "roster-team", `${player.team}${player.byeWeek ? ` · Bye ${player.byeWeek}` : ""}`));
      item.append(identity, node("span", "roster-pick", player.pick ? `#${player.pick}` : "Keeper"));
      dom.rosterList.append(item);
    }
  }

  function renderReturns(players) {
    dom.returnList.replaceChildren();
    const usable = positionPlayers(players)
      .filter((player) => player.returnProbability !== null)
      .sort((left, right) => left.returnProbability - right.returnProbability)
      .slice(0, 5);
    if (!usable.length) {
      dom.returnList.append(node("li", "empty-state", "No return estimates in this lens."));
      return;
    }
    for (const player of usable) {
      const item = node("li", "return-item");
      const identity = node("div", "");
      identity.append(node("span", "return-name", player.name));
      identity.append(node("span", "return-meta", `${player.position} · ${player.researchBucket ?? "unresearched"}`));
      item.append(identity, node("span", "return-value", `${player.returnProbability}%`));
      dom.returnList.append(item);
    }
  }

  function renderProgress(snapshot) {
    const { currentPick, totalPicks, round, roundPick, nextTeamPick, picksAway, pickClockSeconds } = snapshot.draft;
    const completedPicks = currentPick ? Math.max(0, currentPick - 1) : totalPicks;
    const progress = totalPicks ? clamp((completedPicks / totalPicks) * 100) : 0;
    dom.pickLabel.textContent = currentPick ? `Pick ${currentPick} of ${totalPicks || "—"}` : "Draft complete";
    dom.roundLabel.textContent = round ? `Round ${round}${roundPick ? ` · Pick ${roundPick}` : ""}` : "";
    dom.progressCopy.textContent = totalPicks
      ? `${completedPicks} picks complete · ${Math.round(progress)}%`
      : `${completedPicks} picks complete`;
    dom.progressFill.style.width = `${progress}%`;
    dom.progressBar.setAttribute("aria-valuenow", String(Math.round(progress)));
    dom.lastSync.textContent = timeAgo(snapshot.health.lastIngestAt);
    dom.nextPick.textContent = currentPick === null
      ? "Complete"
      : nextTeamPick ? `#${nextTeamPick}${picksAway !== null ? ` · ${picksAway} away` : ""}` : "Calculating";
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
    if (!mockMode && snapshot.status === "complete") setConnection("connected", "Draft complete");
    else if (!mockMode && snapshot.health.ingestorStatus === "dead") setConnection("error", "Ingestor stopped");
    else if (!mockMode && snapshot.health.stale) setConnection("stale", "Ingestor stale");
    else if (!mockMode && app.socket?.readyState === WebSocket.OPEN) setConnection("connected");
    renderAlerts(snapshot);
    renderInventory(snapshot.available);
    renderAvailable(snapshot.available);
    renderInspector(snapshot.available);
    renderRoster(snapshot.roster, snapshot.needs);
    renderReturns(snapshot.likelyToReturn);
    renderProgress(snapshot);
    dom.revisionLabel.textContent = `Revision ${snapshot.revision}`;
    dom.buildLabel.textContent = snapshot.build;
    dom.researchLabel.textContent = snapshot.research
      ? `Research ${snapshot.research.researchRevision} · ${snapshot.research.profileCount} profiles`
      : "Research not published";
  }

  async function fetchSnapshot({ quiet = false } = {}) {
    if (mockMode) {
      render(MOCK_SNAPSHOT);
      app.lastSuccessfulFetch = Date.now();
      setConnection("mock");
      return;
    }
    if (!draftKey) {
      setConnection("error", "Draft not selected");
      dom.alertRegion.replaceChildren();
      showAlert("error", "Open Draftside with a valid draft query parameter or use ?mock=1 for rehearsal data.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/drafts/${encodeURIComponent(draftKey)}/snapshot`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
      render(await response.json());
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
    showAlert("error", `${message} Retrying automatically.`);
  }

  function connectSocket() {
    if (mockMode || !draftKey) return;
    if (app.socket) app.socket.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    setConnection(app.snapshot ? "reconnecting" : "loading");
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/drafts/${encodeURIComponent(draftKey)}/ws`);
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
    if (Date.now() - app.lastSuccessfulFetch > TRANSPORT_STALE_MS) setConnection("error", "Dashboard offline");
    if (!app.snapshot) return;
    const lastIngest = Date.parse(app.snapshot.health.lastIngestAt || "");
    const elapsedSeconds = Number.isFinite(lastIngest) ? (Date.now() - lastIngest) / 1000 : 0;
    if (app.snapshot.status === "live" && elapsedSeconds >= app.snapshot.health.staleAfterSeconds) {
      app.snapshot.health.stale = true;
      app.snapshot.health.ingestorStatus = elapsedSeconds >= app.snapshot.health.deadAfterSeconds ? "dead" : "stale";
      setConnection(
        app.snapshot.health.ingestorStatus === "dead" ? "error" : "stale",
        app.snapshot.health.ingestorStatus === "dead" ? "Ingestor stopped" : "Ingestor stale",
      );
      renderAlerts(app.snapshot);
    }
    dom.lastSync.textContent = timeAgo(app.snapshot.health.lastIngestAt);
  }

  async function loadCompanionDevices() {
    if (!dom.companionDevices) return;
    if (mockMode) {
      dom.companionStatus.textContent = "Connected";
      const row = node("div", "companion-device");
      const copy = node("div", "");
      copy.append(node("strong", "", "Rehearsal laptop"), node("span", "section-note", "Draftside companion · sample"));
      row.append(copy);
      dom.companionDevices.replaceChildren(row);
      return;
    }
    try {
      const response = await fetch("/api/v1/companion/devices", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
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
      for (const device of devices) {
        const row = node("div", "companion-device");
        const copy = node("div", "");
        copy.append(
          node("strong", "", device.name || "Draft laptop"),
          node("span", "section-note", device.revokedAt ? "Revoked" : `Draftside ${device.version || ""} · connected`),
        );
        const action = node("button", device.revokedAt ? "filter-button" : "filter-button danger-button", device.revokedAt ? "Re-enable" : "Revoke");
        action.type = "button";
        action.addEventListener("click", async () => {
          action.disabled = true;
          const verb = device.revokedAt ? "enable" : "revoke";
          const result = await fetch(`/api/v1/companion/devices/${encodeURIComponent(device.deviceId)}/${verb}`, {
            cache: "no-store",
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          });
          if (!result.ok) action.disabled = false;
          else await loadCompanionDevices();
        });
        row.append(copy, action);
        dom.companionDevices.append(row);
      }
    } catch (_error) {
      dom.companionStatus.textContent = "Unavailable";
      dom.companionDevices.replaceChildren(node("p", "section-note", "Companion controls are unavailable right now."));
    }
  }

  document.querySelectorAll(".filter-button[data-position]").forEach((button) => {
    button.addEventListener("click", () => {
      app.position = button.dataset.position;
      app.bucket = null;
      app.selectedPlayerId = null;
      document.querySelectorAll(".filter-button[data-position]").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      if (app.snapshot) {
        renderInventory(app.snapshot.available);
        renderAvailable(app.snapshot.available);
        renderInspector(app.snapshot.available);
        renderReturns(app.snapshot.likelyToReturn);
      }
    });
  });

  dom.inventoryList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-bucket]");
    if (!button || !app.snapshot) return;
    app.bucket = button.dataset.bucket || null;
    app.selectedPlayerId = null;
    renderInventory(app.snapshot.available);
    renderAvailable(app.snapshot.available);
    renderInspector(app.snapshot.available);
  });

  function mockProfile(position, role, overrides = {}) {
    const researchedAt = new Date(Date.now() - 8 * 3_600_000).toISOString();
    const classifiedAt = new Date(Date.now() - 7 * 3_600_000).toISOString();
    const expiresAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    return {
      schemaVersion: 2,
      profileId: `sample-${position}-${role}`,
      position,
      researchedRole: role,
      researchState: "complete",
      unknownReason: null,
      taxonomyState: "matched",
      publicationStatus: "published",
      warRoomHeadline: "Role clarity adds information ESPN rank does not show.",
      currentRoleSummary: "Verl’s current evidence supports this role today.",
      opportunitySummary: "The player has a stable path to the opportunities attached to the role.",
      competitionSummary: "Competition is present but does not currently displace the published role.",
      availabilitySummary: "Available and participating.",
      draftImplication: "Compare the role scarcity with the next-best available option before waiting.",
      contingency: null,
      confidence: "high",
      confidenceReason: "Multiple current observations agree.",
      alternativesConsidered: [],
      unresolvedQuestions: [],
      supportingObservationIds: ["sample-obs-1", "sample-obs-2"],
      contradictingObservationIds: [],
      sourceUrls: ["https://example.com/sample-source-1", "https://example.com/sample-source-2"],
      structuredFindings: { position },
      additionalFindings: {},
      researchedAt,
      classifiedAt,
      expiresAt,
      classifiedBy: "Verl",
      ...overrides,
    };
  }

  const MOCK_SNAPSHOT = {
    revision: 48,
    buildVersion: "Research pilot · sanitized",
    serverTime: new Date().toISOString(),
    status: "live",
    research: {
      publicationId: "sanitized-pilot-1",
      researchRevision: 1,
      roleVocabularyVersion: "2026.1",
      rubricVersion: "2026.1-draft",
      publishedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      publishedBy: "Verl",
      profileCount: 14,
      warnings: [
        { code: "needs-review", playerKey: "espn:sample-14", nflTeam: "BUF", message: "Pilot conflict" },
        { code: "profile-stale", playerKey: "espn:sample-10", nflTeam: "TB", message: "Pilot stale profile" },
      ],
    },
    draft: {
      current: 58,
      totalPicks: 192,
      round: 5,
      roundPick: 10,
      nextTeamPick: 63,
      picksAway: 5,
      pickClockSeconds: 84,
    },
    health: {
      hasGap: false,
      missingOverallPicks: [],
      conflictCount: 0,
      manualMode: false,
      ingestorStatus: "healthy",
      lastIngestAt: new Date().toISOString(),
    },
    available: [
      {
        playerId: "sample-1", name: "Devin Mercer", position: "RB", nflTeam: "ARI", adp: 60.2,
        pickNowRank: 27, roleClass: "RB1", returnProbability: 0.18, researchInventoryBucket: "Actual starter",
        researchProfile: mockProfile("RB", "clear-lead", {
          warRoomHeadline: "The last clear lead with passing and goal-line access.",
          currentRoleSummary: "First back through every first-team period and the preferred goal-line option.",
          opportunitySummary: "Projected for the largest carry share with meaningful routes.",
          competitionSummary: "The second back owns some two-minute work but has not threatened the starting assignment.",
          draftImplication: "A committee back ranked slightly higher by ESPN does not replace this role.",
          contingency: { researchedRole: "committee-1a", trigger: "Passing-down errors recur", summary: "Routes could move to the second back." },
          structuredFindings: { position: "RB", carryShare: { low: 0.55, high: 0.65 }, routeShare: { low: 0.35, high: 0.47 }, goalLineRole: "primary", backfieldRank: 1, handcuffType: "direct", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-2", name: "Jordan Banks", position: "RB", nflTeam: "DEN", adp: 64.8,
        pickNowRank: 31, roleClass: "RB1", returnProbability: 0.28, researchInventoryBucket: "Actual starter",
        researchProfile: mockProfile("RB", "early-down-lead", {
          warRoomHeadline: "Starting runner, but passing work belongs elsewhere.",
          draftImplication: "He counts as a remaining starter, not as a three-down solution.",
          confidence: "medium",
          structuredFindings: { position: "RB", carryShare: { low: 0.50, high: 0.60 }, routeShare: { low: 0.18, high: 0.30 }, goalLineRole: "shared", backfieldRank: 1, handcuffType: "ambiguous", competitionStatus: "leaning" },
        }),
      },
      {
        playerId: "sample-3", name: "Isaiah Vale", position: "RB", nflTeam: "MIA", adp: 55.4,
        pickNowRank: 34, roleClass: "RB2", returnProbability: 0.12, researchInventoryBucket: "Committee lead",
        researchProfile: mockProfile("RB", "committee-1a", {
          warRoomHeadline: "ESPN’s highest-ranked back here is still a committee member.",
          draftImplication: "Do not treat the higher ADP as evidence of a starting-back workload.",
          structuredFindings: { position: "RB", carryShare: { low: 0.41, high: 0.52 }, routeShare: { low: 0.28, high: 0.41 }, goalLineRole: "shared", backfieldRank: 1, handcuffType: "ambiguous", competitionStatus: "open" },
        }),
      },
      {
        playerId: "sample-4", name: "Owen Price", position: "RB", nflTeam: "NE", adp: 78.1,
        pickNowRank: 48, roleClass: "RB2", returnProbability: 0.52, researchInventoryBucket: "Specialist",
        researchProfile: mockProfile("RB", "passing-down-specialist", {
          warRoomHeadline: "Useful routes, but not a replacement for a starting runner.",
          confidence: "medium",
          structuredFindings: { position: "RB", carryShare: { low: 0.12, high: 0.24 }, routeShare: { low: 0.40, high: 0.54 }, goalLineRole: "none", backfieldRank: 2, handcuffType: "none", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-5", name: "Malik Rowan", position: "WR", nflTeam: "SEA", adp: 61.8,
        pickNowRank: 29, roleClass: "WR1", returnProbability: 0.22, researchInventoryBucket: "Target leader",
        researchProfile: mockProfile("WR", "clear-target-leader", {
          warRoomHeadline: "The offense’s clear first target despite a modest ESPN rank.",
          opportunitySummary: "Full-time routes and the first read in high-leverage situations.",
          competitionSummary: "The veteran WR2 remains full-time but has not matched the target hierarchy.",
          draftImplication: "This is the lower-ADP team WR1 you wanted surfaced against famous secondary receivers.",
          structuredFindings: { position: "WR", teamTargetRank: 1, targetShare: { low: 0.22, high: 0.28 }, routeShare: { low: 0.82, high: 0.93 }, redZoneTargetRole: "primary", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-6", name: "Cam Redd", position: "WR", nflTeam: "CIN", adp: 48.7,
        pickNowRank: 30, roleClass: "WR2", returnProbability: 0.09, researchInventoryBucket: "Full-time secondary",
        researchProfile: mockProfile("WR", "every-down-secondary", {
          warRoomHeadline: "Excellent player, but still second in the team target hierarchy.",
          draftImplication: "The strong ESPN rank reflects quality; Verl’s profile clarifies that he is not the team’s first target.",
          structuredFindings: { position: "WR", teamTargetRank: 2, targetShare: { low: 0.17, high: 0.22 }, routeShare: { low: 0.84, high: 0.95 }, redZoneTargetRole: "shared", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-7", name: "Andre Bell", position: "WR", nflTeam: "CAR", adp: 72.5,
        pickNowRank: 41, roleClass: "WR1", returnProbability: 0.41, researchInventoryBucket: "Target leader",
        researchProfile: mockProfile("WR", "co-target-leader", {
          warRoomHeadline: "A genuine 1A/1B target role on a weak offense.",
          confidence: "medium",
          structuredFindings: { position: "WR", teamTargetRank: "tied-1", targetShare: { low: 0.19, high: 0.25 }, routeShare: { low: 0.79, high: 0.92 }, redZoneTargetRole: "shared", competitionStatus: "leaning" },
        }),
      },
      {
        playerId: "sample-8", name: "Noah Cross", position: "WR", nflTeam: "LAR", adp: 80.4,
        pickNowRank: 50, roleClass: "WR3", returnProbability: 0.57, researchInventoryBucket: "Volume role",
        researchProfile: mockProfile("WR", "slot-volume", {
          warRoomHeadline: "Slot deployment creates stable volume without team-leader status.",
          structuredFindings: { position: "WR", teamTargetRank: 3, targetShare: { low: 0.15, high: 0.20 }, routeShare: { low: 0.75, high: 0.88 }, redZoneTargetRole: "secondary", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-9", name: "Trey Holloway", position: "TE", nflTeam: "LAC", adp: 72.4,
        pickNowRank: 38, roleClass: "TE1", returnProbability: 0.11, researchInventoryBucket: "Stable route volume",
        researchProfile: mockProfile("TE", "route-heavy-starter", {
          warRoomHeadline: "The last available TE with stable route volume.",
          draftImplication: "Waiting likely pushes the roster toward streaming and blocking-risk profiles.",
          structuredFindings: { position: "TE", routeShare: { low: 0.66, high: 0.76 }, targetShare: { low: 0.12, high: 0.16 }, teRoomRank: 1, teamTargetRank: 3, redZoneTargetRole: "shared", blockingLoad: "balanced" },
        }),
      },
      {
        playerId: "sample-10", name: "Micah Reed", position: "TE", nflTeam: "TB", adp: 86.9,
        pickNowRank: 54, roleClass: "TE1", returnProbability: 0.66, researchInventoryBucket: "Blocking risk",
        researchProfile: mockProfile("TE", "inline-blocking-starter", {
          warRoomHeadline: "Real-life starter whose snaps overstate his fantasy routes.",
          researchState: "stale",
          unknownReason: "stale",
          publicationStatus: "needs-review",
          confidence: "low",
          expiresAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
          structuredFindings: { position: "TE", routeShare: { low: 0.28, high: 0.42 }, targetShare: { low: 0.05, high: 0.09 }, teRoomRank: 1, teamTargetRank: 6, redZoneTargetRole: "secondary", blockingLoad: "heavy" },
        }),
      },
      {
        playerId: "sample-11", name: "Eli Porter", position: "QB", nflTeam: "PIT", adp: 92.2,
        pickNowRank: 58, roleClass: "QB1", returnProbability: 0.62, researchInventoryBucket: "Fragile starter",
        researchProfile: mockProfile("QB", "bridge-starter", {
          warRoomHeadline: "Starts Week 1, but the full-season job is not secure.",
          confidence: "medium",
          structuredFindings: { position: "QB", week1StartProbability: { low: 0.80, high: 0.93 }, designedRushesPerGame: { low: 1.0, high: 2.0 }, passAttemptsPerGame: { low: 29, high: 34 }, starterLeash: "fragile", competitionStatus: "leaning" },
        }),
      },
      {
        playerId: "sample-12", name: "Lucas Grant", position: "QB", nflTeam: "LV", adp: 108.6,
        pickNowRank: 71, roleClass: "QB1", returnProbability: 0.78, researchInventoryBucket: "Competition",
        researchProfile: mockProfile("QB", "competition-favorite", {
          warRoomHeadline: "Leads the competition; he has not won it.",
          confidence: "low",
          structuredFindings: { position: "QB", week1StartProbability: { low: 0.58, high: 0.76 }, designedRushesPerGame: { low: 2.0, high: 4.0 }, passAttemptsPerGame: { low: 25, high: 32 }, starterLeash: "unknown", competitionStatus: "open" },
        }),
      },
      {
        playerId: "sample-13", name: "Mason Cole", position: "K", nflTeam: "DAL", adp: 170.0,
        pickNowRank: 150, roleClass: "K", returnProbability: 0.94, researchInventoryBucket: "Secure job",
        researchProfile: mockProfile("K", "locked-average-volume-kicker", {
          warRoomHeadline: "Secure job; still replaceable and suppressed until the endgame.",
          structuredFindings: { position: "K", jobSecurityProbability: { low: 0.96, high: 1 }, offenseScoringBand: "strong", competitionStatus: "settled" },
        }),
      },
      {
        playerId: "sample-14", name: "Buffalo D/ST", position: "D/ST", nflTeam: "BUF", adp: 158.0,
        pickNowRank: 141, roleClass: "D/ST", returnProbability: 0.91, researchInventoryBucket: "Taxonomy gap",
        researchProfile: mockProfile("D/ST", "taxonomy-gap", {
          warRoomHeadline: "Pressure profile is useful, but current personnel evidence does not fit the vocabulary cleanly.",
          taxonomyState: "taxonomy-gap",
          publicationStatus: "needs-review",
          confidence: "low",
          unresolvedQuestions: ["Whether the new pressure package survives the final roster cut"],
          structuredFindings: { position: "D/ST", pressurePercentile: 78, sackPercentile: 71, takeawayPercentile: 48, pointsPreventionPercentile: 64, week1MatchupPercentile: 82 },
        }),
      },
      { playerId: "sample-15", name: "Riley Knox", position: "RB", nflTeam: "NYG", adp: 84.3, pickNowRank: 61, roleClass: "RB2", returnProbability: 0.71 },
    ],
    managedRoster: [
      { playerId: "roster-1", name: "Darius Stone", position: "WR", nflTeam: "DET", overallPick: 15, byeWeek: 8 },
      { playerId: "roster-2", name: "Caleb North", position: "RB", nflTeam: "ATL", overallPick: 34, byeWeek: 5 },
    ],
    needs: {
      baseDeficits: { QB: 1, RB: 1, WR: 1, TE: 1 },
      flexMet: false,
    },
  };

  fetchSnapshot();
  connectSocket();
  loadCompanionDevices();
  app.pollingTimer = window.setInterval(() => fetchSnapshot({ quiet: true }), POLL_MS);
  app.staleTimer = window.setInterval(checkStale, 5_000);
  dom.modeLabel.textContent = mockMode ? "Sanitized rehearsal data" : draftKey ? "Read-only ESPN draft state" : "Draft not selected";
})();
