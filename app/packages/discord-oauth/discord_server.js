Discord = {};

OAuth.registerService('discord', 2, null, query => {
  const response = getAccessToken(query);
  const accessToken = response.access_token;
  const refreshToken = response.refresh_token;
  const expiresIn = response.expires_in;
  const scope = response.scope;
  const expiresAt = (+new Date) + (1000 * expiresIn);
  const identity = getIdentity(accessToken);
  let serviceData = {
    id: identity.id,
    username: identity.username,
    discriminator: identity.discriminator,
    avatar: identity.avatar,
    email: identity.email,
    verified: identity.verified,
    accessToken,
    refreshToken,
    scope,
    expiresAt,
  };
  return { serviceData };
});

const getAccessToken = query => {
  const config = ServiceConfiguration.configurations.findOne({service: 'discord'});
  if (!config)
    throw new ServiceConfiguration.ConfigError();

  let response;
  try {
    response = HTTP.post(
      'https://discord.com/api/oauth2/token',
      {
        headers: { Accept: 'application/json' },
        params: {
          code: query.code,
          client_id: config.clientId,
          client_secret: config.secret,
          grant_type: 'authorization_code',
          redirect_uri: OAuth._redirectUri('discord', config),
        },
      }
    );
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to complete OAuth handshake with Discord. ${err.message}`),
      { response: err.response }
    );
  }

  if (response.data.error) {
    throw new Error(`Failed to complete OAuth handshake with Discord. ${response.data.error}`);
  } else {
    return response.data;
  }
};

const getIdentity = accessToken => {
  try {
    const response = HTTP.get(
      'https://discord.com/api/users/@me',
      {
        headers: { authorization: `Bearer ${accessToken}` },
      }
    );
    let data = JSON.parse(response.content);
    return data;
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to fetch identity from Discord. ${err.message}`),
      { response: err.response }
    );
  }
};

Discord.retrieveCredential = (credentialToken, credentialSecret) =>
  OAuth.retrieveCredential(credentialToken, credentialSecret);