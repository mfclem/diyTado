/**
 * Google Smart-Home Action for tado°X — Apps Script fulfillment + OAuth
 * =====================================================================
 *
 * Turns your tado°X rooms into Google Home devices, backed entirely by Apps
 * Script and the companion `Tado` library (Tado.gs). This file hosts, as a
 * single published Web App:
 *
 *   • the OAuth endpoints Google Home uses for account linking, and
 *   • the smart-home fulfillment webhook (SYNC / QUERY / EXECUTE / DISCONNECT).
 *
 * The Web App exposes exactly one doGet + one doPost. We disambiguate the
 * three logical endpoints (authorize / token / fulfillment) with a `?p=` query
 * parameter, and gate ALL of them with a secret `?k=` URL key (see SECURITY),
 * so you register three URLs in the Actions console that all point at the same
 * deployment:
 *
 *   Authorization URL : https://script.google.com/.../exec?p=auth&k=<KEY>
 *   Token URL         : https://script.google.com/.../exec?p=token&k=<KEY>
 *   Fulfillment URL   : https://script.google.com/.../exec?k=<KEY>
 *
 * DEVICE MAPPING (tado°X):
 *   • Each heating room  → THERMOSTAT (TemperatureSetting: off/heat, °C)
 *   • "Set Home"         → SWITCH (OnOff → presenceLock HOME; STATEFUL)
 *   • "Set Away"         → SWITCH (OnOff → presenceLock AWAY; STATEFUL)
 *   • "Boost Heating"    → SWITCH (OnOff → quickActions/boost; momentary)
 *   • "Resume Schedule"  → SWITCH (OnOff → quickActions/resumeSchedule; momentary)
 *   The four whole-home actions are SWITCHES (not SCENES) because the current
 *   Google Home app reliably surfaces switches as tiles, in the automation
 *   action picker, and by voice — whereas cloud SCENE devices often do not
 *   appear in the automations UI at all.
 *   Set Home / Set Away are STATEFUL and mutually exclusive: their on/off state
 *   reflects the real tado° presence (GET /homes/{id}/state → presence), so the
 *   tiles show the current HOME/AWAY status. Boost / Resume are momentary —
 *   turning them ON fires the action, and they always read back OFF.
 *
 * ---------------------------------------------------------------------------
 * SECURITY MODEL
 * ---------------------------------------------------------------------------
 * The Web App must be deployed "Anyone / anonymous" because Google's servers
 * call it without a Google identity — so the /exec URL itself is not a secret.
 * Access is gated INSIDE the code by two layers:
 *   1. ?k=<GH_URL_KEY>  — a 32-char secret embedded in every URL you register
 *      with Google. Read from e.parameter, which Apps Script populates
 *      reliably (unlike request headers). This is the PRIMARY gate: any request
 *      without the correct key is refused before touching tado°.
 *   2. Bearer <GH_LINK_TOKEN> — the OAuth token issued during account linking,
 *      checked best-effort on fulfillment (if present it must match; its
 *      absence is tolerated because e.headers is not guaranteed).
 * Anyone who learns the bare /exec URL still cannot read or control anything
 * without GH_URL_KEY. Treat the logged URLs (with ?k=) as secrets.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP
 * ---------------------------------------------------------------------------
 * 1. Put Tado.gs + this file + appsscript.json in one Apps Script project.
 * 2. Run authorizeTado() (below) ONCE so tado° tokens exist. It stores them in
 *    Script Properties — the same place this webhook reads them from.
 * 3. Run setupGoogleHomeAction() ONCE from the editor. It generates and stores,
 *    in Script Properties, the linking secrets and prints them to the log:
 *        GH_CLIENT_ID, GH_CLIENT_SECRET   (paste into the Actions console)
 *        GH_LINK_TOKEN                    (internal; the token we hand Google)
 *        GH_URL_KEY                       (the ?k= secret for every URL)
 *    It also caches your GH_HOME_ID (first home from /me) and logs the exact
 *    Fulfillment / Authorization / Token URLs to register (already ?k=-suffixed).
 * 4. Deploy → New deployment → Web app:
 *        Execute as: Me     Who has access: Anyone
 *    Copy the /exec URL.
 * 5. Google Home Developer Console → create a Cloud-to-cloud integration, using
 *    the three URLs printed by setupGoogleHomeAction() (each already carries
 *    ?k=<KEY>):
 *        Fulfillment URL = <exec URL>?k=<KEY>
 *        Account linking = OAuth / Authorization Code
 *          Client ID     = GH_CLIENT_ID
 *          Client secret = GH_CLIENT_SECRET
 *          Authorization URL = <exec URL>?p=auth&k=<KEY>
 *          Token URL         = <exec URL>?p=token&k=<KEY>
 *          Scopes            = (leave default / "control")
 * 6. In the Google Home app: add the [test] integration, link the account
 *    (single-user: linking auto-approves), and your rooms + scenes appear.
 *
 * CAVEATS
 *   • Apps Script Web Apps are slow to warm (~1–3 s); Google's fulfillment
 *     timeout is short, so the very first call after idle can occasionally
 *     time out — just retry. Fine for personal use, not production scale.
 *   • willReportState:false — Google POLLS the QUERY intent for fresh state.
 *     There is no proactive HomeGraph Report State (tado° can't push to us).
 *   • Single-user by design: only your Google account links; the "authorize"
 *     step auto-approves rather than showing a login page.
 */

