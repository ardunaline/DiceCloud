import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

// DDP.connect is a Meteor global on the server, not available via import
import Libraries from '/imports/api/library/Libraries';
import LibraryNodes from '/imports/api/library/LibraryNodes';
import LibraryCollections from '/imports/api/library/LibraryCollections';

class SimpleStore {
  constructor() {
    this.data = {};
  }
  update(msg) {
    if (msg.msg === 'added') {
      this.data[msg.id] = { _id: msg.id, ...msg.fields };
    } else if (msg.msg === 'changed') {
      if (this.data[msg.id]) Object.assign(this.data[msg.id], msg.fields);
    } else if (msg.msg === 'removed') {
      delete this.data[msg.id];
    }
  }
  beginUpdate() {}
  endUpdate() {}
  saveOriginals() {}
  retrieveOriginals() {}
  all() { return Object.values(this.data); }
}

function waitForSubReady(conn, subHandle) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscription timed out')), 120000);
    if (subHandle.ready()) {
      clearTimeout(timeout);
      resolve();
    } else {
      subHandle.ready(() => {
        clearTimeout(timeout);
        resolve();
      });
    }
  });
}

function ddpLogin(conn, email, password) {
  return new Promise((resolve, reject) => {
    conn.call('login', { password, user: { email } }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

Meteor.methods({
  async importLibrariesFromDicecloud({ email, password }) {
    if (!this.userId) throw new Meteor.Error('not-logged-in');

    console.log('Connecting to dicecloud.com...');
    const remote = DDP.connect('https://dicecloud.com');
    // On server, DDP.connect may return connection directly or as { connection }
    const conn = remote.connection || remote;
    console.log('Connected, connection type:', typeof conn, Object.keys(conn).slice(0, 10));

    // Register stores to capture DDP data
    const librariesStore = new SimpleStore();
    const libraryNodesStore = new SimpleStore();
    const libraryCollectionsStore = new SimpleStore();
    conn.registerStore('libraries', librariesStore);
    conn.registerStore('libraryNodes', libraryNodesStore);
    conn.registerStore('libraryCollections', libraryCollectionsStore);

    try {
      // Log in
      console.log('Logging in...');
      await ddpLogin(conn, email, password);
      console.log('Logged in');

      // Subscribe to browseLibraries
      console.log('Fetching library list...');
      const browseSub = conn.subscribe('browseLibraries');
      await waitForSubReady(conn, browseSub);

      const remoteLibraries = librariesStore.all();
      const remoteCollections = libraryCollectionsStore.all();
      console.log(`Found ${remoteLibraries.length} libraries, ${remoteCollections.length} collections`);

      // Import library collections
      let collectionsCount = 0;
      for (const col of remoteCollections) {
        const existing = LibraryCollections.findOne({ name: col.name, owner: this.userId });
        if (!existing) {
          LibraryCollections.insert({
            name: col.name,
            description: col.description,
            owner: this.userId,
            public: true,
            showInMarket: true,
            libraries: col.libraries || [],
            writers: [],
            readers: [],
          });
          collectionsCount++;
        }
      }

      // Import libraries and nodes
      let libsCount = 0;
      let nodesCount = 0;

      for (const lib of remoteLibraries) {
        const existing = Libraries.findOne({ name: lib.name, owner: this.userId });
        if (existing) {
          console.log(`  Skipping "${lib.name}": already imported`);
          continue;
        }

        console.log(`  Fetching nodes for "${lib.name}"...`);
        const nodesSub = conn.subscribe('libraryNodes', lib._id);
        await waitForSubReady(conn, nodesSub);

        const nodes = libraryNodesStore.all().filter(n => n.root && n.root.id === lib._id);
        if (!nodes.length) {
          // Clear store for next iteration
          Object.keys(libraryNodesStore.data).forEach(k => delete libraryNodesStore.data[k]);
          console.log(`  Skipping "${lib.name}": no nodes`);
          continue;
        }

        // Insert library with current user as owner
        const newLibId = Libraries.insert({
          name: lib.name,
          description: lib.description,
          showInMarket: false,
          public: false,
          owner: this.userId,
          writers: [],
          readers: [],
        });

        // Map old lib ID to new lib ID for remapping references
        const idMap = {};
        idMap[lib._id] = newLibId;

        // Insert all nodes, remapping internal references
        for (const node of nodes) {
          const newNode = { ...node };

          // Assign new IDs to avoid conflicts with future imports
          const oldNodeId = newNode._id;
          const newNodeId = Random.id(32);
          idMap[oldNodeId] = newNodeId;
          newNode._id = newNodeId;

          // Remap root to point to new library
          if (newNode.root && newNode.root.id === lib._id) {
            newNode.root = { collection: 'libraries', id: newLibId };
          }

          // Remap ancestors
          if (newNode.ancestors) {
            newNode.ancestors = newNode.ancestors.map(a => {
              if (a.id === lib._id) return { collection: 'libraries', id: newLibId };
              return a;
            });
          }

          try {
            LibraryNodes.insert(newNode);
            nodesCount++;
          } catch (e) {
            console.log(`  Error inserting node ${oldNodeId}: ${e.message}`);
          }
        }

        // Second pass: remap parent references to new IDs
        for (const node of nodes) {
          const oldParentId = node.parentId;
          const oldNodeId = node._id;
          if (oldParentId && idMap[oldParentId] && idMap[oldNodeId]) {
            LibraryNodes.update(idMap[oldNodeId], {
              $set: { parentId: idMap[oldParentId] }
            });
          }

          // Remap any references to other nodes
          if (node.referenceNodeId && idMap[node.referenceNodeId]) {
            LibraryNodes.update(idMap[oldNodeId], {
              $set: { referenceNodeId: idMap[node.referenceNodeId] }
            });
          }
        }

        libsCount++;
        console.log(`  Imported "${lib.name}" with ${nodes.length} nodes`);

        // Clear node store for next library
        Object.keys(libraryNodesStore.data).forEach(k => delete libraryNodesStore.data[k]);
      }

      conn.disconnect();
      return {
        libraries: libsCount,
        nodes: nodesCount,
        collections: collectionsCount,
      };
    } catch (e) {
      conn.disconnect();
      console.error('Import failed:', e);
      throw new Meteor.Error('import-failed', e.message || e.toString());
    }
  },
});
