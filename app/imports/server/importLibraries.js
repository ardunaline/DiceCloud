import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import Libraries from '/imports/api/library/Libraries';
import LibraryNodes from '/imports/api/library/LibraryNodes';
import LibraryCollections from '/imports/api/library/LibraryCollections';

Meteor.methods({
  saveImportedLibrary({ library, nodes }) {
    if (!this.userId) throw new Meteor.Error('not-logged-in');

    // Check if already imported
    const existing = Libraries.findOne({ name: library.name, owner: this.userId });
    if (existing) {
      return { skipped: library.name };
    }

    // Insert library
    const newLibId = Libraries.insert({
      name: library.name,
      description: library.description,
      showInMarket: false,
      public: false,
      owner: this.userId,
      writers: [],
      readers: [],
    });

    // Map old IDs to new IDs
    const idMap = {};
    idMap[library._id] = newLibId;

    // Insert all nodes with new IDs
    let nodesInserted = 0;
    for (const node of nodes) {
      const newNode = { ...node };
      const oldId = newNode._id;
      const newId = Random.id(32);
      idMap[oldId] = newId;
      newNode._id = newId;

      // Remap root
      if (newNode.root && newNode.root.id === library._id) {
        newNode.root = { collection: 'libraries', id: newLibId };
      }

      // Remap ancestors
      if (newNode.ancestors) {
        newNode.ancestors = newNode.ancestors.map(a => {
          if (a.id === library._id) return { collection: 'libraries', id: newLibId };
          return a;
        });
      }

      try {
        LibraryNodes.insert(newNode);
        nodesInserted++;
      } catch (e) {
        console.log(`  Error inserting node ${oldId}: ${e.message}`);
      }
    }

    // Second pass: remap parentId and referenceNodeId
    for (const node of nodes) {
      const oldId = node._id;
      const newId = idMap[oldId];
      if (!newId) continue;

      const updates = {};
      if (node.parentId && idMap[node.parentId]) {
        updates.parentId = idMap[node.parentId];
      }
      if (node.referenceNodeId && idMap[node.referenceNodeId]) {
        updates.referenceNodeId = idMap[node.referenceNodeId];
      }
      if (Object.keys(updates).length) {
        LibraryNodes.update(newId, { $set: updates });
      }
    }

    return { imported: library.name, nodes: nodesInserted };
  },

  saveImportedLibraryCollection({ collection }) {
    if (!this.userId) throw new Meteor.Error('not-logged-in');
    const existing = LibraryCollections.findOne({ name: collection.name, owner: this.userId });
    if (existing) return { skipped: collection.name };
    const newId = LibraryCollections.insert({
      name: collection.name,
      description: collection.description,
      owner: this.userId,
      public: true,
      showInMarket: true,
      libraries: collection.libraries || [],
      writers: [],
      readers: [],
    });
    return { imported: collection.name };
  },
});
