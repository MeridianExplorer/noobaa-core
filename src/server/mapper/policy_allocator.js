'use strict';

module.exports = {
    allocate_on_pools: allocate_on_pools,
    analyze_chunk_status_on_pools: analyze_chunk_status_on_pools,
    remove_allocation: remove_allocation,
    get_pools_groups: get_pools_groups,
};

var _ = require('lodash');
var P = require('../../util/promise');
var system_store = require('../stores/system_store');
var block_allocator = require('./block_allocator');
var js_utils = require('../../util/js_utils');
var config = require('../../../config.js');
var dbg = require('../../util/debug_module')(__filename);


function allocate_on_pools(chunk, avoid_nodes, pools) {
    return P.when(block_allocator.allocate_block(chunk, avoid_nodes, pools));
}

function remove_allocation(blocks) {
    return P.when(block_allocator.remove_blocks(blocks));
}

function get_pools_groups(bucket_id) {
    //TODO take into account multi-tiering
    var reply = [];
    var tiers = get_tiering_info(bucket_id);
    if (tiers[0].data_placement === 'MIRROR') {
        _.each(tiers[0].pools, function(p) {
            reply.push([p]);
        });
    } else if (tiers[0].data_placement === 'SPREAD') {
        reply.push([]); //Keep the same format as MIRROR
        _.each(tiers[0].pools, function(p) {
            reply[0].push(p);
        });
    }
    return reply;
}

/**
 *
 * analyze_chunk_status_on_pools
 *
 * compute the status in terms of availability
 * of the chunk blocks per fragment and as a whole.
 * takes into account state on specific given pools only.
 *
 */

function analyze_chunk_status_on_pools(chunk, allocated_blocks, orig_pools) {
    var mirrored_pool = false;
    orig_pools = _.flatten(orig_pools);

    //convert pools to strings for comparison
    var pools = _.map(orig_pools, function(p) {
        return p._id.toString();
    });

    //Remove blocks which are allocated on non-associated (to pools) nodes
    var policy_blocks = _.filter(allocated_blocks, function(b) {
        return _.findIndex(pools, function(p) {
            return p === b.node.pool.toString();
        }) !== -1;
    });

    if (policy_blocks.length === 0) {
        mirrored_pool = true;
        dbg.log0('analyze_chunk_status_on_pools: mirrored pool for chunk', chunk._id,
            'on pools', pools);
    }

    var now = Date.now();
    var blocks_by_frag_key = _.groupBy(policy_blocks, get_frag_key);
    var all_blocks_by_frag_key = _.groupBy(allocated_blocks, get_frag_key);
    var blocks_info_to_allocate;
    var blocks_to_remove;
    var chunk_health = 'available';

    // TODO loop over parity fragments too
    var frags = _.times(chunk.data_frags, function(frag) {

        var fragment = {
            layer: 'D',
            frag: frag,
            size: chunk.size
        };

        fragment.blocks = blocks_by_frag_key[get_frag_key(fragment)] || [];
        fragment.accessible_blocks = [];

        // sorting the blocks by last node heartbeat time and by srvmode and building,
        // so that reading will be served by most available node.
        // TODO better randomize order of blocks for some time frame
        // TODO need stable sorting here for parallel decision making...
        fragment.blocks.sort(block_access_sort);

        dbg.log1('analyze_chunk_status_on_pools:', 'chunk', chunk._id,
            'fragment', frag, 'num blocks', fragment.blocks.length);

        //Analyze good/building blocks on the policy pools only
        _.each(fragment.blocks, function(block) {
            classify_block(fragment, block, now);
        });

        // Analyze accisible blocks on all the pools
        var other_blocks = all_blocks_by_frag_key[get_frag_key(fragment)];
        var other_fragment = {};
        _.each(other_blocks, function(block) {
            classify_block(other_fragment, block, now);
        });

        if (other_fragment.accessible_blocks && other_fragment.accessible_blocks.length) {
            js_utils.array_push_all(fragment.accessible_blocks, other_fragment.accessible_blocks);
        }

        var num_accessible_blocks = fragment.accessible_blocks ?
            fragment.accessible_blocks.length : 0;
        var num_good_blocks = fragment.good_blocks ?
            fragment.good_blocks.length : 0;

        if (!num_accessible_blocks) {
            fragment.health = 'unavailable';
            chunk_health = 'unavailable';
        }

        if (num_good_blocks > config.OPTIMAL_REPLICAS) {
            blocks_to_remove = blocks_to_remove || [];

            // remove all blocks that were building for too long
            // as they most likely failed to build.
            js_utils.array_push_all(blocks_to_remove, fragment.long_building_blocks);

            // remove all long gone blocks
            // defer the short gone blocks until either back to good or become long.
            js_utils.array_push_all(blocks_to_remove, fragment.long_gone_blocks);

            // remove extra good blocks when good blocks are above optimal
            // and not just accesible blocks are above optimal
            js_utils.array_push_all(blocks_to_remove, fragment.good_blocks.slice(config.OPTIMAL_REPLICAS));
        }

        if ((num_good_blocks < config.OPTIMAL_REPLICAS && num_accessible_blocks) ||
            mirrored_pool) {
            fragment.health = 'repairing';

            // will allocate blocks for fragment to reach optimal count
            blocks_info_to_allocate = blocks_info_to_allocate || [];
            var round_rob = 0;
            var num_blocks_to_add = Math.max(0, config.OPTIMAL_REPLICAS - num_good_blocks);
            _.times(num_blocks_to_add, function() {
                blocks_info_to_allocate.push({
                    system_id: chunk.system,
                    tier_id: chunk.tier,
                    chunk_id: chunk._id,
                    chunk: chunk,
                    layer: 'D',
                    frag: frag,
                    source: fragment.accessible_blocks[
                        round_rob % fragment.accessible_blocks.length]
                });
                round_rob += 1;
            });
        }

        fragment.health = fragment.health || 'healthy';

        return fragment;
    });

    return {
        chunk: chunk,
        all_blocks: policy_blocks,
        frags: frags,
        blocks_info_to_allocate: blocks_info_to_allocate,
        blocks_to_remove: blocks_to_remove,
        chunk_health: chunk_health,
    };
}


