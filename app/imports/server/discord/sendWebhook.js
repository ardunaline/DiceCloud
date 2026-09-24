import https from 'https';

export default function sendWebhook({ webhookURL, data = {} }) {
  // webhookURL = https://discord.com/api/webhooks/<id>/<token>
  if (!webhookURL || typeof webhookURL !== 'string') return;

  // prevent discord mention exploit
  data.allowedMentions = { parse: [] };

  const payload = JSON.stringify(data);
  let url;
  try {
    url = new URL(webhookURL);
  } catch (e) {
    console.error('Discord webhook failed: invalid webhook URL');
    return;
  }

  const req = https.request({
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 10000,
  }, (res) => {
    // Drain the response so the socket is released
    res.resume();
    if (res.statusCode >= 300) {
      console.error('Discord webhook failed: status ' + res.statusCode);
    }
  });
  req.on('timeout', () => {
    req.destroy(new Error('Discord webhook timed out'));
  });
  req.on('error', (e) => {
    console.error('Discord webhook failed:', e.message || e);
  });
  req.end(payload);
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
