import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { RateLimiterMixin } from 'ddp-rate-limiter-mixin';
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

const importCharacterFromDiceCloudInstance = new ValidatedMethod({
  name: 'Creatures.methods.importFromInstance',
  validate: null,
  mixins: [RateLimiterMixin],
  rateLimit: {
    numRequests: 10,
    timeInterval: 5000,
  },
  async run({ characterData }) {
    if (Meteor.settings.public && Meteor.settings.public.disallowCreatureApiImport) {
      throw new Meteor.Error('not-allowed',
        'This instance of DiceCloud has disallowed creature imports');
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
