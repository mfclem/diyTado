/**
 * TadoX API Library for Google Apps Script
 * ==========================================
 *
 * A single-file library exposing everything needed to authenticate with, and
 * consume, the tado° / tado°X REST API from Google Apps Script.
 *
 * Authentication uses the OAuth 2.0 **device code grant** flow (tado° migrated
 * to this from the deprecated password grant).
 *   Auth docs:  https://support.tado.com/en/articles/8565472
 *   Endpoints:  https://github.com/gedhi/tadox-postman-collection
 *
 * The API spans three hosts, all reached with the same bearer token:
 *   - https://login.tado.com/oauth2   — OAuth device flow / token endpoints
 *   - https://my.tado.com/api/v2      — classic v2 API (me, homes, devices...)
 *   - https://hops.tado.com           — tado°X API (rooms, features, control)
 *
 * ---------------------------------------------------------------------------
 * QUICK START
 * ---------------------------------------------------------------------------
 *
 * 1) One-time interactive authorization (run once from the editor / a menu):
 *
 *      function authorizeTado() {
 *        var t = Tado.create();
 *        var res = t.startDeviceAuthorization();
 *        Logger.log('Open and log in: ' + res.verification_uri_complete);
 *        t.pollForToken(res);   // blocks until you approve, then stores tokens
 *      }
 *
 *    NOTE: Tado.create() with no options stores tokens in UserProperties. If
 *    you are using this library from an unattended context (e.g. a published
 *    Web App that runs as the project owner), authorize against the SAME store
 *    the consumer reads from — typically Script Properties:
 *
 *      Tado.create({ store: PropertiesService.getScriptProperties() })
 *
 *    Otherwise the consumer will look in Script Properties, find no tokens, and
 *    throw "Not authorized".
 *
 * 2) Afterwards tokens are persisted (in the chosen store) and auto-refreshed:
 *
 *      function readRooms() {
 *        var t = Tado.create();
 *        var homeId = t.getMe().homes[0].id;
 *        Logger.log(t.getRooms(homeId));
 *      }
 *
 * ---------------------------------------------------------------------------
 * NOTES
 * ---------------------------------------------------------------------------
 *  - Access tokens live ~10 min; refresh tokens up to 30 days WITH ROTATION
 *    (each refresh returns a new refresh token and revokes the old one — this
 *    library always persists the newest one).
 *  - The hops.tado.com (tado°X) endpoints require `ngsw-bypass=true`; this
 *    library adds it automatically.
 *  - No external dependencies.
 */

