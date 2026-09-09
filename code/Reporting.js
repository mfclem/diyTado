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
 *   • Magnus-Tetens dew point → humidityLevel (DRY / COMFY / HUMID)
 *   • ASHRAE 55 Adaptive Comfort Model → temperatureLevel (COLD / COOL / COMFY / WARM / HOT)
 *   • Time-since-last-open-window → airFreshness (FRESH / FAIR / STUFFY)
 * See function JSDoc for full algorithm details.
 */


const REPORT_STATE_INTERVAL_SEC  = 2.5 * 60;
const REPORT_STATE_LAST_RUN_KEY  = 'REPORT_STATE_LAST_RUN';
const NOTIF_COOLDOWN_MS          = 60 * 60 * 1000;  // 1 hour between repeat alerts
const NOTIF_LAST_KEY_PREFIX      = 'NOTIF_LAST_';   // + homeId_roomId_condition

function reportState() {
  var props   = PropertiesService.getScriptProperties();
  var lastRun = parseInt(props.getProperty(REPORT_STATE_LAST_RUN_KEY) || '0', 10);
  var now     = Date.now();

  if (now - lastRun < (REPORT_STATE_INTERVAL_SEC * 1000)) return null;  // too soon, skip

  props.setProperty(REPORT_STATE_LAST_RUN_KEY, String(now));

  var homeId = requireHomeId_();

  // Run air comfort check alongside state reporting.
  // checkAirComfortAlerts_(homeId);

  return apiReportStateAndNotification(generateStatesAndNotifications_(homeId, getSyncDevicesIds_()));
}



function generateStatesAndNotifications_(homeId, devices) {
  // var homeId = requireHomeId_();
  // var tado   = tadoClient_();
  // // Fetch rooms and write to cache
  // var rooms = tado.getRooms(homeId) || [];
  // try { CacheService.getScriptCache().put('ROOMS_' + homeId, JSON.stringify(rooms), 300); } catch (e) {}
  var rooms = getCacheRooms_(homeId) || [];

  var roomsById = indexRoomsById_(rooms);

  // Presence is fetched lazily once and written to cache
  var presence = null, presenceFetched = false;
  function currentPresence_() {
    if (!presenceFetched) {
      presenceFetched = true;
      try {
        var st = tado.getHomeState(homeId);
        presence = st && st.presence;  // 'HOME' | 'AWAY'
        try { CacheService.getScriptCache().put('PRESENCE_' + homeId, presence || '', 300); } catch (e) {}
      } catch (e) { presence = null; }
    }
    return presence;
  }

  var states = {};
  devices.forEach(function (d) {
    var parsed = parseDeviceId_(d.id);

    if (parsed.kind === 'room') {
      var room = roomsById[parsed.roomId];
      if (room) {
        var sensor  = room.sensorDataPoints || {};
        var setting = room.setting || {};
        var isOn    = setting.power === 'ON';
        var online  = !room.connection || room.connection.state === 'CONNECTED';
        // auto = no override, or NEXT_TIME_BLOCK (schedule is or will soon be in control).
        // heat = MANUAL or TIMER hold (explicit indefinite or timed override).
        // off  = power OFF.
        var termType = room.manualControlTermination && room.manualControlTermination.type;
        var mode    = isOn ? (termType === 'MANUAL' || termType === 'TIMER' ? 'heat' : 'auto') : 'off';

        var state = {
          online: online,
          thermostatMode: mode
        };
        if (sensor.insideTemperature && typeof sensor.insideTemperature.value === 'number') {
          state.thermostatTemperatureAmbient = sensor.insideTemperature.value;
        }
        if (sensor.humidity && typeof sensor.humidity.percentage === 'number') {
          state.thermostatHumidityAmbient = sensor.humidity.percentage;
        }
        if (setting.temperature && typeof setting.temperature.value === 'number') {
          state.thermostatTemperatureSetpoint = setting.temperature.value;
        } else if (!isOn && typeof state.thermostatTemperatureAmbient === 'number') {
          // Google requires a setpoint even when off; echo ambient as a placeholder.
          state.thermostatTemperatureSetpoint = state.thermostatTemperatureAmbient;
        }
        states[d.id] = state;
      }

    } else if (parsed.kind === 'openwindow') {
      var room = roomsById[parsed.roomId];
      if (room) {
        states[d.id] = {
          online: true,
          openPercent: room.openWindow ? 100 : 0
        };
      }

    } else if (parsed.kind === 'openwindowmode') {
      var room = roomsById[parsed.roomId];
      if (room) {
        states[d.id] = {
          online: true,
          on: !!(room.openWindow && room.openWindow.activated)
        };
      }

    } else if (parsed.kind === 'heating') {
      var room = roomsById[parsed.roomId];
      if (room) {
        var pct = room.heatingPower && typeof room.heatingPower.percentage === 'number'
                    ? room.heatingPower.percentage : 0;
        states[d.id] = {
          online: true,
          currentSensorStateData: [{ name: 'HeatingActive', currentSensorState: pct > 0 ? 'ACTIVE' : 'INACTIVE' }]
        };
      }

    } else if (parsed.kind === 'humidity') {
      var room = roomsById[parsed.roomId];
      if (room) {
        var sensor = room.sensorDataPoints || {};
        states[d.id] = {
          online: true,
          humidityAmbientPercent: sensor.humidity ? sensor.humidity.percentage : 0
        };
      }

    } else if (parsed.kind === 'resumeroom') {
      var room = roomsById[parsed.roomId];
      if (room) {
        var termination = room.manualControlTermination;
        states[d.id] = {
          online: true,
          on: !!(termination && termination.type === 'NEXT_TIME_BLOCK')
        };
      }

    } else if (parsed.kind === 'presence') {
      // Stateful presence switch — on = HOME, off = AWAY.
      // var p = currentPresence_();
      // states[d.id] = { online: true, on: p === 'HOME' };
    }
    // boost / resume (whole-home) / alloff are momentary (willReportState: false) — excluded.
  });

  var statesAndNotifications = {
    states: states
  };
  console.log("States and Notifications: " + JSON.stringify(statesAndNotifications, null, 2));
  return statesAndNotifications;
}

