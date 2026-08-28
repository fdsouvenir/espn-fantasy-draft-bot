import { hasInjuryConcern } from "./injury-concern.js";

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
    decisionTabs: document.querySelector("#decision-tabs"),
    rosterSummary: document.querySelector("#roster-summary"),
    workspace: document.querySelector("#workspace"),
    workspaceEyebrow: document.querySelector("#workspace-eyebrow"),
    workspaceTitle: document.querySelector("#workspace-title"),
    workspaceNote: document.querySelector("#workspace-note"),
    workspaceContent: document.querySelector("#workspace-content"),
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
    activeTab: "NEXT",
    expandedPlayerId: null,
    expandedBuckets: new Set(),
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
      researchRunId: String(raw.researchRunId ?? ""),
      evidenceCutoffAt: raw.evidenceCutoffAt ?? null,
      position: String(raw.position ?? "").toUpperCase(),
      role: raw.researchedRole ?? null,
      researchState: raw.researchState ?? "insufficient-evidence",
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
      scoringBand: raw.researchOffenseScoringBand ?? raw.researchProfile?.additionalFindings?.offenseScoringBand ?? "unknown",
      teamNotes: raw.researchTeamNotes ?? raw.researchProfile?.additionalFindings?.teamNotes ?? "",
      injuryStatus: String(raw.injuryStatus ?? "").trim().toUpperCase(),
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
        expectedTeams: number(draft.expectedTeams ?? raw.expectedTeams, 12),
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
      showAlert("research", `${warningCount} research exception${warningCount === 1 ? "" : "s"} are isolated under Role uncertain and excluded from Next Up.`);
    }
  }


  function formatFinding(key, value) {
    if (value && typeof value === "object" && Number.isFinite(value.low) && Number.isFinite(value.high)) {
      if (/share|probability/i.test(key)) return `${Math.round(value.low * 100)}–${Math.round(value.high * 100)}%`;
      return `${number(value.low).toFixed(1)}–${number(value.high).toFixed(1)}`;
    }
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(1);
    return titleCase(value);
  }


  const ROLE_GROUPS = {
    RB: ["Actual starter", "Committee lead", "Committee partner", "Specialist", "Contingent", "Reserve"],
    WR: ["Target leader", "Volume role", "Full-time secondary", "Specialist", "Rotation"],
    TE: ["Receiving difference-maker", "Stable route volume", "Committee lead", "Specialist", "Blocking risk", "Rotation", "Contingent"],
    QB: ["Locked starter", "Fragile starter", "Competition", "Contingent", "Reserve"],
    K: ["Secure job", "Competition", "Temporary", "No job"],
    "D/ST": ["Every-week unit", "Pressure upside", "Volatile", "Streamer", "Matchup only", "Low ceiling"],
  };

  const POSITION_COPY = {
    RB: ["Running backs", "Starting jobs, committee reality, receiving work, and who actually owns the backfield."],
    WR: ["Wide receivers", "Team target hierarchy first: clear No. 1s, stable volume, secondary roles, and specialists."],
    TE: ["Tight ends", "Routes and receiving priority matter more than nominal starter status."],
    QB: ["Quarterbacks", "Job security, start probability, and the fantasy value of the role around them."],
    K: ["Kickers", "Job security first. Do not spend an early pick on a replaceable role."],
    "D/ST": ["Defenses", "Disruption and opening-week usability, separated from low-ceiling name value."],
  };

  function profileIsUncertain(player) {
    const profile = player.profile;
    return !profile || !player.researchBucket || profile.publicationStatus !== "published" ||
      profile.taxonomyState !== "matched" || profile.researchState !== "complete" || isExpired(profile);
  }

  function bucketFor(player) {
    return profileIsUncertain(player) ? "Role uncertain" : player.researchBucket;
  }

  function confidenceScore(player) {
    return { high: 3, medium: 2, low: 1, unknown: 0 }[player.profile?.confidence] ?? 0;
  }

  function securityScore(player) {
    const findings = player.profile?.findings ?? {};
    const competition = { settled: 4, leaning: 2, open: 0, unknown: 1 }[findings.competitionStatus] ?? 1;
    const leash = { stable: 3, moderate: 2, fragile: 0, unknown: 1 }[findings.starterLeash] ?? 1;
    const rank = [findings.backfieldRank, findings.teamTargetRank, findings.teRoomRank]
      .find((value) => typeof value === "number");
    const hierarchy = rank === 1 ? 3 : rank === 2 ? 2 : rank ? 1 : 0;
    return competition + leash + hierarchy;
  }

  function environmentScore(player) {
    return { strong: 3, average: 2, weak: 1, unknown: 0 }[player.scoringBand] ?? 0;
  }

  function adpValue(player) {
    return player.adp > 0 ? player.adp : Number.POSITIVE_INFINITY;
  }

  function compareWithinRole(left, right) {
    return securityScore(right) - securityScore(left) ||
      environmentScore(right) - environmentScore(left) ||
      confidenceScore(right) - confidenceScore(left) ||
      adpValue(left) - adpValue(right) || left.name.localeCompare(right.name);
  }

  function roleIndex(player) {
    const groups = ROLE_GROUPS[player.position] ?? [];
    const index = groups.indexOf(bucketFor(player));
    return index === -1 ? groups.length + 1 : index;
  }

  function needPriority(snapshot, position) {
    const need = snapshot.needs.find((candidate) => {
      const value = typeof candidate === "string" ? candidate : candidate.position ?? candidate.slot;
      return String(value).toUpperCase() === position;
    });
    if (!need) return 1;
    const priority = String(typeof need === "string" ? "open" : need.priority ?? need.status ?? "open").toLowerCase();
    if (["urgent", "high", "open"].includes(priority)) return 0;
    return ["met", "filled"].includes(priority) ? 2 : 1;
  }

  function inventoryCounts(players, position = null) {
    const counts = new Map();
    for (const player of players) {
      if (position && player.position !== position) continue;
      const key = `${player.position}::${bucketFor(player)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  function decisionCompare(snapshot, counts) {
    return (left, right) => needPriority(snapshot, left.position) - needPriority(snapshot, right.position) ||
      roleIndex(left) - roleIndex(right) ||
      (counts.get(`${left.position}::${bucketFor(left)}`) ?? 99) -
        (counts.get(`${right.position}::${bucketFor(right)}`) ?? 99) ||
      compareWithinRole(left, right);
  }

  function whyHere(player) {
    return player.profile?.draftImplication || player.profile?.headline ||
      "The role is unresolved; verify the current team situation before relying on it.";
  }

  function injuryConcern(player) {
    const copy = player.profile?.availability?.trim() ?? "";
    if (!hasInjuryConcern(copy, player.injuryStatus)) return "";
    return copy || `ESPN injury status: ${titleCase(player.injuryStatus)}.`;
  }

  function scoringBandCopy(player) {
    return {
      strong: "Strong scoring environment",
      average: "Average scoring environment",
      weak: "Weak scoring environment",
      unknown: "Scoring environment unconfirmed",
    }[player.scoringBand] ?? "Scoring environment unconfirmed";
  }

  function competitionLabel(player) {
    const status = player.profile?.findings?.competitionStatus;
    if (status && status !== "unknown") return `${titleCase(status)} competition`;
    return player.profile?.competition ? "Competition mapped" : "Competition unclear";
  }

  function detailSection(label, copy) {
    if (!copy) return null;
    const section = node("section", "detail-section");
    section.append(node("h4", "detail-label", label), node("p", "detail-copy", copy));
    return section;
  }

  function renderPlayerDetail(player) {
    const detail = node("div", "player-detail");
    const profile = player.profile;
    if (!profile) {
      detail.append(node("p", "uncertain-copy", "No published role profile is attached. The War Room keeps this player visible without inventing a conclusion."));
      return detail;
    }
    const grid = node("div", "detail-grid");
    [
      detailSection("Current role", profile.currentRole),
      detailSection("Opportunity", profile.opportunity),
      detailSection("Competition", profile.competition),
      detailSection("Team situation", player.teamNotes || scoringBandCopy(player)),
      injuryConcern(player) ? detailSection("Availability concern", profile.availability) : null,
      profile.contingency
        ? detailSection(`Contingency · ${titleCase(profile.contingency.researchedRole ?? "unresolved")}`, `${profile.contingency.summary} Trigger: ${profile.contingency.trigger}`)
        : null,
      profile.confidence === "low" || profile.confidence === "unknown"
        ? detailSection("Confidence exception", profile.confidenceReason || "The published conclusion remains low confidence.")
        : null,
      profile.unresolved.length ? detailSection("Still unresolved", profile.unresolved.join(" · ")) : null,
    ].filter(Boolean).forEach((section) => {
      grid.append(section);
    });
    detail.append(grid);

    const findings = Object.entries(profile.findings)
      .filter(([key, value]) => key !== "position" && value !== undefined && value !== null)
      .slice(0, 8);
    if (findings.length) {
      const strip = node("dl", "finding-strip");
      for (const [key, value] of findings) {
        const item = node("div", "finding-item");
        item.append(node("dt", "", titleCase(key)), node("dd", "", formatFinding(key, value)));
        strip.append(item);
      }
      detail.append(strip);
    }

    const evidence = node("div", "evidence-row");
    evidence.append(node("span", "evidence-meta", `${profile.supportingIds.length} supporting · ${profile.contradictingIds.length} contradicting · ${timeAgo(profile.researchedAt, "Researched")}`));
    if (profile.sources.length) {
      const links = node("div", "source-links");
      profile.sources.slice(0, 4).forEach((url, index) => {
        const link = node("a", "source-link", `Source ${index + 1}`);
        link.href = url;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        links.append(link);
      });
      evidence.append(links);
    }
    detail.append(evidence);
    return detail;
  }

  function renderDepthStrip(player) {
    const depth = node("div", "depth-strip");
    depth.setAttribute("aria-label", `${player.team} depth-chart context`);
    const role = profileIsUncertain(player) ? "Role unresolved" : titleCase(player.profile?.role);
    depth.append(
      node("span", "depth-node is-player", role),
      node("span", "depth-arrow", "→"),
      node("span", "depth-node", competitionLabel(player)),
    );
    return depth;
  }

  function renderPlayerRow(player, options = {}) {
    const expanded = app.expandedPlayerId === player.id;
    const row = node("article", `player-row${expanded ? " is-expanded" : ""}${options.compact ? " is-compact" : ""}`);
    const summary = node("button", "player-summary");
    summary.type = "button";
    summary.dataset.expandPlayer = player.id;
    summary.setAttribute("aria-expanded", String(expanded));

    const identity = node("div", "player-identity");
    identity.append(node("strong", "player-name", player.name));
    const meta = node("div", "player-meta");
    meta.append(node("span", "position-chip", player.position), node("span", "", player.team));
    if (player.profile?.role && !profileIsUncertain(player)) meta.append(node("span", "role-code", titleCase(player.profile.role)));
    identity.append(meta);

    const why = node("div", "why-block");
    why.append(node("span", "row-label", options.label ?? "Why here"), node("p", "why-copy", whyHere(player)));

    const situation = node("div", "situation-block");
    situation.append(renderDepthStrip(player));
    situation.append(node("p", "situation-copy", `${scoringBandCopy(player)}. ${player.profile?.competition || "Team competition is not resolved in the published profile."}`));

    const exceptions = node("div", "exception-stack");
    const injury = injuryConcern(player);
    if (injury) exceptions.append(node("span", "exception-chip is-injury", "Injury concern"));
    if (profileIsUncertain(player)) exceptions.append(node("span", "exception-chip is-uncertain", "Role uncertain"));
    else if (["low", "unknown"].includes(player.profile?.confidence)) exceptions.append(node("span", "exception-chip is-uncertain", `${titleCase(player.profile.confidence)} confidence`));
    exceptions.append(node("span", "expand-mark", expanded ? "−" : "+"));

    summary.append(identity, why, situation, exceptions);
    row.append(summary);
    if (expanded) row.append(renderPlayerDetail(player));
    return row;
  }

  function scarcityCopy(count) {
    if (count === 0) return "None left";
    if (count === 1) return "Last one";
    if (count <= 3) return `Only ${count} left`;
    return `${count} available`;
  }

  function renderRosterSummary(snapshot) {
    const counts = new Map();
    for (const player of snapshot.roster) counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
    const roster = node("div", "roster-line");
    roster.append(node("span", "summary-label", "Your roster"));
    if (!snapshot.roster.length) roster.append(node("strong", "", "Empty"));
    else ["QB", "RB", "WR", "TE", "K", "D/ST"].filter((position) => counts.has(position))
      .forEach((position) => {
        roster.append(node("span", "roster-count", `${position} ${counts.get(position)}`));
      });

    const needs = node("div", "needs-line");
    needs.append(node("span", "summary-label", "Open needs"));
    const openNeeds = snapshot.needs.filter((rawNeed) => {
      const priority = String(typeof rawNeed === "string" ? "open" : rawNeed.priority ?? rawNeed.status ?? "open").toLowerCase();
      return !["met", "filled"].includes(priority);
    });
    if (!openNeeds.length) needs.append(node("strong", "", "Best role available"));
    else openNeeds.forEach((rawNeed) => {
      const position = typeof rawNeed === "string" ? rawNeed : rawNeed.position ?? rawNeed.slot ?? "FLEX";
      const priority = String(typeof rawNeed === "string" ? "open" : rawNeed.priority ?? rawNeed.status ?? "open").toLowerCase();
      needs.append(node("span", `need-chip${["urgent", "high"].includes(priority) ? " is-urgent" : ""}`, position));
    });
    dom.rosterSummary.replaceChildren(roster, needs);
  }

  function renderDecisionCard(kind, player, rationale, count) {
    const card = node("section", `decision-card decision-${kind.toLowerCase().replaceAll(" ", "-")}`);
    const heading = node("header", "decision-card-heading");
    const copy = node("div", "");
    copy.append(node("p", "decision-kicker", kind), node("h3", "", player ? player.name : "No qualified signal"));
    heading.append(copy);
    if (player) heading.append(node("span", "decision-role", `${player.position} · ${bucketFor(player)}`));
    card.append(heading, node("p", "decision-rationale", rationale));
    if (player) {
      const facts = node("div", "decision-facts");
      facts.append(node("span", "", `${count} in this role`), node("span", "", scoringBandCopy(player)));
      if (injuryConcern(player)) facts.append(node("span", "decision-risk", "Injury concern"));
      card.append(facts, renderPlayerRow(player, { compact: true, label: "Why this player" }));
    }
    return card;
  }

  function renderNextUp(snapshot) {
    dom.workspaceEyebrow.textContent = "Decision brief";
    dom.workspaceTitle.textContent = "Next Up";
    dom.workspaceNote.textContent = "Three transparent signals. No hidden value score and no duplicate ESPN queue.";
    const players = snapshot.available.filter((player) => ["QB", "RB", "WR", "TE", "K", "D/ST"].includes(player.position));
    const usable = players.filter((player) => !profileIsUncertain(player));
    const counts = inventoryCounts(players);
    const compare = decisionCompare(snapshot, counts);

    const rosterFit = [...usable].sort(compare)[0] ?? null;
    const excluded = new Set(rosterFit ? [rosterFit.id] : []);
    const scarcity = [...usable]
      .filter((player) => {
        const bucketKey = `${player.position}::${bucketFor(player)}`;
        const rosterFitKey = rosterFit ? `${rosterFit.position}::${bucketFor(rosterFit)}` : null;
        return !excluded.has(player.id) && bucketKey !== rosterFitKey && (counts.get(bucketKey) ?? 99) <= 3;
      })
      .sort((left, right) => {
        const leftCount = counts.get(`${left.position}::${bucketFor(left)}`) ?? 99;
        const rightCount = counts.get(`${right.position}::${bucketFor(right)}`) ?? 99;
        return needPriority(snapshot, left.position) - needPriority(snapshot, right.position) ||
          roleIndex(left) - roleIndex(right) || leftCount - rightCount || compareWithinRole(left, right);
      })[0] ?? null;
    if (scarcity) excluded.add(scarcity.id);
    const currentPick = snapshot.draft.currentPick ?? 0;
    const marketFall = [...usable]
      .filter((player) => !excluded.has(player.id) && player.adp > 0 && currentPick - player.adp >= 6)
      .sort((left, right) => (currentPick - right.adp) - (currentPick - left.adp) || compare(left, right))[0] ?? null;

    const primary = node("div", "decision-grid");
    const fitCount = rosterFit ? counts.get(`${rosterFit.position}::${bucketFor(rosterFit)}`) ?? 0 : 0;
    primary.append(renderDecisionCard(
      "Roster fit",
      rosterFit,
      rosterFit
        ? `${rosterFit.position} is still open on your roster; this is the strongest researched role remaining at that need.`
        : "No published role currently clears the roster-fit rule. Use a position tab before drafting.",
      fitCount,
    ));
    const scarcityCount = scarcity ? counts.get(`${scarcity.position}::${bucketFor(scarcity)}`) ?? 0 : 0;
    primary.append(renderDecisionCard(
      "Scarcity alert",
      scarcity,
      scarcity
        ? `${scarcityCopy(scarcityCount)} in the ${bucketFor(scarcity).toLowerCase()} tier; the next role step-down is materially different.`
        : "No distinct high-priority role is down to three or fewer players right now.",
      scarcityCount,
    ));
    const marketCount = marketFall ? counts.get(`${marketFall.position}::${bucketFor(marketFall)}`) ?? 0 : 0;
    primary.append(renderDecisionCard(
      "Market fall",
      marketFall,
      marketFall
        ? `Still available ${Math.floor(currentPick - marketFall.adp)} picks after ESPN ADP. The role is shown so the fall is not mistaken for opportunity.`
        : "No researched player is at least six picks past ESPN ADP after the first two signals are removed.",
      marketCount,
    ));

    const alternatives = node("section", "alternatives-section");
    const heading = node("header", "section-heading");
    const headingCopy = node("div", "");
    headingCopy.append(node("p", "eyebrow", "Cross-check"), node("h3", "", "Best researched role by position"));
    heading.append(headingCopy, node("p", "section-note", "Role strength → security → offense → confidence. ESPN ADP breaks ties only."));
    alternatives.append(heading);
    const rows = node("div", "alternative-rows");
    for (const position of ["RB", "WR", "TE", "QB", "K", "D/ST"]) {
      const best = usable.filter((player) => player.position === position)
        .sort((left, right) => roleIndex(left) - roleIndex(right) || compareWithinRole(left, right))[0];
      if (best) rows.append(renderPlayerRow(best, { label: `${bucketFor(best)} · ${scarcityCopy(counts.get(`${position}::${bucketFor(best)}`) ?? 0)}` }));
    }
    if (!rows.childElementCount) rows.append(node("p", "empty-state", "No published role profiles are available yet."));
    alternatives.append(rows);
    dom.workspaceContent.replaceChildren(primary, alternatives);
  }

  function renderRoleLedger(groups) {
    const ledger = node("div", "role-ledger");
    for (const [bucket, players] of groups) {
      const item = node("div", `ledger-item${players.length <= 1 ? " is-scarce" : ""}${players.length === 0 ? " is-empty" : ""}`);
      item.append(node("strong", "", players.length), node("span", "", bucket));
      ledger.append(item);
    }
    return ledger;
  }

  function renderPosition(snapshot, position) {
    const [title, note] = POSITION_COPY[position];
    dom.workspaceEyebrow.textContent = "Role board";
    dom.workspaceTitle.textContent = title;
    dom.workspaceNote.textContent = note;
    const players = snapshot.available.filter((player) => player.position === position);
    const bucketNames = [...ROLE_GROUPS[position]];
    for (const player of players) {
      const bucket = bucketFor(player);
      if (!bucketNames.includes(bucket)) bucketNames.push(bucket);
    }
    if (!bucketNames.includes("Role uncertain")) bucketNames.push("Role uncertain");
    const groups = bucketNames.map((bucket) => [bucket, players.filter((player) => bucketFor(player) === bucket).sort(compareWithinRole)]);

    const board = node("div", "position-board");
    board.append(renderRoleLedger(groups));
    board.append(node("p", "ordering-rule", "Within a role: workload security → team scoring environment → research confidence → ESPN ADP only as a final tiebreak."));

    const sections = node("div", "role-sections");
    groups.forEach(([bucket, members], index) => {
      if (!members.length && index !== 0) return;
      const section = node("section", `role-section${bucket === "Role uncertain" ? " is-uncertain" : ""}`);
      const header = node("header", "role-heading");
      const copy = node("div", "");
      copy.append(node("h3", "", bucket), node("p", "", scarcityCopy(members.length)));
      header.append(copy, node("span", `role-count${members.length <= 1 ? " is-scarce" : ""}`, members.length));
      section.append(header);
      if (!members.length) {
        section.append(node("p", "role-empty", `No ${bucket.toLowerCase()} players remain. If this is the role you need, waiting cannot restore it.`));
      } else {
        const rows = node("div", "player-rows");
        const bucketKey = `${position}::${bucket}`;
        const expanded = app.expandedBuckets.has(bucketKey);
        const visibleMembers = expanded ? members : members.slice(0, 12);
        visibleMembers.forEach((player) => {
          rows.append(renderPlayerRow(player));
        });
        if (members.length > 12) {
          const showMore = node("button", "show-more", expanded ? "Show fewer" : `Show ${members.length - 12} more ${bucket.toLowerCase()}`);
          showMore.type = "button";
          showMore.dataset.expandBucket = bucketKey;
          rows.append(showMore);
        }
        section.append(rows);
      }
      sections.append(section);
    });
    if (!players.length) sections.append(node("p", "empty-state", `No available ${position} players are attached to this draft snapshot.`));
    board.append(sections);
    dom.workspaceContent.replaceChildren(board);
  }

  function renderWorkspace(snapshot) {
    dom.workspace.classList.remove("workspace-enter");
    void dom.workspace.offsetWidth;
    dom.workspace.classList.add("workspace-enter");
    if (app.activeTab === "NEXT") renderNextUp(snapshot);
    else renderPosition(snapshot, app.activeTab);
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
    renderRosterSummary(snapshot);
    renderWorkspace(snapshot);
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

  dom.decisionTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button || !app.snapshot) return;
    app.activeTab = button.dataset.tab;
    app.expandedPlayerId = null;
    app.expandedBuckets.clear();
    dom.decisionTabs.querySelectorAll("button[data-tab]").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    renderWorkspace(app.snapshot);
  });

  dom.workspaceContent.addEventListener("click", (event) => {
    const bucketButton = event.target.closest("button[data-expand-bucket]");
    if (bucketButton && app.snapshot) {
      const bucketKey = bucketButton.dataset.expandBucket;
      if (app.expandedBuckets.has(bucketKey)) app.expandedBuckets.delete(bucketKey);
      else app.expandedBuckets.add(bucketKey);
      renderWorkspace(app.snapshot);
      return;
    }
    const button = event.target.closest("button[data-expand-player]");
    if (!button || !app.snapshot) return;
    app.expandedPlayerId = app.expandedPlayerId === button.dataset.expandPlayer
      ? null
      : button.dataset.expandPlayer;
    renderWorkspace(app.snapshot);
  });

  function mockProfile(position, role, overrides = {}) {
    const researchedAt = new Date(Date.now() - 8 * 3_600_000).toISOString();
    const classifiedAt = new Date(Date.now() - 7 * 3_600_000).toISOString();
    const expiresAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
    return {
      schemaVersion: 2,
      profileId: `sample-${position}-${role}`,
      researchRunId: "sanitized-pilot-run-1",
      evidenceCutoffAt: new Date(Date.now() - 9 * 3_600_000).toISOString(),
      position,
      researchedRole: role,
      researchState: "complete",
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
      additionalFindings: {
        offenseScoringBand: "average",
        teamNotes: "The published team snapshot confirms the current first-team hierarchy and its primary competition.",
      },
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
      roleVocabularyVersion: "2026.3",
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
          structuredFindings: { position: "K", jobSecurityProbability: { low: 0.96, high: 1 }, competitionStatus: "settled" },
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
