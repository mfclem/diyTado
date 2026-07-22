
function getThermostatsStates() {
  GenAIApp.setGeminiAPIKey(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'));

  const chat = GenAIApp.newChat();
  chat.addMessage('Quels sont les états des thermostats?');

  const response = chat.run({ model: 'gemini-3.1-flash-lite' });
  Logger.log(response);
}


function run() {
  //authorizeTado();
  console.log("approved!");
  console.log("read rooms...");
  readRooms();
  console.log("get weather...");
  readWeather();
  console.log("properties:");
  logUserProperties();
  console.log("done");

}


function authorizeTado() {
  var t = Tado.create();
  var res = t.startDeviceAuthorization();
  Logger.log('Open and log in: ' + res.verification_uri_complete);
  t.pollForToken(res);   // blocks until you approve, then stores tokens
}

 
function readRooms() {
  var t = Tado.create();
  var homeId = t.getMe().homes[0].id;
  Logger.log(t.getRooms(homeId));
}

function readWeather() {
  var t = Tado.create();
  var homeId = t.getMe().homes[0].id;
  Logger.log(t.getWeather(homeId));
}

function logUserProperties() {
  var userProperties = PropertiesService.getUserProperties();
  var allProperties = userProperties.getProperties();
/*
  if (Object.keys(allProperties).length === 0) {
    Logger.log("Le PropertiesService est complètement vide.");
    return;
  }
*/
  for (var key in allProperties) {
    Logger.log('Key : "' + key + '" | Value : "' + allProperties[key] + '"');
  }
}
