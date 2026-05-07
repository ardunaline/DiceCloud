import { Meteor } from 'meteor/meteor';
import Libraries from '/imports/api/library/Libraries';
import LibraryNodes from '/imports/api/library/LibraryNodes';
import LibraryCollections from '/imports/api/library/LibraryCollections';
import { reorderDocs } from '/imports/api/parenting/order.js';

function remapRef(oldRef, idMap) {
  if (!oldRef) return oldRef;
  if (typeof oldRef === 'string') {
    return idMap[oldRef] || oldRef;
  }
  if (oldRef.id && oldRef.collection) {
    if (idMap[oldRef.id]) {
      return { id: idMap[oldRef.id], collection: oldRef.collection };
    }
  }
  return oldRef;
}

Meteor.methods({
  saveImportedLibrary({ library, nodes, ownerId }) {
    if (!this.userId) throw new Meteor.Error('not-logged-in');

    const targetOwner = ownerId || this.userId;

    const existing = Libraries.findOne({ name: library.name, owner: targetOwner });
    if (existing) {
      return { skipped: library.name };
    }

    // Insert the library
    const newLibId = Libraries.insert({
      name: library.name,
      description: library.description,
      showInMarket: true,
      public: true,
      owner: targetOwner,
      writers: [],
      readers: [],
    });

    // Build full ID map: old remote IDs -> new local IDs
    const idMap = {};
    idMap[library._id] = newLibId;

    // Pre-generate new IDs for ALL nodes
    const randomSrc = DDP.randomStream('saveImportedLibrary');
    for (const node of nodes) {
      const oldId = node._id;
      if (oldId) {
        idMap[oldId] = randomSrc.id();
      }
    }

    // Insert all nodes with fully remapped references
    let nodesInserted = 0;
    const errors = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const oldId = node._id;
      if (!oldId) {
        errors.push('node missing _id at index ' + i);
        continue;
      }
      const newId = idMap[oldId];
      if (!newId) continue;

      const newNode = { ...node };
      newNode._id = newId;
      // Set initial order based on index to preserve original ordering
      newNode.order = i;

      // Remap parent ref (v2 format: {id, collection})
      if (newNode.parent) {
        const newParent = remapRef(newNode.parent, idMap);
        if (newParent && newParent.collection === 'libraries') {
          // Top-level node: parent is the new local library
          newNode.parent = { id: newLibId, collection: 'libraries' };
        } else {
          newNode.parent = newParent;
        }
      }

      // Remap ancestors
      if (newNode.ancestors && Array.isArray(newNode.ancestors)) {
        newNode.ancestors = newNode.ancestors.map(a => remapRef(a, idMap));
        // Replace the root ancestor (library) with the new local library
        if (newNode.ancestors.length > 0 && newNode.ancestors[0].collection === 'libraries') {
          newNode.ancestors[0] = { id: newLibId, collection: 'libraries' };
        }
      } else {
        // No ancestors: set to library root
        newNode.ancestors = [{ id: newLibId, collection: 'libraries' }];
      }

      // Ensure parent is set for nodes without one
      if (!newNode.parent || !newNode.parent.id) {
        newNode.parent = { id: newLibId, collection: 'libraries' };
      }

      // Remove v3 fields that don't exist in v2 schema
      delete newNode.parentId;
      delete newNode.root;
      delete newNode.left;
      delete newNode.right;

      try {
        LibraryNodes.insert(newNode);
        nodesInserted++;
      } catch (e) {
        const errMsg = e.message || e.toString();
        errors.push(`node ${oldId}: ${errMsg}`);
        console.log(`  Error inserting node ${oldId}: ${errMsg}`);
      }
    }

    // Recompute tree order (depth-first) after all nodes are inserted
    if (nodesInserted > 0) {
      reorderDocs({ collection: LibraryNodes, ancestorId: newLibId });
    }

    return { imported: library.name, nodes: nodesInserted, errors: errors.length ? errors : undefined };
  },

  saveImportedLibraryCollection({ collection }) {
    if (!this.userId) throw new Meteor.Error('not-logged-in');
    const existing = LibraryCollections.findOne({ name: collection.name, owner: this.userId });
    if (existing) return { skipped: collection.name };
    LibraryCollections.insert({
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
