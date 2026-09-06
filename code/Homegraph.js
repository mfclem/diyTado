/**
 * Homegraph.js — HomeGraph API client (service-account JWT auth)
 * ==============================================================================
 *
 * PURPOSE
 * -------
 * Low-level wrapper around the Google HomeGraph REST API. Handles service-account
 * JWT authentication (no external library) and exposes the five HomeGraph operations
 * used by this project:
 *
 *   • apiReportStateAndNotification(statesAndNotifications)
 *       Push device state to HomeGraph. Called by Reporting.js / reportState().
 *       Accepts the statesAndNotifications object built by generateStatesAndNotifications_().
 *
 *   • apiRequestSync()
 *       Ask Google to re-run SYNC — use after rooms are added/removed in tado°,
 *       or after any deployment that changes the device list.
 *
 *   • apiSync()       — query HomeGraph for the current SYNC device list.
 *   • apiQuery()      — query HomeGraph for the current device states.
 *   • apiDeleteAgentUser() — unlink the user from the smart home Action.
 *
 * This file contains NO tado° API calls and NO device state logic — those live
 * in Reporting.js (generateStatesAndNotifications_, computeAirComfort_).
 *
 * PREREQUISITES — Script Properties (set via Project Settings → Properties)
 * --------------------------------------------------------------------------
 *   SERVICE_ACCOUNT_EMAIL
 *       E-mail of the GCP service account granted the HomeGraph API scope
 *       (https://www.googleapis.com/auth/homegraph).
 *       Example: my-sa@my-project.iam.gserviceaccount.com
 *
 *   SERVICE_ACCOUNT_PRIVATE_KEY
 *       RSA private key from the service account JSON key file.
 *       Paste the full "-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----"
 *       block with literal \n for newlines (Apps Script stores it as one line).
 *       The code replaces \n → real newlines before use.
 *
 *   GH_AGENT_USER_ID  (written by setupGoogleHomeAction() in GoogleHomeAction.js)
 *       Opaque string identifying this user to the HomeGraph API. Must match the
 *       agentUserId used in the SYNC response.
 *
 * SETUP CHECKLIST
 * ---------------
 * 1. Enable the HomeGraph API in your GCP project.
 * 2. Create a Service Account, download a JSON key, copy e-mail and private key
 *    into the Script Properties above.
 * 3. Grant the service account the "Home Graph Service Agent" role (or at minimum
 *    homegraph.devices.reportStateAndNotification).
 * 4. Run setupGoogleHomeAction() in GoogleHomeAction.js so GH_AGENT_USER_ID is set.
 * 5. Set up the reporting trigger — see Reporting.js for details.
 */

/** Service account credentials loaded from Script Properties. */
const SERVICE_ACCOUNT_EMAIL = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_EMAIL');
const SERVICE_ACCOUNT_PRIVATE_KEY = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');
const AGENT_USER_ID = PropertiesService.getScriptProperties().getProperty(GH.AGENT_USER_ID);

/**
 * Generate an OAuth2 access token using a service-account JWT, without any
 * external library. Uses native RSA-SHA256 signing and Apps Script CacheService
 * to avoid redundant token requests.
 */
function getHomeGraphApiAccessToken_() {
  // 1. Return the cached token if still valid.
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get("HOMEGRAPH_TOKEN");
  if (cachedToken) {
    return cachedToken;
  }

  // 2. Build the JWT header and claim set.
  const now = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const claimSet = JSON.stringify({
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/homegraph",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, // valid for 1 hour
    iat: now
  });

  // Base64URL encode (strip trailing '=' padding).
  const base64UrlEncode = (str) => {
    return Utilities.base64EncodeWebSafe(str).replace(/=+$/, '');
  };

  const toSign = base64UrlEncode(header) + "." + base64UrlEncode(claimSet);

  // 3. Sign with the service-account private key (RSA-SHA256).
  const signatureBytes = Utilities.computeRsaSha256Signature(toSign, SERVICE_ACCOUNT_PRIVATE_KEY);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  const jwt = toSign + "." + signature;

  // 4. Exchange the JWT for a Google OAuth2 access token.
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
    // Cache for 55 minutes (3300 seconds) — tokens are valid for 1 hour.
    cache.put("HOMEGRAPH_TOKEN", json.access_token, 3300);
    return json.access_token;
  } else {
    throw new Error("Failed to obtain HomeGraph access token: " + response.getContentText());
  }
}

/**
 * Execute an authenticated HTTP request against the HomeGraph API.
 */
function callHomeGraphApi(endpoint, method, payload) {
  let token;
  try {
    token = getHomeGraphApiAccessToken_();
  } catch (e) {
    console.log("HomeGraph authentication error: " + e.message);
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
    console.log('--- HomeGraph call: ' + endpoint + ' ---');
    console.log('HTTP status: ' + response.getResponseCode());
    console.log('Response: ' + response.getContentText());
    return JSON.parse(response.getContentText());
  } catch (e) {
    console.error('HomeGraph request failed: ' + e.toString());
    return null;
  }
}

/**
 * HomeGraph API operations
 * ========================
 */

/**
 * Requests Google to send an action.devices.SYNC intent to the smart home Action to update device metadata for the given user.
 */
function apiRequestSync() {
  return callHomeGraphApi('devices:requestSync', 'post', {
    agentUserId: AGENT_USER_ID,
    async: false
  });
}

/**
 * Reports device state and optionally sends device notifications.
 */
function apiReportStateAndNotification(statesAndNotifications) {
  return callHomeGraphApi('devices:reportStateAndNotification', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    payload: {
      devices: statesAndNotifications
    }
  });
}

/**
 * Gets all the devices associated with the given third-party user.
 */
function apiSync() {
  return callHomeGraphApi('devices:sync', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID
  });
}

/**
 * Gets the current states in Home Graph for the given set of the third-party user's devices.
 */
function apiQuery() {
  return callHomeGraphApi('devices:query', 'post', {
    requestId: Utilities.getUuid(),
    agentUserId: AGENT_USER_ID,
    inputs: [{
      payload: {
        devices: getSyncDevicesIds_()
      }
    }]
  });
}

/**
 * Unlinks the given third-party user from your smart home Action.
 */
function apiDeleteAgentUser() {
  return callHomeGraphApi('agentUsers/' + encodeURIComponent(AGENT_USER_ID), 'delete', null);
}



/**
 * Content functions
 */
function getSyncDevicesIds_() {
  var sync = apiSync();
  var devices = (sync && sync.payload && sync.payload.devices) || [];
  var devicesIds = [];
  devices.forEach(function (d) {
    if (d.id) devicesIds.push({id: d.id});
  });
  //console.log("Devices Ids:" + JSON.stringify(devicesIds, null, 2));
  return devicesIds;
}
