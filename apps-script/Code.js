const CONTROL_SHEET = "Publish Control";
const IMPORT_TABS = [
  "Team Snapshots",
  "QB Profiles",
  "RB Profiles",
  "WR Profiles",
  "TE Profiles",
  "K Profiles",
  "DST Profiles",
];
const CONTROL_ROWS = [
  ["key", "value"],
  ["request_state", "IDLE"],
  ["request_id", ""],
  ["requested_at", ""],
  ["requested_by", ""],
  ["last_publication_id", ""],
  ["last_profile_count", ""],
  ["last_completed_at", ""],
  ["last_error", ""],
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Draftside")
    .addItem("Publish research now", "requestResearchPublication")
    .addItem("Install automatic publisher", "setupDraftsidePublishing")
    .addToUi();
}

function setupDraftsidePublishing() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty("DRAFTSIDE_SPREADSHEET_ID", spreadsheet.getId());
  ensureControlSheet_(spreadsheet);
  const publishUrl = properties.getProperty("DRAFTSIDE_PUBLISH_URL");
  const triggerToken = properties.getProperty("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN");
  if (!publishUrl || !/^https:\/\//.test(publishUrl) || !triggerToken || triggerToken.length < 32) {
    showSetupMessage_(
      "Draftside control is ready. Configure the HTTPS publisher URL and trigger token in Script Properties, then run this installer again to enable automatic publishing.",
    );
    return;
  }
  ensureAutomaticPublisherTrigger_();
  showSetupMessage_(
    "Draftside automatic publishing is installed.",
  );
}

function showSetupMessage_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    console.log(message);
  }
}

function configureDraftsidePublishing(spreadsheetId, publishUrl, triggerToken) {
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error("DRAFTSIDE_SPREADSHEET_ID is invalid");
  }
  if (!publishUrl || !/^https:\/\//.test(publishUrl)) {
    throw new Error("DRAFTSIDE_PUBLISH_URL must use HTTPS");
  }
  if (!triggerToken || triggerToken.length < 32) {
    throw new Error("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN is invalid");
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    DRAFTSIDE_SPREADSHEET_ID: spreadsheet.getId(),
    DRAFTSIDE_PUBLISH_URL: publishUrl,
    DRAFTSIDE_PUBLISH_TRIGGER_TOKEN: triggerToken,
  });
  ensureControlSheet_(spreadsheet);
  const triggerInstalled = ensureAutomaticPublisherTrigger_();
  return {
    spreadsheetId: spreadsheet.getId(),
    publishUrl,
    triggerInstalled,
  };
}

function ensureAutomaticPublisherTrigger_() {
  const existing = ScriptApp.getProjectTriggers().some(
    (trigger) => trigger.getHandlerFunction() === "processResearchPublicationRequests",
  );
  if (existing) return false;
  ScriptApp.newTrigger("processResearchPublicationRequests").timeBased().everyMinutes(1).create();
  return true;
}

function requestResearchPublication() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const control = ensureControlSheet_(spreadsheet);
  const email = Session.getActiveUser().getEmail();
  control.getRange("B3:B5").setValues([
    [Utilities.getUuid()],
    [new Date().toISOString()],
    [email || "Fred/manual"],
  ]);
  control.getRange("B2").setValue("REQUESTED");
  SpreadsheetApp.flush();
  processResearchPublicationRequests();
}

function processResearchPublicationRequests() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const spreadsheetId = properties.getProperty("DRAFTSIDE_SPREADSHEET_ID");
    if (!spreadsheetId) throw new Error("DRAFTSIDE_SPREADSHEET_ID is not configured");
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const control = ensureControlSheet_(spreadsheet);
    const state = String(control.getRange("B2").getDisplayValue()).trim().toUpperCase();
    if (state !== "REQUESTED") return;
    const requestId = String(control.getRange("B3").getDisplayValue()).trim() || Utilities.getUuid();
    const requestedAt = String(control.getRange("B4").getDisplayValue()).trim() || new Date().toISOString();
    const requestedBy = String(control.getRange("B5").getDisplayValue()).trim() || "Verl";
    control.getRange("B2").setValue("RUNNING");
    control.getRange("B3:B5").setValues([[requestId], [requestedAt], [requestedBy]]);
    control.getRange("B9").clearContent();
    SpreadsheetApp.flush();
    try {
      const result = sendResearchImport_(spreadsheet, requestId, requestedAt, requestedBy, properties);
      control.getRange("B2").setValue("SUCCEEDED");
      control.getRange("B6:B9").setValues([
        [result.publicationId],
        [result.profileCount],
        [new Date().toISOString()],
        [""],
      ]);
    } catch (error) {
      control.getRange("B2").setValue("FAILED");
      control.getRange("B8:B9").setValues([
        [new Date().toISOString()],
        [safeError_(error)],
      ]);
      throw error;
    }
  } finally {
    lock.releaseLock();
  }
}

function sendResearchImport_(spreadsheet, requestId, requestedAt, requestedBy, properties) {
  const publishUrl = properties.getProperty("DRAFTSIDE_PUBLISH_URL");
  const triggerToken = properties.getProperty("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN");
  if (!publishUrl || !/^https:\/\//.test(publishUrl)) throw new Error("DRAFTSIDE_PUBLISH_URL must use HTTPS");
  if (!triggerToken || triggerToken.length < 32) throw new Error("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN is not configured");
  const ranges = {};
  IMPORT_TABS.forEach((tab) => {
    const sheet = spreadsheet.getSheetByName(tab);
    if (!sheet) throw new Error(`${tab} is missing`);
    ranges[tab] = sheet.getDataRange().getDisplayValues();
  });
  const response = UrlFetchApp.fetch(publishUrl, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${triggerToken}` },
    payload: JSON.stringify({
      schemaVersion: 1,
      spreadsheetId: spreadsheet.getId(),
      requestId,
      requestedAt,
      requestedBy,
      ranges,
    }),
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  let result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (_error) {
    throw new Error(`Draftside publisher returned HTTP ${status}`);
  }
  if (status < 200 || status >= 300) {
    const problems = Array.isArray(result.problems) ? `: ${result.problems.slice(0, 10).join("; ")}` : "";
    throw new Error(`${result.error || "publish_failed"}${problems}`);
  }
  if (!result.publicationId || typeof result.profileCount !== "number") {
    throw new Error("Draftside publisher returned an invalid acknowledgement");
  }
  return result;
}

function ensureControlSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(CONTROL_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONTROL_SHEET);
    sheet.getRange(1, 1, CONTROL_ROWS.length, 2).setValues(CONTROL_ROWS);
    sheet.setFrozenRows(1);
    sheet.getRange("A1:B1").setFontWeight("bold");
    sheet.autoResizeColumns(1, 2);
  }
  return sheet;
}

function safeError_(error) {
  const message = error && error.message ? String(error.message) : "publish_failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