// --- Script Property keys ---------------------------------------------------
var GH = {
  CLIENT_ID:     'GH_CLIENT_ID',
  CLIENT_SECRET: 'GH_CLIENT_SECRET',
  LINK_TOKEN:    'GH_LINK_TOKEN',      // opaque bearer we issue to Google
  URL_KEY:       'GH_URL_KEY',         // secret embedded in every registered URL (?k=)
  AUTH_CODE:     'GH_AUTH_CODE',       // one-shot code for the auth-code grant
  HOME_ID:       'GH_HOME_ID',
  AGENT_USER_ID: 'GH_AGENT_USER_ID'
};

var GH_TOKEN_TTL_SEC = 24 * 60 * 60;   // lifetime we advertise for our token

// ===========================================================================
// One-time tado° authorization
// ===========================================================================

/**
 * Run ONCE from the editor to authorize tado°.
 *
 * IMPORTANT: this deliberately uses tadoClient_() so the tado° tokens are
 * stored in the SAME place the fulfillment webhook reads them from
 * (Script Properties). Do NOT use a bare Tado.create() here — that would write
 * to User Properties, and the webhook (which runs unattended as the project
 * owner) would not find the tokens.
 *
 * Steps: run this, open the logged URL, log in to tado° and approve. The
 * function blocks and polls until you approve, then stores the tokens.
 */
function authorizeTado() {
  var t = tadoClient_();                       // -> Script Properties store
  var res = t.startDeviceAuthorization();
  Logger.log('Open this URL and log in to tado°, then approve access:');
  Logger.log(res.verification_uri_complete);
  t.pollForToken(res);                         // blocks until approved, then saves
  Logger.log('tado° authorized. Tokens stored in Script Properties.');
}

// ===========================================================================
// One-time setup helper
// ===========================================================================

/**
 * Run once from the editor (AFTER authorizeTado()). Generates linking secrets,
 * caches the home id, and logs the values you must paste into the Actions
 * console.
 */
