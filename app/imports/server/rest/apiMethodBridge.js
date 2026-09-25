import { JsonRoutes } from 'meteor/simple:json-routes';
import { EJSON } from 'meteor/ejson';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';

/**
 * REST bridge for DDP methods.
 *
 * POST /api/method/<method name>
 * Authorization: Bearer <login token or apiKey>
 * Body: the method's single argument object as JSON ({} for no args)
 *
 * The request is dispatched to the SAME registered method handler that DDP
 * uses, so per-method argument validation (SimpleSchema) and the
 * ddpr-rate-limiter-mixin limits apply automatically. The invocation context
 * carries the authenticated userId and a synthetic connection id, so
 * permission checks and rate limits behave exactly as they do for DDP
 * clients.
 *
 * Only methods in ALLOWED_METHODS are reachable. Everything else returns 404.
 */

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
export const ALLOWED_METHODS = new Set([
  // Creatures
  'creatures.insertCreature',
  'creatures.update',
  'creatures.changeAllowedLibraries',
  'creatures.removeLibraryLimits',

  // Creature properties & engine actions
  'creatureProperties.insert',
  'creatureProperties.insertAsChildOfTag',
  'creatureProperties.insertPropertyFromLibraryNode',
  'creatureProperties.update',
  'creatureProperties.duplicate',
  'creatureProperties.softRemove',
  'creatureProperties.restore',
  'creatureProperties.flipToggle',
  'creatureProperties.equip',
  'creatureProperties.adjustQuantity',
  'creatureProperties.damage',
  'creatureProperties.push',
  'creatureProperties.pull',
  'creatureProperties.selectAmmoItem',
  'creatureProperties.copyPropertyToLibrary',
  'creatureProperties.doCheck',
  'creatureProperties.doAction',
  'creatureProperties.doCastSpell',

  // Creature log (roll results etc.)
  'creatureLogs.methods.insert',
  'creatureLogs.methods.logForCreature',

  // Creature folders
  'creatureFolders.methods.insert',
  'creatureFolders.methods.updateName',
  'creatureFolders.methods.reorder',
  'creatureFolders.methods.remove',
  'creatureFolders.methods.moveCreatureToFolder',

  // Experience
  'experiences.insert',
  'experiences.remove',
  'experiences.recompute',

  // Tabletops & chat
  'tabletops.insert',
  'tabletops.addCreatures',
  'tabletops.remove',
  'messages.send',
  'messages.remove',

  // Sharing
  'sharing.setPublic',
  'sharing.setReadersCanCopy',
  'sharing.transferOwnership',
  'sharing.updateUserSharePermissions',

  // Libraries
  'libraries.insert',
  'libraries.updateName',
  'libraries.updateDescription',
  'libraries.updateShowInMarket',
  'libraries.remove',
  'libraryNodes.insert',
  'libraryNodes.update',
  'libraryNodes.push',
  'libraryNodes.pull',
  'libraryNodes.softRemove',
  'libraryNodes.restore',
  'libraryCollections.insert',
  'libraryCollections.update',
  'libraryCollections.remove',
  'users.subscribeToLibrary',
  'users.subscribeToLibraryCollection',
  'organize.organizeDoc',
  'organize.reorderDoc',

  // Icons (read only; icons.write is admin-only and stays DDP-only)
  'icons.find',

  // Invites
  'invites.getToken',
  'invites.acceptToken',
  'invites.revokeInvite',

  // Self-service user methods
  'users.setUsername',
  'users.canPickUsername',
  'users.setDarkMode',
  'users.setPreference',
  'users.generateApiKey',
  'users.sendVerificationEmail',
]);

// Deliberately NOT reachable over REST:
//   admin.migrateTo        (DB migrations, admin only)
//   icons.write            (admin only, raw inserts)
//   users.findUserByUsernameOrEmail (user enumeration oracle)
//   docs.*                 (documentation editing, not bot-relevant)

// ---------------------------------------------------------------------------
// Rate limiting: fixed window per token identity + IP, on top of the per
// method DDP limits that run inside the handlers themselves.
// ---------------------------------------------------------------------------
const RATE_LIMIT = { requests: 60, windowMs: 10000 };
const rateLimitBuckets = new Map();