function classify_block(fragment, block, now) {
    var since_hb = now - block.node.heartbeat.getTime();
    if (since_hb > config.LONG_GONE_THRESHOLD || block.node.srvmode === 'disabled') {
        return js_utils.named_array_push(fragment, 'long_gone_blocks', block);
    }
    if (since_hb > config.SHORT_GONE_THRESHOLD) {
        return js_utils.named_array_push(fragment, 'short_gone_blocks', block);
    }
    if (block.building) {
        var since_bld = now - block.building.getTime();
        if (since_bld > config.LONG_BUILD_THRESHOLD) {
            return js_utils.named_array_push(fragment, 'long_building_blocks', block);
        } else {
            return js_utils.named_array_push(fragment, 'building_blocks', block);
        }
    }
    if (!block.node.srvmode) {
        js_utils.named_array_push(fragment, 'good_blocks', block);
    }
    // also keep list of blocks that we can use to replicate from
    if (!block.node.srvmode || block.node.srvmode === 'decommissioning') {
        js_utils.named_array_push(fragment, 'accessible_blocks', block);
    }
}


/**
 * Reading tiering info for a bucket
 */
function get_tiering_info(bucket_id) {
    var bucket = system_store.data.get_by_id(bucket_id);
    var tiers = _.map(bucket.tiering.tiers, 'tier');
    return tiers;
}

/**
 * sorting function for sorting blocks with most recent heartbeat first
 */
function block_access_sort(block1, block2) {
    if (block1.building) {
        return 1;
    }
    if (block2.building) {
        return -1;
    }
    if (block1.node.srvmode) {
        return 1;
    }
    if (block2.node.srvmode) {
        return -1;
    }
    return block2.node.heartbeat.getTime() - block1.node.heartbeat.getTime();
}

function get_frag_key(f) {
    return f.layer + '-' + f.frag;
}
