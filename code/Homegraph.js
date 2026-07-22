/**
 * PARAMÈTRES DU COMPTE DE SERVICE
 */
const SERVICE_ACCOUNT_EMAIL = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_EMAIL');
const PRIVATE_KEY = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');
const AGENT_USER_ID = PropertiesService.getScriptProperties().getProperty('GH_AGENT_USER_ID');
const HOME_ID = PropertiesService.getScriptProperties().getProperty('GH_HOME_ID');


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
  const signatureBytes = Utilities.computeRsaSha256Signature(toSign, PRIVATE_KEY);
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
 * EXEMPLES D'EXÉCUTION DE L'API HOME GRAPH
 * ==========================================
 */

function apiRequestSync() {
  callHomeGraphApi('devices:requestSync', 'post', {
    agentUserId: AGENT_USER_ID,
    async: false
  });
}

function apiReportState() {
  callHomeGraphApi('devices:reportStateAndNotification', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    payload: {
      devices: {
        states: {
          "id_de_votre_appareil": { 
            "on": true,
            "online": true
          }
        }
      }
    }
  });
}

function apiSync() {
  callHomeGraphApi('devices:sync', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID
  });
}

function apiQuery() {
  callHomeGraphApi('devices:query', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    inputs: [{
      payload: {
        devices: [{ id: "id_de_votre_appareil" }]
      }
    }]
  });
}

function apiDeleteAgentUser() {
  const endpoint = 'agentUsers/' + encodeURIComponent(AGENT_USER_ID);
  callHomeGraphApi(endpoint, 'delete', null);
}


/**
 * Génère le payload brut pour le Report State de Homegraph à partir des appareils Tado.
 * 
 * @param {string} agentUserId - L'identifiant unique de l'utilisateur dans votre système.
 * @return {Object} L'objet JavaScript représentant le payload complet.
 */
function generateTadoReportStatePayload() {
  // Initialiser le client Tado (utilise les tokens stockés)
  var t = Tado.create();
  
  var homeId = HOME_ID;
  
  // Récupérer l'état des pièces via l'API Tado°X
  var rooms = t.getRooms(homeId);
  var states = {};
  
  // Parcourir chaque pièce et construire l'objet "states"
  rooms.forEach(function(room) {
    var deviceId = room.id.toString(); 
    
    var mode = "off";
    var ambientTemp = 20.0;
    var setpointTemp = 20.0;
    var humidity = 50.0;
    
    // Récupération des données des capteurs (Température ambiante et Humidité)
    if (room.sensorData) {
      if (room.sensorData.temperature) {
        ambientTemp = room.sensorData.temperature.celsius || room.sensorData.temperature.value || ambientTemp;
      }
      if (room.sensorData.humidity) {
        humidity = room.sensorData.humidity.percentage || room.sensorData.humidity.value || humidity;
      }
    }
    
    // Récupération des réglages (Mode et Consigne)
    if (room.setting) {
      if (room.setting.power === "ON") {
        mode = "heat";
        if (room.setting.temperature) {
          setpointTemp = room.setting.temperature.celsius || room.setting.temperature.value || ambientTemp;
        }
      } else {
        mode = "off";
      }
    }
    
    // Construction de l'état pour l'appareil courant
    states[deviceId] = {
      "online": true,
      "thermostatMode": mode,
      "thermostatTemperatureAmbient": parseFloat(ambientTemp.toFixed(1)),
      "thermostatHumidityAmbient": parseFloat(humidity.toFixed(1))
    };
    
    // Ajouter la consigne uniquement si le chauffage est actif
    if (mode === "heat") {
      states[deviceId]["thermostatTemperatureSetpoint"] = parseFloat(setpointTemp.toFixed(1));
    }
  });

  // Assembler et retourner le payload final

  var payload = {
    "requestId": Utilities.getUuid(),
    "agentUserId": AGENT_USER_ID,
    "payload": {
      "devices": {
        "states": states
      }
    }
  };

  Logger.log("Report state payload: " + JSON.stringify(payload));

  return payload;
}


function newGenerateTadoReportStatePayload() {
  var homeId = HOME_ID;
  var devices = JSON.parse(PropertiesService.getScriptProperties().getProperty('GH_DEVICES') || "{}");
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
  }
  
  // Assembler et retourner le payload final

  var payload = {
    "requestId": Utilities.getUuid(),
    "agentUserId": AGENT_USER_ID,
    "payload": {
      "devices": {
        "states": states
      }
    }
  };

  Logger.log("Report new state payload: " + JSON.stringify(payload));

  return payload;
}
