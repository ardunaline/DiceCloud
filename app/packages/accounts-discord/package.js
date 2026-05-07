Package.describe({
  summary: 'Login service for Discord accounts',
  version: '0.1.0',
});

Package.onUse(api => {
  api.use('ecmascript');
  api.use('accounts-base', ['client', 'server']);
  api.imply('accounts-base', ['client', 'server']);

  api.use('accounts-oauth', ['client', 'server']);
  api.use('discord-oauth');
  api.imply('discord-oauth');

  api.addFiles('discord.js');
});