/**
 * Reporting.js — Proactive state reporting and air comfort computation
 * =====================================================================
 *
 * PURPOSE
 * -------
 * Builds device state payloads for the HomeGraph push (via apiReportStateAndNotification
 * in Homegraph.js), and provides a local air-comfort computation that replicates
 * the tado° airComfort endpoint without requiring a paid subscription.
 *
 * ENTRY POINT
 * -----------
 * reportState() — designed to be triggered every 1 minute. Self-throttles to
 *   execute every ~3 minutes using REPORT_STATE_LAST_RUN in Script Properties.
 *   Setup: Apps Script editor → Triggers → Add trigger
 *     Function: reportState   Event source: Time-driven   Type: Minutes timer   Every minute
 *
 * DEVICES THAT REPORT STATE
 * -------------------------
 * Only devices whose SYNC descriptor carries willReportState:true participate
 * in proactive reporting (defined in GoogleHomeAction.js onSync_).
 *
 *   • THERMOSTAT rooms  (willReportState: true)
 *       Reports: thermostatMode (off / heat / auto), thermostatTemperatureAmbient,
 *                thermostatTemperatureSetpoint, thermostatHumidityAmbient,
 *                online (reflects room connection state).
 *       auto = no override or NEXT_TIME_BLOCK; heat = MANUAL or TIMER hold.
 *
 *   • "<Room> — Open Window" sensors  (willReportState: true)
 *       Reports: openPercent (0 = no window detected, 100 = window detected).
 *
 *   • "<Room> — Open Window Mode" switches  (willReportState: true)
 *       Reports: on = heating suspended (openWindow.activated === true).
 *
 *   • "Resume <Room>" switches  (willReportState: true)
 *       Reports: on = manualControlTermination.type === 'NEXT_TIME_BLOCK'.
 *
 *   • "Presence" switch  (willReportState: true)
 *       Reports: on = (tado° presence === 'HOME'), off = AWAY.
 *
 *   • "Outdoor Temperature" thermostat  (willReportState: true)
 *       Reports: thermostatTemperatureAmbient = tado° outsideTemperature.celsius.
 *       thermostatMode is always 'auto' (queryOnlyTemperatureSetting device).
 *
 *   • "Boost Heating" / "Activate Schedule" / "Heating Off" whole-home switches  (willReportState: false)
 *   • "Resume <Room>" when momentary  (willReportState: false)
 *       Momentary — excluded from proactive reporting.
 *
 * CACHING
 * -------
 * generateStatesAndNotifications_() writes fresh rooms (300s TTL) and presence
 * (300s TTL) to CacheService so QUERY fulfillment in GoogleHomeAction.js can
 * serve them without a live tado° call between trigger executions.
 *
 * AIR COMFORT — computeAirComfort_(rooms, temperatureOutdoorAvg, lastOpenWindow)
 * -------------------------------------------------------------------------------
 * Local replication of tado°'s paid airComfort endpoint using:
 *   • Magnus-Tetens dew point → humidityLevel (DRY / COMFY / HUMID / MUGGY)
 *   • ASHRAE 55 Adaptive Comfort Model → temperatureLevel (COLD / COOL / COMFY / WARM / HOT)
 *   • Time-since-last-open-window → airFreshness (FRESH / FAIR / STALE)
 * See function JSDoc for full algorithm details.
 */


const REPORT_STATE_INTERVAL_SEC  = 2.5 * 60;
const REPORT_STATE_LAST_RUN_KEY  = 'REPORT_STATE_LAST_RUN';
const NOTIF_COOLDOWN_MS          = 30 * 60 * 1000;  // 1/2 hour between repeat alerts
const NOTIF_LAST_KEY_PREFIX      = 'NOTIF_LAST_';   // + roomId_condition  or  STALE

function reportState() {
  var props   = PropertiesService.getScriptProperties();
  var lastRun = parseInt(props.getProperty(REPORT_STATE_LAST_RUN_KEY) || '0', 10);
  var now     = Date.now();

  if (now - lastRun < (REPORT_STATE_INTERVAL_SEC * 1000)) return null;  // too soon, skip

  props.setProperty(REPORT_STATE_LAST_RUN_KEY, String(now));

  var homeId = requireHomeId_();

  // Reports devices states to Home Graph.
  apiReportStateAndNotification(generateStatesAndNotifications_(homeId, getSyncDevicesIds_()));

  // Run air comfort check alongside state reporting.
  checkAirComfortAlerts_(homeId);
}


