/* jshint node:true */
'use strict';

var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var types = mongoose.Schema.Types;


/**
 *
 * POOLS SCHEMA
 *
 */
var pools_schema = new Schema({

    system: {
        ref: 'System',
        type: types.ObjectId,
        required: true,
    },

    name: {
        type: String,
        required: true,
    },

    nodes: [String],
}, {
    // we prefer to call ensureIndexes explicitly when needed
    autoIndex: false
});

pools_schema.index({
    system: 1,
    name: 1,
    deleted: 1, // allow to filter deleted
}, {
    unique: true
});

module.exports = mongoose.model('Pool', pools_schema);
