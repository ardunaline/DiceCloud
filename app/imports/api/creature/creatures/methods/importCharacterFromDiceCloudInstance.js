import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
import { HTTP } from 'meteor/http';
import Creatures from '/imports/api/creature/creatures/Creatures';
import CreatureProperties from '/imports/api/creature/creatureProperties/CreatureProperties';
import CreatureLogs from '/imports/api/creature/log/CreatureLogs';
import Experiences from '/imports/api/creature/experience/Experiences';
import { removeCreatureWork } from '/imports/api/creature/creatures/methods/removeCreature';
import assertHasCharactersSlots from '/imports/api/creature/creatures/methods/assertHasCharacterSlots';
import verifyArchiveSafety from '/imports/api/creature/archive/methods/verifyArchiveSafety';

function importApiCreature(apiCreature, userId) {
  const creature = apiCreature.creatures
    ? (Array.isArray(apiCreature.creatures) ? apiCreature.creatures[0] : apiCreature.creatures)
    : apiCreature.creature;

  if (!creature || !creature._id) {
    throw new Meteor.Error('invalid-data', 'No valid creature found in import data');
  }

  const creatureId = creature._id;

  // Verify safety
  verifyArchiveSafety({
    creature,
    properties: apiCreature.creatureProperties || apiCreature.properties || [],
    experiences: apiCreature.experiences || [],
    logs: apiCreature.logs || [],
  });

  // Don't upload creatures twice
  const existingCreature = Creatures.findOne(creatureId, {
    fields: { _id: 1 }
  });
  if (existingCreature) {
    throw new Meteor.Error('Already exists',
      'The creature you are trying to import already exists in this database.');
  }

  // Ensure the user owns the imported creature
  creature.owner = userId;
  // Remove sharing permissions — user IDs from other instances won't match
  creature.readers = [];
  creature.writers = [];
  // Mark as dirty so it recomputes
  creature.dirty = true;

  // Insert the creature
  Creatures.insert(creature);
  try {
    const properties = apiCreature.creatureProperties || apiCreature.properties || [];
    if (properties.length) {
      CreatureProperties.batchInsert(properties);
    }
    const experiences = apiCreature.experiences || [];
    if (experiences.length) {
      Experiences.batchInsert(experiences);
    }
    const logs = apiCreature.logs || [];
    if (logs.length) {
      CreatureLogs.batchInsert(logs);
    }
  } catch (e) {
    // Rollback: delete the inserted creature
    removeCreatureWork(creatureId);
    throw e;
  }
  return creatureId;
}

// Extract creature ID from various URL formats:
//   https://dicecloud.com/character/abc123
//   https://dicecloud.com/api/creature/abc123
//   abc123
function extractCreatureId(urlOrId) {
  // If it's just an ID (alphanumeric, 17+ chars), return as-is
  if (/^[a-zA-Z0-9]{17,}$/.test(urlOrId.trim())) {
    return urlOrId.trim();
  }
  // Try to extract from URL path
  var match = urlOrId.match(/\/(?:character|creature|api\/creature)\/([a-zA-Z0-9]{17,})/);
  if (match) {
    return match[1];
  }
  return null;
}

// Fetch from the remote DiceCloud instance's REST API.
// The simple:rest package serializes multi-cursor publications as a flat
// array of docs, each tagged with a _collection field.
function fetchRemoteCreature(creatureId, sourceUrl) {
  // Default to dicecloud.com, but allow override via settings or URL origin
  var baseUrl = 'https://dicecloud.com';
  if (Meteor.settings.public && Meteor.settings.public.remoteDiceCloudUrl) {
    baseUrl = Meteor.settings.public.remoteDiceCloudUrl.replace(/\/$/, '');
  }
  // If a full URL was provided, extract its origin
  if (sourceUrl && /^https?:\/\//.test(sourceUrl)) {
    var m = sourceUrl.match(/^(https?:\/\/[^\/]+)/);
    if (m) baseUrl = m[1];
  }

  var apiUrl = baseUrl + '/api/creature/' + creatureId;
  console.log('[import] Fetching ' + apiUrl);

  var result = HTTP.get(apiUrl, {
    headers: {
      'Accept': 'application/json',
    },
    timeout: 30000,
  });

  if (result.statusCode !== 200) {
    throw new Meteor.Error('fetch-failed',
      'Failed to fetch creature from ' + apiUrl + ' (HTTP ' + result.statusCode + ')');
  }

  var docs = result.data;

  // simple:rest returns an array of docs with _collection field
  if (Array.isArray(docs)) {
    var creatures = [];
    var creatureProperties = [];
    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      var coll = doc._collection;
      delete doc._collection;
      if (coll === 'creatures') {
        creatures.push(doc);
      } else if (coll === 'creatureProperties') {
        creatureProperties.push(doc);
      }
      // creatureVariables are ignored — they get recomputed
    }
    return {
      creatures: creatures,
      creatureProperties: creatureProperties,
      experiences: [],
      logs: [],
    };
  }

  // If it's already an object with expected keys, return as-is
  return docs;
}

const importCharacterFromDiceCloudInstance = new ValidatedMethod({
  name: 'Creatures.methods.importFromInstance',
  validate: null,
  mixins: [RateLimiterMixin],
  rateLimit: {
    numRequests: 10,
    timeInterval: 5000,
  },
  async run({ characterData, url }) {
    if (Meteor.settings.public && Meteor.settings.public.disallowCreatureApiImport) {
      throw new Meteor.Error('not-allowed',
        'This instance of DiceCloud has disallowed creature imports');
    }

    // If a URL is provided, fetch from remote server-side
    if (url) {
      if (!Meteor.isServer) {
        // On client, pass through to server
        return Meteor.call('Creatures.methods.importFromInstance', { characterData, url });
      }
      var creatureId = extractCreatureId(url);
      if (!creatureId) {
        throw new Meteor.Error('invalid-url',
          'Could not extract a creature ID from the provided URL. Expected format: https://dicecloud.com/character/ID');
      }
      characterData = fetchRemoteCreature(creatureId, url);
    }

    if (!characterData) {
      throw new Meteor.Error('no-input',
        'No character data was provided');
    }

    assertHasCharactersSlots(this.userId);
    if (Meteor.isServer) {
      return importApiCreature(characterData, this.userId);
    }
  },
});

export default importCharacterFromDiceCloudInstance;