var Tado = (function () {
  'use strict';

  // --- Constants -----------------------------------------------------------

  var CLIENT_ID       = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
  var DEVICE_AUTH_URL = 'https://login.tado.com/oauth2/device_authorize';
  var TOKEN_URL       = 'https://login.tado.com/oauth2/token';
  var DEVICE_GRANT    = 'urn:ietf:params:oauth:grant-type:device_code';

  var API_V2_BASE     = 'https://my.tado.com/api/v2';  // classic v2 API
  var HOPS_BASE       = 'https://hops.tado.com';        // tado°X API

  var PROP_KEY        = 'TADO_TOKENS';   // storage key for the token bundle
  var EXPIRY_SKEW_MS  = 30 * 1000;       // refresh slightly early

  // -------------------------------------------------------------------------
  // Client
  // -------------------------------------------------------------------------

  /**
   * @param {Object=} options
   * @param {PropertiesService.Properties=} options.store  Where to persist
   *        tokens. Defaults to UserProperties. Pass ScriptProperties to share
   *        across users, or any custom Properties object.
   * @param {string=} options.clientId  Override the default client id.
   * @constructor
   */
  function TadoClient(options) {
    options = options || {};
    this.store    = options.store || PropertiesService.getUserProperties();
    this.clientId = options.clientId || CLIENT_ID;
  }

  // =========================================================================
  // OAuth: Device Code Flow
  // =========================================================================

  /**
   * Step 1 — begin device authorization. Returns the device/user codes and the
   * URL the user must visit to approve access.
   *
   * @param {string=} scope  Space-separated scopes. Defaults to
   *        'offline_access' so a refresh token is issued.
   * @return {{device_code:string, user_code:string, verification_uri:string,
   *           verification_uri_complete:string, expires_in:number,
   *           interval:number}}
   */
  TadoClient.prototype.startDeviceAuthorization = function (scope) {
    scope = (scope === undefined) ? 'offline_access' : scope;
    var payload = { client_id: this.clientId };
    if (scope) payload.scope = scope;

    var resp = UrlFetchApp.fetch(DEVICE_AUTH_URL, {
      method: 'post',
      payload: payload,               // form-encoded
      muteHttpExceptions: true
    });
    return parseJsonOrThrow_(resp, 'device authorization');
  };

  /**
   * Step 2 — poll the token endpoint until the user approves in the browser,
   * then persist the resulting tokens. Blocks (Utilities.sleep) up to the
   * device code's expiry.
   *
   * @param {Object} deviceAuth  The object returned by startDeviceAuthorization.
   * @return {Object} The stored token bundle.
   */
  TadoClient.prototype.pollForToken = function (deviceAuth) {
    if (!deviceAuth || !deviceAuth.device_code) {
      throw new Error('pollForToken requires the result of startDeviceAuthorization().');
    }
    var intervalMs = (deviceAuth.interval || 5) * 1000;
    var deadline   = nowMs_() + ((deviceAuth.expires_in || 300) * 1000);

    while (nowMs_() < deadline) {
      Utilities.sleep(intervalMs);

      var resp = UrlFetchApp.fetch(TOKEN_URL, {
        method: 'post',
        payload: {
          client_id:   this.clientId,
          device_code: deviceAuth.device_code,
          grant_type:  DEVICE_GRANT
        },
        muteHttpExceptions: true
      });

      var code = resp.getResponseCode();
      var body = safeJson_(resp.getContentText());

      if (code === 200) {
        return this.saveTokens_(body);
      }

      // 'authorization_pending' / 'slow_down' are expected until the user
      // approves; RFC 8628 says to keep (or slow) polling.
      var err = body && body.error;
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') { intervalMs += 5000; continue; }

      throw new Error('Device token exchange failed: ' + (err || code) +
                      ' — ' + resp.getContentText());
    }
    throw new Error('Device authorization timed out before the user approved access.');
  };

  /**
   * Exchange a refresh token for a new access token (with rotation). Usually
   * called automatically; exposed for manual use/testing.
   *
   * @param {string=} refreshToken  Defaults to the stored refresh token.
   * @return {Object} The refreshed, stored token bundle.
   */
  TadoClient.prototype.refresh = function (refreshToken) {
    var tokens = this.loadTokens_();
    refreshToken = refreshToken || (tokens && tokens.refresh_token);
    if (!refreshToken) {
      throw new Error('No refresh token available. Run the device authorization flow first.');
    }

    var resp = UrlFetchApp.fetch(TOKEN_URL, {
      method: 'post',
      payload: {
        client_id:     this.clientId,
        grant_type:    'refresh_token',
        refresh_token: refreshToken
      },
      muteHttpExceptions: true
    });
    return this.saveTokens_(parseJsonOrThrow_(resp, 'token refresh'));
  };

  // =========================================================================
  // Token storage / access
  // =========================================================================

  /** @return {boolean} Whether valid (or refreshable) credentials exist. */
  TadoClient.prototype.isAuthorized = function () {
    var t = this.loadTokens_();
    return !!(t && (t.refresh_token || (t.access_token && t.expires_at > nowMs_())));
  };

  /** Remove all stored tokens (log out). */
  TadoClient.prototype.reset = function () {
    this.store.deleteProperty(PROP_KEY);
  };

  /**
   * Return a currently-valid access token, refreshing if necessary.
   * @return {string}
   */
  TadoClient.prototype.getAccessToken = function () {
    var tokens = this.loadTokens_();
    if (!tokens || !tokens.access_token) {
      throw new Error('Not authorized. Run startDeviceAuthorization() + pollForToken() first.');
    }
    if (nowMs_() >= (tokens.expires_at - EXPIRY_SKEW_MS)) {
      tokens = this.refresh(tokens.refresh_token);
    }
    return tokens.access_token;
  };

  /** @private Persist a token response, computing an absolute expiry. */
  TadoClient.prototype.saveTokens_ = function (tokenResponse) {
    if (!tokenResponse || !tokenResponse.access_token) {
      throw new Error('Token endpoint returned no access_token: ' +
                      JSON.stringify(tokenResponse));
    }
    var existing = this.loadTokens_() || {};
    var bundle = {
      access_token:  tokenResponse.access_token,
      // Rotation: keep the freshest refresh token, fall back to the old one.
      refresh_token: tokenResponse.refresh_token || existing.refresh_token,
      token_type:    tokenResponse.token_type || 'bearer',
      scope:         tokenResponse.scope || existing.scope,
      expires_at:    nowMs_() + ((tokenResponse.expires_in || 600) * 1000)
    };
    this.store.setProperty(PROP_KEY, JSON.stringify(bundle));
    return bundle;
  };

  /** @private @return {Object|null} The stored token bundle. */
  TadoClient.prototype.loadTokens_ = function () {
    var raw = this.store.getProperty(PROP_KEY);
    return raw ? safeJson_(raw) : null;
  };

  // =========================================================================
  // Generic authenticated request
  // =========================================================================

  /**
   * Perform an authenticated request. Auto-refreshes the access token, and
   * retries once on a 401.
   *
   * @param {string} url  A full https URL (use the helpers below, or
   *        Tado.v2Url / Tado.hopsUrl to build one).
   * @param {Object=} opts
   * @param {string=} opts.method   HTTP method (default 'get').
   * @param {(Object|string)=} opts.payload  Body; objects are JSON-encoded.
   * @param {Object=} opts.headers  Extra headers.
   * @return {*} Parsed JSON body, raw text if not JSON, or null on 204.
   */
  TadoClient.prototype.request = function (url, opts) {
    opts = opts || {};

    var doFetch = function (token) {
      var params = {
        method: (opts.method || 'get').toLowerCase(),
        muteHttpExceptions: true,
        headers: mergeHeaders_({ Authorization: 'Bearer ' + token }, opts.headers)
      };
      if (opts.payload !== undefined && opts.payload !== null) {
        if (typeof opts.payload === 'string') {
          params.payload = opts.payload;
        } else {
          params.payload = JSON.stringify(opts.payload);
          params.contentType = 'application/json';
        }
      }
      return UrlFetchApp.fetch(url, params);
    };

    var resp = doFetch(this.getAccessToken());

    if (resp.getResponseCode() === 401) {   // token rejected — refresh & retry once
      this.refresh();
      resp = doFetch(this.getAccessToken());
    }

    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('tado° API ' + code + ' for ' + url + ': ' + resp.getContentText());
    }
    if (code === 204) return null;

    var text = resp.getContentText();
    return text ? safeJson_(text, text) : null;
  };

  // =========================================================================
  // Convenience wrappers — classic v2 API (my.tado.com/api/v2)
  // =========================================================================

  /** GET /me — account info incl. the list of homes. */
  TadoClient.prototype.getMe = function () {
    return this.request(v2Url_('/me'));
  };

  /** GET /homes/{homeId} */
  TadoClient.prototype.getHome = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId)));
  };

  /** GET /homes/{homeId}/weather */
  TadoClient.prototype.getWeather = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/weather'));
  };

  /** GET /homes/{homeId}/devices */
  TadoClient.prototype.getDevices = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/devices'));
  };

  /** GET /homes/{homeId}/installations */
  TadoClient.prototype.getInstallations = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/installations'));
  };

  /** GET /homes/{homeId}/mobileDevices */
  TadoClient.prototype.getMobileDevices = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/mobileDevices'));
  };

  /** GET /homes/{homeId}/mobileDevices/{deviceId}/settings */
  TadoClient.prototype.getMobileDeviceSettings = function (homeId, deviceId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/mobileDevices/' + enc_(deviceId) + '/settings'));
  };

  /** GET /homes/{homeId}/devices/{deviceId}/temperatureOffset */
  TadoClient.prototype.getDeviceTemperatureOffset = function (homeId, deviceId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/devices/' + enc_(deviceId) + '/temperatureOffset'));
  };

  /** GET /homes/{homeId}/devices/{deviceId}/humidityOffset */
  TadoClient.prototype.getDeviceHumidityOffset = function (homeId, deviceId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/devices/' + enc_(deviceId) + '/humidityOffset'));
  };

  /**
   * PATCH /homes/{homeId}/devices/{deviceId}/humidityOffset
   * @param {number} humidityOffset  New humidity offset.
   */
  TadoClient.prototype.setDeviceHumidityOffset = function (homeId, deviceId, humidityOffset) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/devices/' + enc_(deviceId) + '/humidityOffset'), {
      method: 'patch',
      payload: { humidityOffset: humidityOffset }
    });
  };

  /** GET /homes/{homeId}/zones/{zoneId}/dayReport */
  TadoClient.prototype.getDayReport = function (homeId, zoneId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/zones/' + enc_(zoneId) + '/dayReport'));
  };

  /** GET /homes/{homeId}/state — home presence (HOME/AWAY). */
  TadoClient.prototype.getHomeState = function (homeId) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/state'));
  };

  /**
   * PUT /homes/{homeId}/presenceLock — override presence.
   * @param {string} presence  'HOME' or 'AWAY'.
   */
  TadoClient.prototype.setPresence = function (homeId, presence) {
    return this.request(v2Url_('/homes/' + enc_(homeId) + '/presenceLock'), {
      method: 'put',
      payload: { homePresence: presence }
    });
  };

  // =========================================================================
  // Convenience wrappers — tado°X API (hops.tado.com)
  // =========================================================================

  /** GET /homes/{homeId}/rooms */
  TadoClient.prototype.getRooms = function (homeId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/rooms'));
  };

  /** GET /homes/{homeId}/rooms/{roomId} */
  TadoClient.prototype.getRoom = function (homeId, roomId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/rooms/' + enc_(roomId)));
  };

  /** GET /homes/{homeId}/features */
  TadoClient.prototype.getFeatures = function (homeId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/features'));
  };

  /** GET /homes/{homeId}/roomsAndDevices */
  TadoClient.prototype.getRoomsAndDevices = function (homeId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/roomsAndDevices'));
  };

  /**
   * POST /homes/{homeId}/rooms/{roomId}/manualControl — set manual control.
   * Pass the full body per the tado°X schema, or use the setRoomTemperature /
   * turnRoomOff helpers below.
   *
   * Example:
   *   t.setRoomManualControl(homeId, roomId, {
   *     setting: { power: 'ON', isBoost: false, temperature: { value: 22.0 } },
   *     termination: { type: 'TIMER', durationInSeconds: 600 }
   *   });
   */
  TadoClient.prototype.setRoomManualControl = function (homeId, roomId, body) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/rooms/' + enc_(roomId) + '/manualControl'), {
      method: 'post',
      payload: body
    });
  };

  /**
   * Convenience: heat a room to a target temperature.
   * @param {number} celsius   Target temperature value.
   * @param {Object=} termination  Termination object. Defaults to
   *        { type: 'MANUAL' }. Examples:
   *          { type: 'NEXT_TIME_BLOCK' }
   *          { type: 'TIMER', durationInSeconds: 600 }
   * @param {boolean=} isBoost  Defaults to false.
   */
  TadoClient.prototype.setRoomTemperature = function (homeId, roomId, celsius, termination, isBoost) {
    return this.setRoomManualControl(homeId, roomId, {
      setting: { power: 'ON', isBoost: !!isBoost, temperature: { value: celsius } },
      termination: termination || { type: 'MANUAL' }
    });
  };

  /**
   * Convenience: turn a room's heating off.
   * @param {Object=} termination  Defaults to { type: 'MANUAL' }.
   */
  TadoClient.prototype.turnRoomOff = function (homeId, roomId, termination) {
    return this.setRoomManualControl(homeId, roomId, {
      setting: { power: 'OFF', isBoost: false, temperature: null },
      termination: termination || { type: 'MANUAL' }
    });
  };

  /** POST /homes/{homeId}/rooms/{roomId}/openWindow — activate open-window. */
  TadoClient.prototype.setOpenWindow = function (homeId, roomId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/rooms/' + enc_(roomId) + '/openWindow'), {
      method: 'post'
    });
  };

  /** DELETE /homes/{homeId}/rooms/{roomId}/openWindow — clear open-window. */
  TadoClient.prototype.deleteOpenWindow = function (homeId, roomId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/rooms/' + enc_(roomId) + '/openWindow'), {
      method: 'delete'
    });
  };

  /** POST /homes/{homeId}/quickActions/boost — boost all rooms. */
  TadoClient.prototype.setBoost = function (homeId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/quickActions/boost'), {
      method: 'post'
    });
  };

  /** POST /homes/{homeId}/quickActions/resumeSchedule — resume schedule. */
  TadoClient.prototype.resumeSchedule = function (homeId) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/quickActions/resumeSchedule'), {
      method: 'post'
    });
  };

  /**
   * PATCH /homes/{homeId}/roomsAndDevices/devices/{deviceId} — update a
   * device's temperature offset (tado°X).
   * @param {number} temperatureOffset
   */
  TadoClient.prototype.setDeviceTemperatureOffset = function (homeId, deviceId, temperatureOffset) {
    return this.request(hopsUrl_('/homes/' + enc_(homeId) + '/roomsAndDevices/devices/' + enc_(deviceId)), {
      method: 'patch',
      payload: { temperatureOffset: temperatureOffset }
    });
  };

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  function nowMs_() { return Date.now(); }
  function enc_(v)  { return encodeURIComponent(String(v)); }

  /** Build a classic v2 API URL. */
  function v2Url_(path, query) {
    return buildUrl_(API_V2_BASE, path, query);
  }

  /** Build a tado°X (hops) URL; always adds ngsw-bypass=true. */
  function hopsUrl_(path, query) {
    query = query || {};
    if (query['ngsw-bypass'] === undefined) query['ngsw-bypass'] = 'true';
    return buildUrl_(HOPS_BASE, path, query);
  }

  function buildUrl_(base, path, query) {
    var url = base + (path.charAt(0) === '/' ? '' : '/') + path;
    if (query) {
      var parts = [];
      for (var k in query) {
        if (Object.prototype.hasOwnProperty.call(query, k) &&
            query[k] !== undefined && query[k] !== null) {
          parts.push(enc_(k) + '=' + enc_(query[k]));
        }
      }
      if (parts.length) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
      }
    }
    return url;
  }

  function mergeHeaders_(base, extra) {
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
      }
    }
    return base;
  }

  /** Parse a UrlFetch response as JSON, throwing on non-2xx or bad JSON. */
  function parseJsonOrThrow_(resp, what) {
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    if (code < 200 || code >= 300) {
      throw new Error('tado° ' + what + ' failed (' + code + '): ' + text);
    }
    var json = safeJson_(text, null);
    if (json === null) {
      throw new Error('tado° ' + what + ' returned non-JSON: ' + text);
    }
    return json;
  }

  /** JSON.parse that returns a fallback (default null) instead of throwing. */
  function safeJson_(text, fallback) {
    try { return JSON.parse(text); }
    catch (e) { return (fallback === undefined) ? null : fallback; }
  }

  // -------------------------------------------------------------------------
  // Public factory
  // -------------------------------------------------------------------------

  return {
    /**
     * Create a tado° client.
     * @param {Object=} options  See TadoClient constructor.
     * @return {TadoClient}
     */
    create: function (options) { return new TadoClient(options); },

    // URL builders, for calling endpoints not wrapped above via client.request().
    v2Url:   function (path, query) { return v2Url_(path, query); },
    hopsUrl: function (path, query) { return hopsUrl_(path, query); },

    // Exposed for advanced use / instanceof checks.
    TadoClient: TadoClient
  };
})();
