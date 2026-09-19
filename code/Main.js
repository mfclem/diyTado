function getThermostatsStates() {
  GenAIApp.setGeminiAPIKey(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'));

  const chat = GenAIApp.newChat();
  chat.addMessage('Quels sont les états des thermostats?');

  const response = chat.run({ model: 'gemini-3.1-flash-lite' });
  Logger.log(response);
}


function run() {
  //authorizeTado();
  Logger = BetterLog.useSpreadsheet('1SoATMEhFWrdvawUuJr9K64U_L5fCpkNYa-zt1Ay5_4Q');
  Session.getActiveUser();

  Logger.log("approved!");
  Logger.log("read rooms...");
  readRooms();
  Logger.log("get weather...");
  readWeather();
  Logger.log("properties:");
  logUserProperties();
  Logger.log("done");

}

function readRooms() {
  var tado = tadoClient_()
  var homeId = requireHomeId_();
  Logger.log(JSON.stringify(tado.getRooms(homeId), null, 2));
}

function readWeather() {
  var tado = tadoClient_()
  var homeId = requireHomeId_();
  Logger.log(JSON.stringify(tado.getWeather(homeId), null, 2));
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