/**
 * Compute air comfort levels locally, replicating tado°'s airComfort endpoint
 * without requiring a paid subscription.
 *
 * @param {Array}  rooms                Array of room objects as returned by getRooms().
 * @param {number} temperatureOutdoorAvg Mean outdoor temperature in °C (e.g. from getWeather()).
 * @param {number|null} lastOpenWindow   Timestamp (ms) of the last open-window event, or null.
 *
 * @return {{
 *   freshness: { value: 'FRESH'|'FAIR'|'STUFFY' },
 *   comfort: Array<{
 *     roomId: number,
 *     temperatureLevel: 'COLD'|'COOL'|'COMFY'|'WARM'|'HOT',
 *     humidityLevel: 'DRY'|'COMFY'|'HUMID'
 *   }>
 * }}
 *
 * ALGORITHMS
 * ----------
 * humidityLevel — Dew Point (Magnus-Tetens approximation):
 *   Td = (243.04 × (ln(RH/100) + 17.625×T/(243.04+T)))
 *        / (17.625 - (ln(RH/100) + 17.625×T/(243.04+T)))
 *   Td < 12.8°C  → DRY
 *   Td 12.8–15.5°C → COMFY
 *   Td > 15.5°C  → HUMID
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
 *   < 4 h  → FRESH
 *   4–8 h  → FAIR
 *   > 8 h  → STUFFY
 *   null / not provided → FAIR
 */