function setupGoogleHomeAction() {
  var props = PropertiesService.getScriptProperties();

  if (!props.getProperty(GH.CLIENT_ID))     props.setProperty(GH.CLIENT_ID, 'gh-' + randomToken_(12));
  if (!props.getProperty(GH.CLIENT_SECRET)) props.setProperty(GH.CLIENT_SECRET, randomToken_(32));
  if (!props.getProperty(GH.LINK_TOKEN))    props.setProperty(GH.LINK_TOKEN, randomToken_(32));
  if (!props.getProperty(GH.URL_KEY))       props.setProperty(GH.URL_KEY, randomToken_(32));
  if (!props.getProperty(GH.AGENT_USER_ID)) props.setProperty(GH.AGENT_USER_ID, 'tado-' + randomToken_(8));

  // Resolve and cache the home id from tado°.
  var homeId = props.getProperty(GH.HOME_ID);
  if (!homeId) {
    var me = tadoClient_().getMe();
    if (!me || !me.homes || !me.homes.length) {
      throw new Error('Could not resolve a home from /me — is tado° authorized? Run authorizeTado() first.');
    }
    homeId = String(me.homes[0].id);
    props.setProperty(GH.HOME_ID, homeId);
  }

  var urlKey = props.getProperty(GH.URL_KEY);

  Logger.log('=== Google Home Action — paste these into the Actions console ===');
  Logger.log('Client ID     : ' + props.getProperty(GH.CLIENT_ID));
  Logger.log('Client secret : ' + props.getProperty(GH.CLIENT_SECRET));
  Logger.log('Home ID       : ' + homeId);
  Logger.log('agentUserId   : ' + props.getProperty(GH.AGENT_USER_ID));
  Logger.log('URL key (k)   : ' + urlKey);
  Logger.log('');
  Logger.log('Register these URLs (replace <EXEC> with your deployed /exec URL).');
  Logger.log('The ?k=<key> secret gates every request and does NOT rely on headers:');
  Logger.log('  Fulfillment URL   : <EXEC>?k=' + urlKey);
  Logger.log('  Authorization URL : <EXEC>?p=auth&k=' + urlKey);
  Logger.log('  Token URL         : <EXEC>?p=token&k=' + urlKey);
}

// ===========================================================================
// Web App entry points
// ===========================================================================

/**
 * doGet — only used for the OAuth *authorization* step (Google opens this in a
 * browser during account linking). Single-user: we auto-approve and redirect
 * straight back to Google with a one-shot auth code.
 */
function doGet(e) {
  var p = e && e.parameter ? e.parameter : {};
  // The ?k= URL secret gates the authorize endpoint. A plain visit with no
  // p=auth just shows a liveness message and never touches tado°.
  if (p.p === 'auth') {
    if (!validUrlKey_(p)) return htmlOut_('forbidden');
    return handleAuthorize_(p);
  }
  return htmlOut_('tado° × Google Home Action is running. Nothing to see here.');
}

/**
 * doPost — either the OAuth *token* exchange (p=token, form-encoded) or a
 * smart-home fulfillment intent (JSON body with inputs[].intent). Both require
 * the ?k= URL secret.
 */
function doPost(e) {
  var p = e && e.parameter ? e.parameter : {};
  if (!validUrlKey_(p)) {
    return jsonOut_({ error: 'forbidden' });
  }
  if (p.p === 'token') return handleToken_(e);
  return handleFulfillment_(e);
}

/**
 * Verify the ?k=<secret> URL parameter against GH_URL_KEY. This is the primary
 * gate: unlike request headers, e.parameter is reliably populated by Apps
 * Script, so Google's real calls (which carry the registered URL, key and all)
 * always pass, and anyone hitting the bare /exec URL without the key is blocked.
 */
function validUrlKey_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty(GH.URL_KEY);
  return !!expected && p && p.k === expected;
}

// ===========================================================================
// OAuth: authorization endpoint  (?p=auth)
// ===========================================================================

/**
 * Validates the client_id + redirect_uri, then 302-redirects back to Google's
 * redirect_uri with ?code=<one-shot>&state=<state>. No login UI (single-user).
 */
function handleAuthorize_(p) {
  var props = PropertiesService.getScriptProperties();

  if (p.client_id !== props.getProperty(GH.CLIENT_ID)) {
    return htmlOut_('invalid_client');
  }
  if (!p.redirect_uri) {
    return htmlOut_('missing redirect_uri');
  }
  // Google's redirect_uri is https://oauth-redirect.googleusercontent.com/r/<project>
  if (p.redirect_uri.indexOf('https://oauth-redirect.googleusercontent.com/') !== 0) {
    return htmlOut_('untrusted redirect_uri: ' + p.redirect_uri);
  }

  // Issue a fresh one-shot authorization code.
  var code = randomToken_(24);
  props.setProperty(GH.AUTH_CODE, code);

  var sep = p.redirect_uri.indexOf('?') === -1 ? '?' : '&';
  var target = p.redirect_uri + sep + 'code=' + encodeURIComponent(code) +
               (p.state ? '&state=' + encodeURIComponent(p.state) : '');

  // Apps Script cannot send a raw 302, so bounce via a meta-refresh page.
  return redirectHtml_(target);
}

