import Discord from 'discord.js'
export default function sendWebhook({ webhookURL, data = {} }) {
  //webhookURL = https://discord.com/api/webhooks/<id>/<token>
  let urlArray = webhookURL.split('/').filter(Boolean);
  let token = urlArray.pop();
  let id = urlArray.pop();

  // prevent discord mention exploit
  data.allowedMentions = { parse: [] };

  const hook = new Discord.WebhookClient(id, token);
  hook.send(data).catch(e => {
    console.error('Discord webhook failed:', e);
  });
}

export function sendWebhookAsCreature({ creature, data = {} }) {
  if (!creature || !creature.settings || !creature.settings.discordWebhook) return;
  data.username = creature.name;
  data.avatarURL = creature.avatarPicture;
  sendWebhook({
    webhookURL: creature.settings.discordWebhook,
    data,
  });
}
