Discord = {};

Discord.requestCredential = (options, credentialRequestCompleteCallback) => {
  if (!credentialRequestCompleteCallback && typeof options === 'function') {
    credentialRequestCompleteCallback = options;
    options = {};
  }

  const config = ServiceConfiguration.configurations.findOne({service: 'discord'});
  if (!config) {
    credentialRequestCompleteCallback && credentialRequestCompleteCallback(
      new ServiceConfiguration.ConfigError());
    return;
  }

  const credentialToken = Random.id();

  const scope = (options && options.requestPermissions) || [
    'identify',
    'email',
  ];
  const flatScope = scope.map(encodeURIComponent).join(' ');

  const loginStyle = OAuth._loginStyle('discord', config, options);

  const loginUrl =
        'https://discord.com/oauth2/authorize' +
        `?client_id=${config.clientId}` +
        '&response_type=code' +
        (flatScope ? `&scope=${flatScope}` : '') +
        `&redirect_uri=${OAuth._redirectUri('discord', config)}` +
        `&state=${OAuth._stateParam(loginStyle, credentialToken, options && options.redirectUrl)}`;

  OAuth.launchLogin({
    loginService: 'discord',
    loginStyle,
    loginUrl,
    credentialRequestCompleteCallback,
    credentialToken,
  });
};