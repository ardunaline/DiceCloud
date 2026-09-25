import Creatures from '/imports/api/creature/creatures/Creatures.js';

/**
 * GET /api/creatures
 *
 * Lists the calling user's creatures (owned, readable or writable) so
 * programmatic clients can discover creature IDs. Requires authentication.
 */
Meteor.publish('api-creatures', function () {
  if (!this.userId) {
    const error = new Meteor.Error('permission-denied',
      'You need to be logged in to list your creatures');
    error.statusCode = 403;
    this.error(error);
    return;
  }
  return Creatures.find({
    $or: [
      { owner: this.userId },
      { readers: this.userId },
      { writers: this.userId },
    ],
    removed: { $ne: true },
  }, {
    fields: {
      name: 1,
      type: 1,
      public: 1,
      owner: 1,
      readers: 1,
      writers: 1,
      avatarPicture: 1,
      'denormalizedStats.xp': 1,
      'denormalizedStats.milestoneLevels': 1,
    },
    sort: { name: 1 },
  });
}, {
  url: 'api/creatures',
});