function computeAirComfort_(rooms, temperatureOutdoorAvg, lastOpenWindow) {

  // --- airFreshness -----------------------------------------------------------
  var freshnessValue;
  if (lastOpenWindow) {
    var elapsedHours = (Date.now() - lastOpenWindow) / (1000 * 60 * 60);
    if (elapsedHours < 4) {
      freshnessValue = 'FRESH';
    } else if (elapsedHours <= 8) {
      freshnessValue = 'FAIR';
    } else {
      freshnessValue = 'STUFFY';
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
      else                       temperatureLevel = 'HOT';
      }

    // humidityLevel — Magnus-Tetens dew point
    var humidityLevel = 'COMFY';
    if (t !== null && rh !== null && rh > 0) {
      var lnRH = Math.log(rh / 100);
      var gamma = lnRH + (17.625 * t) / (243.04 + t);
      var dewPoint = (243.04 * gamma) / (17.625 - gamma);
      if      (dewPoint < 12.8) humidityLevel = 'DRY';
      else if (dewPoint <= 15.5) humidityLevel = 'COMFY';
      else                       humidityLevel = 'HUMID';
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
 * Return the rolling 24-hour mean outdoor temperature (°C), updating the
 * stored reading list with the current weather value if available.
 *
 * Readings are stored as a JSON array of { t: timestamp_ms, v: celsius }
 * in Script Property OUTDOOR_TEMP_READINGS. On each call:
 *   1. The current outdoor temperature (from getCacheWeather_) is appended.
 *   2. Readings older than 24 hours are dropped.
 *   3. The mean of remaining readings is returned.
 *
 * With a 30-minute weather cache TTL, up to 48 readings accumulate — small
 * enough to fit comfortably within the 9 KB Script Property limit.
 *
 * @param  {string} homeId
 * @param  {number|null} currentOutdoorTemp  Current outdoor temperature in °C,
 *         or null to skip appending (just compute mean from stored readings).
 * @return {number|null}  Mean temperature, or null if no readings available.
 */
var OUTDOOR_TEMP_READINGS_KEY = 'OUTDOOR_TEMP_READINGS';
var OUTDOOR_TEMP_WINDOW_MS    = 24 * 60 * 60 * 1000;  // 24 hours

function getOutdoorTempAvg_(homeId, currentOutdoorTemp) {
  var props    = PropertiesService.getScriptProperties();
  var key      = OUTDOOR_TEMP_READINGS_KEY + '_' + homeId;
  var now      = Date.now();
  var readings = [];

  try {
    var raw = props.getProperty(key);
    if (raw) readings = JSON.parse(raw);
  } catch (e) { readings = []; }

  // Append current reading if provided.
  if (typeof currentOutdoorTemp === 'number' && !isNaN(currentOutdoorTemp)) {
    readings.push({ t: now, v: currentOutdoorTemp });
  }

  // Drop readings older than 24 hours.
  var cutoff = now - OUTDOOR_TEMP_WINDOW_MS;
  readings = readings.filter(function (r) { return r.t >= cutoff; });

  // Persist updated list.
  try { props.setProperty(key, JSON.stringify(readings)); } catch (e) {}

  if (!readings.length) return null;
  var sum = readings.reduce(function (acc, r) { return acc + r.v; }, 0);
  return sum / readings.length;
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

/**
 * Compute air comfort for all rooms and send a single Calendar notification
 * if any alert-worthy condition is detected, subject to per-condition cooldown.
 *
 * Alert conditions:
 *   temperatureLevel : COLD or HOT
 *   humidityLevel    : HUMID
 *   freshness        : STUFFY
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
  var tempAvg     = getOutdoorTempAvg_(homeId, outdoorTemp);
  if (tempAvg === null) return;  // not enough data yet for ASHRAE model

  var comfort     = computeAirComfort_(rooms, tempAvg, null);
  var roomsById   = indexRoomsById_(rooms);
  var props       = PropertiesService.getScriptProperties();
  var now         = Date.now();
  var alerts      = [];

  // Check per-room conditions.
  comfort.comfort.forEach(function (r) {
    var roomName = roomsById[String(r.roomId)]
                     ? roomsById[String(r.roomId)].name
                     : 'Room ' + r.roomId;

    var conditions = [];
    if (r.temperatureLevel === 'COLD' || r.temperatureLevel === 'HOT') {
      conditions.push(r.temperatureLevel);
    }
    if (r.humidityLevel === 'HUMID') {
      conditions.push('HUMID');
    }

    conditions.forEach(function (cond) {
      var key     = NOTIF_LAST_KEY_PREFIX + homeId + '_' + r.roomId + '_' + cond;
      var lastStr = props.getProperty(key);
      var last    = lastStr ? parseInt(lastStr, 10) : 0;
      if (now - last >= NOTIF_COOLDOWN_MS) {
        props.setProperty(key, String(now));
        alerts.push(roomName + ': ' + cond);
      }
    });
  });

  // Check home-level freshness.
  if (comfort.freshness.value === 'STUFFY') {
    var key     = NOTIF_LAST_KEY_PREFIX + homeId + '_home_STUFFY';
    var lastStr = props.getProperty(key);
    var last    = lastStr ? parseInt(lastStr, 10) : 0;
    if (now - last >= NOTIF_COOLDOWN_MS) {
      props.setProperty(key, String(now));
      alerts.push('Home: STUFFY');
    }
  }

  if (!alerts.length) return;

  var title       = 'Air Comfort Alert';
  var description = alerts.join('\n');
  sendCalendarNotification_(title, description);
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
  var end = new Date(now.getTime() + 60 * 1000);  // 1-minute event
  var event = cal.createEvent(title, now, end, { description: description });
  event.addPopupReminder(0);  // notify at time of event
}
