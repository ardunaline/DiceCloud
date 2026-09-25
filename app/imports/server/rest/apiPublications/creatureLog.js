import SimpleSchema from 'simpl-schema';
import Creatures from '/imports/api/creature/creatures/Creatures.js';
import CreatureLogs from '/imports/api/creature/log/CreatureLogs.js';
import { assertViewPermission } from '/imports/api/creature/creatures/creaturePermissions.js';

let schema = new SimpleSchema({
  creatureId: {
    type: String,
    regEx: SimpleSchema.RegEx.Id,
  },
});

/**
 * GET /api/creature/:id/log
 *
 * Returns the most recent log entries for a creature — this is where roll
 * results land (dice results, actions, damage). Public creatures can be read
 * anonymously, others need a Bearer token with view permission.
 */
Meteor.publish('api-creature-log', function (creatureId) {
  try {
    schema.validate({ creatureId });
  } catch (e) {
    this.error(e);
    return;
  }
  const creature = Creatures.findOne({ _id: creatureId }, {
    fields: { owner: 1, readers: 1, writers: 1, public: 1 },
  });
  try {
    assertViewPermission(creature, this.userId);
  } catch (e) {
    this.error(e);
    return;
  }
  return CreatureLogs.find({ creatureId }, {
    limit: 20,
    sort: { date: -1 },
    fields: { content: 1, creatureId: 1, creatureName: 1, date: 1 },
  });
}, {
  url: 'api/creature/:0/log',
});