// ===========================================================================
// OAuth: token endpoint  (?p=token)
// ===========================================================================

/**
 * Handles grant_type=authorization_code and grant_type=refresh_token.
 * Returns our Action's opaque access/refresh token (the SAME LINK_TOKEN both
 * times — this is a single-user gate, not a real token store).
 */
function handleToken_(e) {
  var props  = PropertiesService.getScriptProperties();
  var params = (e && e.parameter) ? e.parameter : {};

  // Authenticate the client (id/secret may arrive in the body).
  if (params.client_id && params.client_id !== props.getProperty(GH.CLIENT_ID)) {
    return jsonOut_({ error: 'invalid_client' });
  }
  if (params.client_secret && params.client_secret !== props.getProperty(GH.CLIENT_SECRET)) {
    return jsonOut_({ error: 'invalid_client' });
  }

  var grant = params.grant_type;

  if (grant === 'authorization_code') {
    var expected = props.getProperty(GH.AUTH_CODE);
    if (!expected || params.code !== expected) {
      return jsonOut_({ error: 'invalid_grant' });
    }
    props.deleteProperty(GH.AUTH_CODE);  // one-shot
  } else if (grant === 'refresh_token') {
    if (params.refresh_token !== props.getProperty(GH.LINK_TOKEN)) {
      return jsonOut_({ error: 'invalid_grant' });
    }
  } else {
    return jsonOut_({ error: 'unsupported_grant_type' });
  }

  var token = props.getProperty(GH.LINK_TOKEN);
  return jsonOut_({
    token_type:    'Bearer',
    access_token:  token,
    refresh_token: token,
    expires_in:    GH_TOKEN_TTL_SEC
  });
}

// ===========================================================================
// Smart-home fulfillment
// ===========================================================================

function handleFulfillment_(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: 'invalid_json' });
  }

  // Primary gate (?k= URL secret) already passed in doPost. The Bearer token
  // is checked best-effort below as defense in depth.
  if (!authorizedRequest_(e)) {
    return jsonOut_({
      requestId: body && body.requestId,
      payload: { errorCode: 'authFailure' }
    });
  }

  var input = (body.inputs && body.inputs[0]) || {};
  var intent = input.intent;
  var payload;

  try {
    switch (intent) {
      case 'action.devices.SYNC':       payload = onSync_();               break;
      case 'action.devices.QUERY':      payload = onQuery_(input.payload); break;
      case 'action.devices.EXECUTE':    payload = onExecute_(input.payload); break;
      case 'action.devices.DISCONNECT': payload = onDisconnect_();         break;
      default:
        return jsonOut_({ requestId: body.requestId, payload: { errorCode: 'notSupported' } });
    }
  } catch (err) {
    return jsonOut_({ requestId: body.requestId, payload: { errorCode: 'hardError', debugString: String(err) } });
  }

  return jsonOut_({ requestId: body.requestId, payload: payload });
}

/**
 * Best-effort Bearer-token check, as defense in depth behind the ?k= URL gate.
 *
 * Apps Script does NOT reliably expose request headers (e.headers is
 * undocumented), so we must NOT reject a request merely because no bearer is
 * present — that would drop Google's legitimate calls. Policy:
 *   - if a bearer token IS presented, it must match GH_LINK_TOKEN;
 *   - if none is presented, defer to the ?k= gate (already enforced) and allow.
 */
function authorizedRequest_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty(GH.LINK_TOKEN);
  if (!expected) return false;   // not set up yet — fail closed

  var auth = '';
  if (e && e.headers) {
    for (var k in e.headers) {
      if (k.toLowerCase() === 'authorization') { auth = e.headers[k]; break; }
    }
  }
  if (!auth && e && e.parameter && e.parameter.access_token) {
    auth = 'Bearer ' + e.parameter.access_token;   // convenience for local testing
  }

  if (!auth) return true;                    // no bearer seen -> rely on ?k= gate
  return auth === 'Bearer ' + expected;      // bearer seen -> it must be correct
}

// --- SYNC -------------------------------------------------------------------

