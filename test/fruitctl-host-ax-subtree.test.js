// SPDX-License-Identifier: MIT
// #158 broker side: subtree-rooted snapshots, per-call node caps and
// show_menu_element. Mock SSH Host only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';
import { hostOnlyProfile, hostSequence, refusal, snapshot } from './host-mock.mjs';

const MENU = 'ax:77:0.0.8.1.34';
const menuSnapshot = () => snapshot({ root: 'menu', generation: 5, node_count: 3,
  applications: [{ pid: 77, ref: MENU, bundle_id: 'com.apple.logic10', name: 'Logic Pro' }],
  nodes: [{ ref: MENU, parent: null, depth: 0, role: 'AXMenu', frame: { x: 10, y: 10, width: 100, height: 80 } },
    { ref: `${MENU}.2`, parent: MENU, depth: 1, role: 'AXMenuItem', label: 'Compressor',
      frame: { x: 10, y: 30, width: 100, height: 20 } },
    { ref: `${MENU}.2.0`, parent: `${MENU}.2`, depth: 2, role: 'AXMenu', frame: null }] });

async function executorFor(alter) {
  const hosts = hostSequence({ alter });
  const executor = await nativeFactory(hostOnlyProfile(), { hostSpawn: hosts.spawnImpl });
  return { executor, host: hosts.attachments[0] };
}

test('ax_snapshot sends root and max_nodes and adopts the subtree refs', async () => {
  const { executor, host } = await executorFor((request, response) => {
    if (request.action === 'ax_snapshot' && request.params.root === 'menu') response.result.ax_snapshot = menuSnapshot();
    if (request.action === 'ax_action') response.result.ax_action.action = request.params.action;
    if (request.action === 'ax_action') response.result.ax_action.path = 'ax_show_menu';
    return response;
  });
  try {
    const [read] = await executor.execute([{ action: 'ax_snapshot', root: 'menu', max_nodes: 300, depth: 4 }]);
    const sent = host.requests.find(request => request.action === 'ax_snapshot').params;
    assert.deepEqual([sent.root, sent.max_nodes, sent.depth], ['menu', 300, 4]);
    assert.equal(read.result.ax_snapshot.root, 'menu');
    assert.deepEqual([...executor.axRefs], [MENU, `${MENU}.2`, `${MENU}.2.0`]);
    // Refs outside the subtree are no longer current.
    await assert.rejects(executor.execute([{ action: 'click_element', ref: 'ax:77:0.0' }]),
      error => isPreAdmissionRefusal(error) && error.code === 'stale_ref');
    const [opened] = await executor.execute([{ action: 'show_menu_element', ref: `${MENU}.2` }]);
    assert.equal(opened.result.ax_action.path, 'ax_show_menu');
    assert.equal(host.requests.filter(request => request.action === 'ax_action').at(-1).params.action, 'show_menu');
    // A ref root must come from the latest snapshot.
    await executor.execute([{ action: 'ax_snapshot', root: `${MENU}.2` }]);
    assert.equal(host.requests.filter(request => request.action === 'ax_snapshot').at(-1).params.root, `${MENU}.2`);
  } finally { await executor.close(); }
});

test('invalid roots and caps are refused before admission', async () => {
  const { executor, host } = await executorFor();
  try {
    for (const action of [{ action: 'ax_snapshot', root: 'window' }, { action: 'ax_snapshot', max_nodes: 0 },
      { action: 'ax_snapshot', max_nodes: 1501 }, { action: 'ax_snapshot', root: 'menu', menu_extras: true },
      { action: 'ax_snapshot', root: 'ax:77:0.9' }]) {
      await assert.rejects(executor.execute([action]), error => isPreAdmissionRefusal(error), JSON.stringify(action));
    }
    assert.equal(host.requests.some(request => request.action === 'ax_snapshot'), false);
  } finally { await executor.close(); }
});

test('an unavailable root is a per-call error that keeps the lane', async () => {
  let refuse = true;
  const { executor } = await executorFor((request, response) =>
    request.action === 'ax_snapshot' && refuse ? refusal(request, 'accessibility_root_unavailable') : response);
  try {
    const responses = await executor.execute([{ action: 'ax_snapshot', root: 'menu' }, { action: 'screenshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.code, 'accessibility_root_unavailable');
    assert.equal(executor.failed, undefined);
    refuse = false;
    const [read] = await executor.execute([{ action: 'ax_snapshot' }]);
    assert.equal(read.result.ax_snapshot.node_count, 2);
  } finally { await executor.close(); }
});
