/**
 * PARAMÈTRES DU COMPTE DE SERVICE
 */
const SERVICE_ACCOUNT_EMAIL = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_EMAIL');
const SERVICE_ACCOUNT_PRIVATE_KEY = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');
const AGENT_USER_ID = PropertiesService.getScriptProperties().getProperty(GH.AGENT_USER_ID);

/**
 * Génère un jeton d'accès OAuth2 (Access Token) sans aucune bibliothèque externe.
 * Utilise la signature native RSA-SHA256 et le système de cache de GAS pour les performances.
 */
function getAccessToken() {
  // 1. Vérifier si un jeton est déjà en cache pour éviter des requêtes inutiles
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get("HOMEGRAPH_TOKEN");
  if (cachedToken) {
    return cachedToken;
  }

  // 2. Création des en-têtes et des requêtes JWT
  const now = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const claimSet = JSON.stringify({
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/homegraph",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, // Valide 1 heure
    iat: now
  });

  // Fonction utilitaire pour encoder en Base64URL (sans '=' à la fin)
  const base64UrlEncode = (str) => {
    return Utilities.base64EncodeWebSafe(str).replace(/=+$/, '');
  };

  const toSign = base64UrlEncode(header) + "." + base64UrlEncode(claimSet);

  // 3. Signature RSA-SHA256 de la clé privée
  const signatureBytes = Utilities.computeRsaSha256Signature(toSign, SERVICE_ACCOUNT_PRIVATE_KEY);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  const jwt = toSign + "." + signature;

  // 4. Échange du JWT contre un Jeton d'accès (Access Token) auprès de Google
  const options = {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", options);
  const json = JSON.parse(response.getContentText());

  if (json.access_token) {
    // Mettre en cache pour 55 minutes (3300 secondes)
    cache.put("HOMEGRAPH_TOKEN", json.access_token, 3300);
    return json.access_token;
  } else {
    throw new Error("Erreur lors de l'obtention du token : " + response.getContentText());
  }
}

/**
 * Fonction utilitaire principale pour exécuter les requêtes HTTP vers Home Graph
 */
function callHomeGraphApi(endpoint, method, payload) {
  let token;
  try {
    token = getAccessToken();
  } catch (e) {
    Logger.log("Erreur d'authentification : " + e.message);
    return null;
  }

  const url = 'https://homegraph.googleapis.com/v1/' + endpoint;
  const options = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  try {
    const response = UrlFetchApp.fetch(url, options);
    Logger.log('--- Appel à : ' + endpoint + ' ---');
    Logger.log('Code HTTP : ' + response.getResponseCode());
    Logger.log('Réponse : ' + response.getContentText());
    return JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log('Erreur d\'exécution : ' + e.toString());
    return null;
  }
}

/**
 * ==========================================
 * EXÉCUTIONS DE L'API HOME GRAPH
 * ==========================================
 */

function apiRequestSync() {
  return callHomeGraphApi('devices:requestSync', 'post', {
    agentUserId: AGENT_USER_ID,
    async: false
  });
}

function apiReportStateAndNotification() {
  return callHomeGraphApi('devices:reportStateAndNotification', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    payload: {
      devices: generateStatesAndNotifications(getSyncDevicesIds())
    }
  });
}

function apiSync() {
  return callHomeGraphApi('devices:sync', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID
  });
}

function apiQuery() {
  return callHomeGraphApi('devices:query', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    inputs: [{
      payload: {
        devices: getSyncDevicesIds()
      }
    }]
  });
}

function apiDeleteAgentUser() {
  return callHomeGraphApi('agentUsers/' + encodeURIComponent(AGENT_USER_ID), 'delete', null);
}

/* Content functions */

function getSyncDevicesIds() {
  var sync = apiSync();
  var devices = (sync && sync.payload && sync.payload.devices) || [];
  var devicesIds = [];
  devices.forEach(function (d) {
    if (d.id) devicesIds.push({id: d.id});
  });
  Logger.log("Devices Ids:" + JSON.stringify(devicesIds, null, 2));
  return devicesIds;
}

function generateStatesAndNotifications(devices) {
  var homeId = requireHomeId_();
  var tado = tadoClient_();
  // One rooms call, indexed by room id, reused for every requested device.
  var roomsById = indexRoomsById_(tado.getRooms(homeId) || []);
  var states = {};
  devices.forEach(function (d) {
    var parsed = parseDeviceId_(d.id);
    if (parsed.kind === 'room') {
      var room = roomsById[parsed.roomId];
      if (room) {
        var sensor  = room.sensorDataPoints || {};
        var setting = room.setting || {};
        var isOn    = setting.power === 'ON';
  
        var state = {
          online: true,
          thermostatMode: (isOn ? 'heat' : 'off')
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
    }
  });
  var statesAndNotifications = {
    states: states
  };
  Logger.log("States and Notifications: " + JSON.stringify(statesAndNotifications, nill, 2));
  return statesAndNotifications;
}