function onSync_() {
  var props  = PropertiesService.getScriptProperties();
  var homeId = requireHomeId_();
  var rooms  = tadoClient_().getRooms(homeId) || [];

  var devices = [];

  console.log("onSync");
  Logger.log("onSync logger");

  // One THERMOSTAT per room.
  rooms.forEach(function (room) {
    var roomName = room.name || ('Room ' + room.id);
    devices.push({
      id:   deviceId_('room', homeId, room.id),
      type: 'action.devices.types.THERMOSTAT',
      traits: ['action.devices.traits.TemperatureSetting'],
      name: { name: roomName, defaultNames: ['tado ' + roomName], nicknames: [roomName] },
      willReportState: false,
      attributes: {
        availableThermostatModes: ['off', 'heat', 'cool', 'heatcool', 'auto', 'fan-only', 'purifier', 'dry', 'eco'],
        thermostatTemperatureUnit: 'C'
      },
      deviceInfo: { manufacturer: 'tado', model: 'tado-X-room' },
      roomHint: roomName
    });
  });

  // Whole-home actions modeled as SWITCH (OnOff) devices. Unlike SCENE devices,
  // switches reliably show as tiles, appear in the automation action picker,
  // and respond to voice in the current Google Home app.
  devices.push(switchDevice_('home',   homeId, 'Set Home'));
  devices.push(switchDevice_('away',   homeId, 'Set Away'));
  devices.push(switchDevice_('boost',  homeId, 'Boost Heating'));
  devices.push(switchDevice_('resume', homeId, 'Resume Schedule'));

  props.setProperty('GH_DEVICES', JSON.stringify(devices));
  
  return {
    agentUserId: props.getProperty(GH.AGENT_USER_ID) || ('tado-' + homeId),
    devices: devices
  };
}

function switchDevice_(kind, homeId, name) {
  return {
    id:   deviceId_(kind, homeId),
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
    name: { name: name, defaultNames: ['tado ' + name], nicknames: [name] },
    willReportState: false,
    attributes: {},
    deviceInfo: { manufacturer: 'tado', model: 'tado-X-action' }
  };
}

// --- QUERY ------------------------------------------------------------------

function onQuery_(payload) {
  var homeId = requireHomeId_();
  var wanted = (payload && payload.devices) || [];
  var tado   = tadoClient_();

  console.log("onQuerry");
  Logger.log("onQuery logger");

  // One rooms call, indexed by room id, reused for every requested device.
  var roomsById = indexRoomsById_(tado.getRooms(homeId) || []);

  // Home presence is fetched lazily and only once — a QUERY that asks about
  // rooms only should not incur an extra /state call.
  var presence = null, presenceFetched = false;
  function currentPresence_() {
    if (!presenceFetched) {
      presenceFetched = true;
      try {
        var st = tado.getHomeState(homeId);
        presence = st && st.presence;   // 'HOME' | 'AWAY'
      } catch (e) { presence = null; }
    }
    return presence;
  }

  var out = {};
  wanted.forEach(function (d) {
    var parsed = parseDeviceId_(d.id);
    if (parsed.kind === 'room') {
      var room = roomsById[parsed.roomId];
      out[d.id] = room ? roomToQueryState_(room) : { online: false, status: 'ERROR', errorCode: 'deviceNotFound' };
    } else if (parsed.kind === 'home' || parsed.kind === 'away') {
      // Stateful presence switches: reflect the real tado° presence, mutually
      // exclusive. If presence is unknown, fall back to off.
      var p = currentPresence_();
      var isOn = (parsed.kind === 'home') ? (p === 'HOME') : (p === 'AWAY');
      out[d.id] = { online: true, status: 'SUCCESS', on: isOn };
    } else {
      // boost / resume are momentary actions with no persistent state.
      out[d.id] = { online: true, status: 'SUCCESS', on: false };
    }
  });

  return { devices: out };
}

/** Map a tado°X room object to a Google TemperatureSetting state block. */
function roomToQueryState_(room, onExec = false) {
  var sensor  = room.sensorDataPoints || {};
  var setting = room.setting || {};
  var isOn    = setting.power === 'ON';
  
  var state = onExec ? {} : {
    online: true,
    status: 'SUCCESS'
  };
  state.thermostatMode = isOn ? 'heat' : 'off';
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
  return state;
}