function generateStatesAndNotifications_(homeId, devices) {
  var rooms     = getCacheRooms_(homeId) || [];
  var roomsById = indexRoomsById_(rooms);
  var weather   = getCacheWeather_(homeId);
  var closest   = getClosestDeviceDistance_(homeId);
  var distanceInfo = closest ? { brightness: computeDistanceBrightness_(closest.rel, closest.atHome) } : null;

  var states = {};
  devices.forEach(function (d) {
    var parsed = parseDeviceId_(d.id);
    // Pass null for presence — presence on/off is excluded from HomeGraph push.
    // distanceInfo is passed so brightness is included in the push for the presence dimmer.
    var state  = computeDeviceState_(parsed, roomsById, weather, distanceInfo, null);
    if (state) states[d.id] = state;
    // null = momentary whole-home switch (willReportState:false) — correctly excluded.
  });

  var statesAndNotifications = { states: states };
  console.log("States and Notifications: " + JSON.stringify(statesAndNotifications, null, 2));
  return statesAndNotifications;
}

/**
 * Compute air comfort for all rooms and send a single Calendar notification
 * if any alert-worthy condition is detected, subject to per-condition cooldown.
 *
 * Alert conditions:
 *   temperatureLevel : COLD or HOT
 *   humidityLevel    : MUGGY
 *   freshness        : STALE
 *
 * Cooldown: NOTIF_COOLDOWN_MS (1 hour) per condition per room, stored in
 * Script Properties under NOTIF_LAST_<homeId>_<roomId>_<condition>.
 */
function checkAirComfortAlerts_(homeId) {
  var rooms   = getCacheRooms_(homeId);
  if (!rooms || !rooms.length) return;

  var weather     = getCacheWeather_(homeId);
  var outdoorTemp = weather && weather.outsideTemperature
                      ? weather.outsideTemperature.celsius : null;
  var tempAvg     = getOutdoorTempAvg_(outdoorTemp);
  if (tempAvg === null) return;  // not enough data yet for ASHRAE model

  // Update LAST_OPEN_WINDOW whenever any room currently has an active open window.
  // Never cleared — allows freshness to degrade to STALE after 30+ hours.
  var props = PropertiesService.getScriptProperties();
  var now   = Date.now();
  if (rooms.some(function (r) { return !!r.openWindow; })) {
    props.setProperty('LAST_OPEN_WINDOW', String(now));
  }
  var owStr          = props.getProperty('LAST_OPEN_WINDOW');
  var lastOpenWindow = owStr ? parseInt(owStr, 10) : null;

  var comfort   = computeAirComfort_(rooms, tempAvg, lastOpenWindow);
  console.log("Air Comfort: " + JSON.stringify(comfort, null, 2));
  var roomsById    = indexRoomsById_(rooms);
  var roomAlerts   = {};  // roomName → [conditions that passed cooldown]

  // Check per-room conditions.
  comfort.comfort.forEach(function (r) {
    var roomName = roomsById[String(r.roomId)]
                     ? roomsById[String(r.roomId)].name
                     : 'Room ' + r.roomId;

    var conditions = [];
    if (r.temperatureLevel === 'COLD') conditions.push('froid');
    else if (r.temperatureLevel === 'HOT') conditions.push('chaud');
    if (r.humidityLevel === 'MUGGY') conditions.push('lourd');

    conditions.forEach(function (cond) {
      var key     = NOTIF_LAST_KEY_PREFIX + r.roomId + '_' + cond;
      var lastStr = props.getProperty(key);
      var last    = lastStr ? parseInt(lastStr, 10) : 0;
      if (now - last >= NOTIF_COOLDOWN_MS) {
        props.setProperty(key, String(now));
        if (!roomAlerts[roomName]) roomAlerts[roomName] = [];
        roomAlerts[roomName].push(cond);
      }
    });
  });

  // Build grouped alert lines: "Living Room: froid, humide"
  var alerts = Object.keys(roomAlerts).map(function (name) {
    return name + ': ' + roomAlerts[name].join(', ');
  });

  // Check home-level freshness — only notify when someone is home.
  if (comfort.freshness.value === 'STALE') {
    var presence = props.getProperty('PRESENCE_' + homeId);
    if (presence === 'HOME') {
      var key     = NOTIF_LAST_KEY_PREFIX + 'STALE';
      var lastStr = props.getProperty(key);
      var last    = lastStr ? parseInt(lastStr, 10) : 0;
      if (now - last >= NOTIF_COOLDOWN_MS) {
        props.setProperty(key, String(now));
        alerts.push('Maison: confiné');
      }
    }
  }

  if (!alerts.length) return;

  //var title       = 'Air Comfort Alert';
  var title = '⚠️ Air ' + alerts.join('; ');
  var description = alerts.join('\n');
  console.log("* Air Comfort Notification *" + "\n- Title: " + title + "\n- Description:\n" + description);
  sendCalendarNotification_(title, description);
}

