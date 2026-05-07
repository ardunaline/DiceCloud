import { ServiceConfiguration } from 'meteor/service-configuration';

Meteor.startup(() => {
  const discordConfig = Meteor.settings?.discord;
  if (discordConfig?.clientId && discordConfig?.clientSecret) {
    ServiceConfiguration.configurations.upsert(
      { service: 'discord' },
      {
        $set: {
          clientId: discordConfig.clientId,
          secret: discordConfig.clientSecret,
        },
      }
    );
  }
});