function rateLimit(key) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_LIMIT.windowMs) {
    rateLimitBuckets.set(key, { start: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT.requests;
}

// Occasionally prune old buckets so the map can't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.start > RATE_LIMIT.windowMs * 10) {
      rateLimitBuckets.delete(key);
    }
  }
}, RATE_LIMIT.windowMs * 10).unref?.();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clientAddress(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function statusForError(e) {
  if (e && e.statusCode) return e.statusCode;
  const name = e && (e.error || e.reason || '');
  if (/permission/i.test(name)) return 403;
  if (/not-found|no such/i.test(name)) return 404;
  if (/too-many-requests/i.test(name)) return 429;
  return 400;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
JsonRoutes.add('options', 'api/method/:name', function (req, res) {
  JsonRoutes.sendResult(res);
});

JsonRoutes.add('post', 'api/method/:name', function (req, res) {
  const methodName = req.params.name;

  if (!ALLOWED_METHODS.has(methodName)) {
    JsonRoutes.sendResult(res, {
      code: 404,
      data: {
        error: 'not-found',
        reason: `Method '${methodName}' is not available over REST. ` +
          'See the API documentation for the exposed surface.',
      },
    });
    return;
  }

  const handler = Meteor.server.method_handlers[methodName];
  if (!handler) {
    JsonRoutes.sendResult(res, {
      code: 500,
      data: { error: 'server-error', reason: `Method '${methodName}' is not registered` },
    });
    return;
  }

  const ip = clientAddress(req);
  const identity = (req.userId ? 'user:' + req.userId : 'anon:' + ip);
  if (!rateLimit(identity + '|' + methodName.split('.')[0])) {
    JsonRoutes.sendResult(res, {
      code: 429,
      data: {
        error: 'too-many-requests',
        reason: `Rate limit exceeded for this identity (${RATE_LIMIT.requests} requests / ${RATE_LIMIT.windowMs / 1000}s)`,
      },
    });
    return;
  }

  let args = req.body;
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    JsonRoutes.sendResult(res, {
      code: 400,
      data: {
        error: 'bad-request',
        reason: 'The request body must be a JSON object holding the method arguments',
      },
    });
    return;
  }

  const invocation = {
    userId: req.userId, // set by the bearer-token middleware, may be undefined
    isSimulation: false,
    setUserId() {},
    unblock() {},
    connection: {
      id: 'rest:' + identity,
      clientAddress: ip,
      httpHeaders: req.headers,
      close() {},
      on() {},
      send() {},
    },
    // Some handlers introspect the raw request (none currently do, but keep
    // the surface complete)
  };

  try {
    // Apply the same per-method DDP rate limits that a websocket client
    // would hit. The RateLimiterMixin only registers rules; Meteor's DDP
    // session does the increment, which we must replicate here.
    const rateLimitResult = DDPRateLimiter.increment({
      type: 'method',
      name: methodName,
      userId: req.userId,
      connectionId: 'rest:' + identity,
      clientAddress: ip,
    });
    if (!rateLimitResult.allowed) {
      JsonRoutes.sendResult(res, {
        code: 429,
        data: {
          error: 'too-many-requests',
          reason: `Method rate limit exceeded, retry in ${Math.ceil(rateLimitResult.timeToReset / 1000)}s`,
        },
      });
      return;
    }

    const result = handler.call(invocation, args);
    JsonRoutes.sendResult(res, {
      code: 200,
      data: {
        result: result === undefined ? null : EJSON.toJSONValue(result),
      },
    });
  } catch (e) {
    // Re-throw programmer errors that aren't Meteor/validation errors so they
    // hit the error middleware and server logs
    if (!(e instanceof Meteor.Error) && e.sanitizedError === undefined && !e.reason) {
      console.error(`REST bridge: method '${methodName}' crashed:`, e);
      JsonRoutes.sendResult(res, {
        code: 500,
        data: { error: 'internal-error', reason: 'Internal error while running the method' },
      });
      return;
    }
    const out = e instanceof Meteor.Error ? e : (e.sanitizedError || e);
    JsonRoutes.sendResult(res, {
      code: statusForError(out),
      data: {
        error: out.error || 'error',
        reason: out.reason || e.message || 'Method failed',
        ...(out.details ? { details: EJSON.toJSONValue(out.details) } : {}),
      },
    });
  }
});