/**
 * Compute air comfort levels locally, replicating tado°'s airComfort endpoint
 * without requiring a paid subscription.
 *
 * @param {Array}  rooms                Array of room objects as returned by getRooms().
 * @param {number} temperatureOutdoorAvg ASHRAE 55 EWM of daily mean outdoor temperatures (°C).
 * @param {number|null} lastOpenWindow   Timestamp (ms) of the last open-window event, or null.
 *
 * @return {{
 *   freshness: { value: 'FRESH'|'FAIR'|'STALE' },
 *   comfort: Array<{
 *     roomId: number,
 *     temperatureLevel: 'COLD'|'COOL'|'COMFY'|'WARM'|'HOT',
 *     humidityLevel: 'DRY'|'COMFY'|'HUMID'|'MUGGY'
 *   }>
 * }}
 *
 * ALGORITHMS
 * ----------
 * humidityLevel — Dew Point (Magnus-Tetens approximation):
 *   Td = (243.04 × (ln(RH/100) + 17.625×T/(243.04+T)))
 *        / (17.625 - (ln(RH/100) + 17.625×T/(243.04+T)))
 *   Td < 10°C  → DRY
 *   Td 10–16°C → COMFY
 *   Td 16–18°C → HUMID
 *   Td > 18°C  → MUGGY
 *
 * temperatureLevel — ASHRAE 55 Adaptive Comfort Model:
 *   T_opt = 0.31 × T_out + 17.8   (optimal indoor temperature)
 *   Comfort band ≈ ±3.5°C (80% acceptability)
 *   T < T_opt - 3.5              → COLD
 *   T_opt - 3.5 ≤ T < T_opt - 2.5 → COOL
 *   T_opt - 2.5  ≤ T ≤ T_opt + 2.5 → COMFY
 *   T_opt + 2.5  < T ≤ T_opt + 3.5 → WARM
 *   T > T_opt + 3.5              → HOT
 *
 * airFreshness — time since last open window:
 *   all rooms heating off → FAIR (ventilation is expected, freshness not a concern)
 *   < 12 h  → FRESH
 *   12–30 h → FAIR
 *   > 30 h  → STALE
 *   null / not provided → FAIR
 */
function computeAirComfort_(rooms, temperatureOutdoorAvg, lastOpenWindow) {

  // --- airFreshness -----------------------------------------------------------
  // When all rooms have heating off, ventilation is expected behaviour and
  // freshness is not a concern — always report FAIR in that case.
  var allOff = (rooms || []).every(function (r) {
    return !r.setting || r.setting.power !== 'ON';
  });

  var freshnessValue;
  if (allOff) {
    freshnessValue = 'FAIR';
  } else if (lastOpenWindow) {
    var elapsedHours = (Date.now() - lastOpenWindow) / (1000 * 60 * 60);
    if (elapsedHours < 12) {
      freshnessValue = 'FRESH';
    } else if (elapsedHours <= 30) {
      freshnessValue = 'FAIR';
    } else {
      freshnessValue = 'STALE';
    }
  } else {
    freshnessValue = 'FAIR';
  }

  // --- ASHRAE 55 optimal indoor temperature -----------------------------------
  var tOpt = 0.31 * temperatureOutdoorAvg + 17.8;

  // --- Per-room comfort -------------------------------------------------------
  var comfort = (rooms || []).map(function (room) {
    var sensor   = room.sensorDataPoints || {};
    var tempData = sensor.insideTemperature || {};
    var humData  = sensor.humidity || {};
    var t        = typeof tempData.value === 'number' ? tempData.value : null;
    var rh       = typeof humData.percentage === 'number' ? humData.percentage : null;

    // temperatureLevel
    var temperatureLevel = 'COMFY';
    if (t !== null) {
      if      (t < tOpt - 3.5)  temperatureLevel = 'COLD';
      else if (t < tOpt - 2.5)  temperatureLevel = 'COOL';
      else if (t <= tOpt + 2.5) temperatureLevel = 'COMFY';
      else if (t <= tOpt + 3.5) temperatureLevel = 'WARM';
      else                      temperatureLevel = 'HOT';
      }

    // humidityLevel — Magnus-Tetens dew point
    var humidityLevel = 'COMFY';
    if (t !== null && rh !== null && rh > 0) {
      var lnRH = Math.log(rh / 100);
      var gamma = lnRH + (17.625 * t) / (243.04 + t);
      var dewPoint = (243.04 * gamma) / (17.625 - gamma);
      if      (dewPoint < 10)  humidityLevel = 'DRY';
      else if (dewPoint <= 16) humidityLevel = 'COMFY';
      else if (dewPoint <= 18) humidityLevel = 'HUMID';
      else                     humidityLevel = 'MUGGY';
    }

    return {
      roomId:           room.id,
      temperatureLevel: temperatureLevel,
      humidityLevel:    humidityLevel
    };
  });

  return {
    freshness: { value: freshnessValue },
    comfort:   comfort
  };
}


