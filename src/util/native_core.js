'use strict';

module.exports = lazy_init_native_core;

var _ = require('lodash');
var events = require('events');
var native_core;

function lazy_init_native_core(must_load) {
    if (!native_core) {
        try {
            native_core = require('bindings')('native_core.node');

            // see https://github.com/bnoordhuis/node-event-emitter
            inherits(native_core.Nudp, events.EventEmitter);

        } catch (err) {
            if (must_load) {
                throw err;
            }
        }
    }
    return native_core;
}

// extend prototype
function inherits(target, source) {
    _.forIn(source.prototype, function(v, k) {
        target.prototype[k] = source.prototype[k];
    });
}