// --- EXECUTE ----------------------------------------------------------------

function onExecute_(payload) {
  var homeId  = requireHomeId_();
  var tado    = tadoClient_();
  var commands = (payload && payload.commands) || [];

  console.log("onExecute");
  Logger.log("onExecute logger");
  
  // Accumulate results keyed by a status → ids grouping (Google's format).
  var results = [];

  commands.forEach(function (command) {
    var devices    = command.devices || [];
    var executions = command.execution || [];

    devices.forEach(function (dev) {
      var parsed = parseDeviceId_(dev.id);
      executions.forEach(function (exec) {
        try {
          var states = runExecution_(tado, homeId, parsed, exec);
          results.push({ ids: [dev.id], status: 'SUCCESS', states: states });
        } catch (err) {
          results.push({
            ids: [dev.id],
            status: 'ERROR',
            errorCode: 'hardError',
            debugString: String(err)
          });
        }
      });
    });
  });

  return { commands: results };
}

/**
 * Execute one command against tado°, returning the reported states for the
 * Google response.
 */
function runExecution_(tado, homeId, parsed, exec) {
  var cmd    = exec.command;
  var params = exec.params || {};

  // --- Thermostat rooms ---
  if (parsed.kind === 'room') {
    if (cmd === 'action.devices.commands.ThermostatTemperatureSetpoint') {
      var celsius = clampTemp_(params.thermostatTemperatureSetpoint);
      tado.setRoomTemperature(homeId, parsed.roomId, celsius, { type: 'MANUAL' });
      return { thermostatMode: 'heat', thermostatTemperatureSetpoint: celsius };
    }
    if (cmd === 'action.devices.commands.ThermostatSetMode') {
      var mode = params.thermostatMode;
      if (mode === 'off') {
        tado.turnRoomOff(homeId, parsed.roomId, { type: 'MANUAL' });
        return { thermostatMode: 'off' };
      }
      // 'heat' (or 'on'): resume schedule for just this room by clearing the
      // manual overlay via NEXT_TIME_BLOCK so tado°'s schedule takes over.
      // We can't set a temperature without a target, so re-apply the current
      // scheduled setting by reading the room back.
      var room = indexRoomsById_(tado.getRooms(homeId) || [])[parsed.roomId] || {};
      if (mode === 'eco' && room) {
        return roomToQueryState_(room, true);
      }
      var target = (room.setting && room.setting.temperature && room.setting.temperature.value) || 21;
      tado.setRoomTemperature(homeId, parsed.roomId, target, { type: 'MANUAL' });
      return { thermostatMode: 'heat', thermostatTemperatureSetpoint: target };
    }
    throw new Error('Unsupported thermostat command: ' + cmd);
  }

  // --- Whole-home switches (OnOff) ---
  if (cmd === 'action.devices.commands.OnOff') {
    var on = params.on === true;
    // These are momentary actions. Turning the switch ON performs the action;
    // turning it OFF is a no-op (there is nothing to "un-boost" cleanly, and
    // Home/Away are set via their own switches). We always echo back the
    // requested on-state so Google shows the toggle as accepted.
    if (on) {
      switch (parsed.kind) {
        case 'home':   tado.setPresence(homeId, 'HOME'); break;
        case 'away':   tado.setPresence(homeId, 'AWAY'); break;
        case 'boost':  tado.setBoost(homeId);            break;
        case 'resume': tado.resumeSchedule(homeId);      break;
        default: throw new Error('Unknown switch: ' + parsed.kind);
      }
    }
    return { on: on };
  }

  throw new Error('Unsupported command ' + cmd + ' for device kind ' + parsed.kind);
}

// --- DISCONNECT -------------------------------------------------------------

function onDisconnect_() {
  // Per Google's contract, revoke linking and return an empty object.
  // We rotate the link token so the old grant no longer authenticates.
  PropertiesService.getScriptProperties().setProperty(GH.LINK_TOKEN, randomToken_(32));
  return {};
}

// ===========================================================================
// Device id encoding
// ===========================================================================
// Format:  room-<homeId>-<roomId>   for thermostats
//          <kind>-<homeId>          for whole-home switches (home/away/boost/resume)