/**
 * Return the ASHRAE 55 exponentially weighted running mean (EWM) outdoor
 * temperature over the last 7 days, updating the incremental daily mean for
 * today with the current reading.
 *
 * Storage: Script Property OUTDOOR_TEMP_READINGS holds a JSON array of up to
 * 7 entries, one per calendar day (local script timezone), newest last:
 *   { d: 'YYYY-MM-DD', mean: number, count: number }
 * Each call updates today's entry using an incremental mean (no raw readings
 * kept), keeping storage at ~7 × 50 bytes regardless of call frequency.
 *
 * EWM formula (α = 0.8, ASHRAE 55 §5.3.3):
 *   T_rm = (1−α) × Σ_{i=1}^{n} α^{i−1} × T_{d−i}
 * where T_{d−i} is the daily mean i days ago. The sum is normalised so that
 * partial history (cold-start) still yields a valid result.
 *
 * @param  {number|null} currentOutdoorTemp  Current outdoor temperature in °C,
 *         or null to skip updating today's mean.
 * @return {number|null}  EWM temperature, or null if no data available yet.
 */
var OUTDOOR_TEMP_READINGS_KEY = 'OUTDOOR_TEMP_READINGS';
var OUTDOOR_TEMP_EWM_ALPHA    = 0.8;
var OUTDOOR_TEMP_DAYS         = 7;

function getOutdoorTempAvg_(currentOutdoorTemp) {
  var props = PropertiesService.getScriptProperties();
  var today = todayDateString_();
  var days  = [];

  try {
    var raw = props.getProperty(OUTDOOR_TEMP_READINGS_KEY);
    if (raw) days = JSON.parse(raw);
  } catch (e) { days = []; }

  // Update or create today's incremental mean.
  if (typeof currentOutdoorTemp === 'number' && !isNaN(currentOutdoorTemp)) {
    var todayEntry = null;
    for (var i = 0; i < days.length; i++) {
      if (days[i].d === today) { todayEntry = days[i]; break; }
    }
    if (todayEntry) {
      todayEntry.mean  = (todayEntry.mean * todayEntry.count + currentOutdoorTemp) / (todayEntry.count + 1);
      todayEntry.count += 1;
    } else {
      days.push({ d: today, mean: currentOutdoorTemp, count: 1 });
    }
  }

  // Keep only the last 7 days, sorted oldest→newest.
  days.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
  if (days.length > OUTDOOR_TEMP_DAYS) {
    days = days.slice(days.length - OUTDOOR_TEMP_DAYS);
  }

  try { props.setProperty(OUTDOOR_TEMP_READINGS_KEY, JSON.stringify(days)); } catch (e) {}

  if (!days.length) return null;

  // ASHRAE 55 EWM: weight day[n-1] (yesterday) by (1-α)α^0, day[n-2] by (1-α)α^1, etc.
  // today's entry is excluded — it is a partial day and not yet complete.
  var pastDays = days.filter(function (d) { return d.d !== today; });
  if (!pastDays.length) {
    // Only today's partial data available — fall back to its mean.
    return days[days.length - 1].mean;
  }

  // Iterate from most-recent past day backwards.
  var alpha      = OUTDOOR_TEMP_EWM_ALPHA;
  var weightSum  = 0;
  var weightedSum = 0;
  for (var j = 0; j < pastDays.length; j++) {
    var w = Math.pow(alpha, j);   // j=0 → yesterday, j=1 → 2 days ago, …
    weightedSum += w * pastDays[pastDays.length - 1 - j].mean;
    weightSum   += w;
  }
  return weightedSum / weightSum;
}

