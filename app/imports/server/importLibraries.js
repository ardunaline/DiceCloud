import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import Libraries from '/imports/api/library/Libraries';
import LibraryNodes from '/imports/api/library/LibraryNodes';
import LibraryCollections from '/imports/api/library/LibraryCollections';
import { rebuildNestedSets } from '/imports/api/parenting/parentingFunctions';

function remapRef(oldRef, idMap) {
  if (!oldRef) return oldRef;
  if (typeof oldRef === 'string') {
    // parentId style: "someOldNodeId"
    return idMap[oldRef] || oldRef;
  }
  if (oldRef.id && oldRef.collection) {
    // Object ref style: { id: "...", collection: "..." }
    if (idMap[oldRef.id]) {
      return { ...oldRef, id: idMap[oldRef.id] };
    }
  }
  return oldRef;
}

function remapAncestor(a, idMap) {
  if (a.id && idMap[a.id]) {
    return { ...a, id: idMap[a.id] };
  }
  return a;
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

    // Build full ID map: old remote IDs → new local IDs
    const idMap = {};
    idMap[library._id] = newLibId;

    // Pre-generate new IDs for ALL nodes first
    for (const node of nodes) {
      const oldId = node._id;
      if (oldId) {
        idMap[oldId] = Random.id(32);
      }
    }

    // Insert all nodes with fully remapped references
    let nodesInserted = 0;
    const errors = [];
    for (const node of nodes) {
      const oldId = node._id;
      if (!oldId) {
        errors.push('node missing _id: ' + JSON.stringify(node).substring(0, 100));
        continue;
      }
      const newId = idMap[oldId];
      if (!newId) continue;

      const newNode = { ...node };
      newNode._id = newId;

      // Root always points to the new local library
      newNode.root = { collection: 'libraries', id: newLibId };

      // Remap parentId (modern format: string)
      if (newNode.parentId) {
        newNode.parentId = remapRef(newNode.parentId, idMap);
      }
      // Remap parent (old format: object ref)
      if (newNode.parent) {
        const newParent = remapRef(newNode.parent, idMap);
        if (newParent && newParent.collection === 'libraries') {
          // Top-level node: parent is the library itself, clear parentId
          delete newNode.parentId;
          delete newNode.parent;
        } else {
          newNode.parent = newParent;
          // Also set parentId if parent was an object ref
          if (!newNode.parentId && newParent && newParent.id) {
            newNode.parentId = newParent.id;
          }
        }
      }

      // Remap ancestors
      if (newNode.ancestors && Array.isArray(newNode.ancestors)) {
        newNode.ancestors = newNode.ancestors.map(a => remapAncestor(a, idMap));
      }

      // Remap referenceNodeId
      if (newNode.referenceNodeId) {
        newNode.referenceNodeId = remapRef(newNode.referenceNodeId, idMap);
      }

      // Clear any fields that reference old data we can't remap
      delete newNode.parent; // Always use parentId going forward

      try {
        LibraryNodes.insert(newNode);
        nodesInserted++;
      } catch (e) {
        const errMsg = e.message || e.toString();
        errors.push(`node ${oldId}: ${errMsg}`);
        console.log(`  Error inserting node ${oldId}: ${errMsg}`);
      }
    }

    // Rebuild nested set tree (left/right values) from parentId hierarchy
    if (nodesInserted > 0) {
      rebuildNestedSets(LibraryNodes, newLibId);
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