function deviceId_(kind, homeId, roomId) {
  var id = kind + '-' + homeId;
  if (roomId !== undefined && roomId !== null && roomId !== '') {
    id += '-' + roomId;
  }
  return id;
}

function parseDeviceId_(id) {
  var parts = String(id).split('-');
  return { kind: parts[0], homeId: parts[1], roomId: parts.length > 2 ? parts[2] : undefined };
}

// ===========================================================================
// Small helpers
// ===========================================================================

function tadoClient_() {
  // Store tado° tokens in Script Properties so the Web App (executed as the
  // owner) shares them regardless of who triggers a request.
  return Tado.create({ store: PropertiesService.getScriptProperties() });
}

function requireHomeId_() {
  var id = PropertiesService.getScriptProperties().getProperty(GH.HOME_ID);
  if (!id) throw new Error('GH_HOME_ID not set — run setupGoogleHomeAction() first.');
  return id;
}

function indexRoomsById_(rooms) {
  var map = {};
  rooms.forEach(function (r) { map[String(r.id)] = r; });
  return map;
}

/** Clamp a requested setpoint into tado°'s supported heating range. */
function clampTemp_(celsius) {
  var c = Number(celsius);
  if (isNaN(c)) c = 21;
  if (c < 5)  c = 5;
  if (c > 25) c = 25;
  return Math.round(c * 10) / 10;   // tado° accepts 0.1° steps
}

/** Generate a random hex-ish token of the given length from UUIDs. */
function randomToken_(len) {
  var s = '';
  while (s.length < len) {
    s += Utilities.getUuid().replace(/-/g, '');
  }
  return s.slice(0, len);
}

// --- Output builders --------------------------------------------------------

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function htmlOut_(msg) {
  return HtmlService.createHtmlOutput('<p>' + msg + '</p>');
}

/**
 * Redirect the browser to `url`.
 *
 * Apps Script serves HtmlService output from a SANDBOXED iframe on
 * *.googleusercontent.com. A plain `location.replace()` / `<meta refresh>`
 * only navigates that inner sandbox frame, and a cross-origin navigation from
 * inside it (to Google's oauth-redirect host) is blocked — the page just hangs
 * on the /exec?p=auth URL. Navigating `window.top.location` instead moves the
 * real top-level browser window, which CAN go cross-origin, so account linking
 * completes. The visible link uses target="_top" as a manual fallback.
 */
function redirectHtml_(url) {
  var forAttr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');   // safe in href
  var forJs   = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');      // safe in JS string
  return HtmlService
    .createHtmlOutput(
      '<!doctype html><html><body>' +
      '<script>window.top.location.href = "' + forJs + '";</script>' +
      '<p>Redirecting… If nothing happens, ' +
      '<a href="' + forAttr + '" target="_top">tap here to continue</a>.</p>' +
      '</body></html>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===========================================================================
// Test harness — run these from the editor to validate without Google Home.
// ===========================================================================

/** Logs the SYNC payload (real getRooms call). */
function test_sync() {
  Logger.log(JSON.stringify(onSync_(), null, 2));
}

/** Logs QUERY for every room the SYNC would expose. */
function test_query() {
  var sync = onSync_();
  var devices = sync.devices
    .filter(function (d) { return d.type === 'action.devices.types.THERMOSTAT'; })
    .map(function (d) { return { id: d.id }; });
  Logger.log(JSON.stringify(onQuery_({ devices: devices }), null, 2));
}

/**
 * Sets the FIRST room to 21°C via the EXECUTE path (this WRITES to tado°),
 * then logs the result. Comment out if you don't want a live change.
 */
function test_executeSetpoint() {
  var homeId = requireHomeId_();
  var rooms  = tadoClient_().getRooms(homeId) || [];
  if (!rooms.length) { Logger.log('No rooms.'); return; }
  var id = deviceId_('room', homeId, rooms[0].id);
  var res = onExecute_({
    commands: [{
      devices: [{ id: id }],
      execution: [{
        command: 'action.devices.commands.ThermostatTemperatureSetpoint',
        params: { thermostatTemperatureSetpoint: 21 }
      }]
    }]
  });
  Logger.log(JSON.stringify(res, null, 2));
}