/** Returns today's date as 'YYYY-MM-DD' in the script's local timezone. */
function todayDateString_() {
  var d = new Date();
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * Create a 1-minute Calendar event to deliver a push notification.
 * Requires Script Property CALENDAR_NOTIFICATION_ID — the ID of a dedicated
 * Google Calendar with its default reminder set to 0 minutes (at event time).
 *
 * Setup:
 *   1. Create a calendar named e.g. "Home Notifications" in Google Calendar.
 *   2. Set its default reminder to 0 minutes (at time of event).
 *   3. Copy its calendar ID into Script Property CALENDAR_NOTIFICATION_ID.
 *   4. Add https://www.googleapis.com/auth/calendar to appsscript.json oauthScopes.
 */
function sendCalendarNotification_(title, description) {
  var calendarId = PropertiesService.getScriptProperties()
                     .getProperty('CALENDAR_NOTIFICATION_ID');
  if (!calendarId) {
    console.warn('sendCalendarNotification_: CALENDAR_NOTIFICATION_ID not set');
    return;
  }
  var cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) {
    console.warn('sendCalendarNotification_: calendar not found — ' + calendarId);
    return;
  }
  var now = new Date();
  var end = new Date(now.getTime() + NOTIF_COOLDOWN_MS);  // 1/2 hour event
  var event = cal.createEvent(title, now, end, { description: description });
  event.addPopupReminder(0);  // notify at time of event
}

function test_sendCalendarNotification() {
  return sendCalendarNotification_("⚠️ Air Séjour: chaud, lourd; Chambre: froid; Maison: confiné", "Séjour: chaud, lourd\nChambre: froid\nMaison: confiné");
}

function getCacheRooms_(homeId) {
  var rooms = null;
  var cache = CacheService.getScriptCache();
  var key   = 'ROOMS_' + homeId;
  var hit   = cache.get(key);
  if (hit !== null) {
    try { rooms = JSON.parse(hit); } catch (e) { rooms = null; }
  } else {
    try {
      var tado = tadoClient_();
      rooms = tado.getRooms(homeId);
      try { cache.put(key, JSON.stringify(rooms), REPORT_STATE_INTERVAL_SEC); } catch (e) {}
    } catch (e) { rooms = null; }
  }
  return rooms;
}

function getCacheWeather_(homeId) {
  var weather = null;
  var cache   = CacheService.getScriptCache();
  var key     = 'WEATHER_' + homeId;
  var hit     = cache.get(key);
  if (hit !== null) {
    try { weather = JSON.parse(hit); } catch (e) { weather = null; }
  } else {
    try {
      var tado = tadoClient_();
      weather = tado.getWeather(homeId);
      try { cache.put(key, JSON.stringify(weather), 29 * 60); } catch (e) {}
    } catch (e) { weather = null; }
  }
  return weather;
}

function getCacheMobileDevices_(homeId) {
  var cache   = CacheService.getScriptCache();
  var key     = 'MOBILE_DEVICES_' + homeId;
  var devices = null;
  var hit     = cache.get(key);
  if (hit !== null) {
    try { devices = JSON.parse(hit); } catch (e) { devices = null; }
  } else {
    try {
      devices = tadoClient_().getMobileDevices(homeId);
      try { cache.put(key, JSON.stringify(devices), 14 * 60); } catch (e) {}
    } catch (e) { devices = null; }
  }
  return devices;
}

/**
 * Return { rel, atHome } for the device closest to the home geofence, or null.
 *
 * Qualifying devices: geoTrackingEnabled === true, location present, not stale.
 * Among qualifying devices, the one with the smallest relativeDistanceFromHomeFence
 * is selected (0 = at fence boundary, positive = outside).
 */
function getClosestDeviceDistance_(homeId) {
  var devices = getCacheMobileDevices_(homeId);
  if (!devices) return null;
  var best = null;
  devices.forEach(function (d) {
    if (!d.settings || !d.settings.geoTrackingEnabled) return;
    var loc = d.location;
    if (!loc || loc.stale) return;
    var rel = typeof loc.relativeDistanceFromHomeFence === 'number'
                ? loc.relativeDistanceFromHomeFence : Infinity;
    if (best === null || rel < best.rel) {
      best = { rel: rel, atHome: !!loc.atHome };
    }
  });
  return best;
}
