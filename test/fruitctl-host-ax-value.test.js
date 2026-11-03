// SPDX-License-Identifier: MIT
// #161 broker side of set_element_value and step_element: admission, the
// ax_value request, readback and typed refusals. Mock SSH Host only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { isPreAdmissionRefusal, requireNativeActions, INPUT_ACTIONS } from '../lib/mcp/capabilities.js';
import { validateActionParameters } from '../tools/index.js';
import { hostOnlyProfile, hostSequence, refusal, snapshot } from './host-mock.mjs';

const LOGIC = 'com.apple.logic10';
const REF = 'ax:77:0.0';

function valueHost({ health = {}, answer, capabilities = ['input', 'capture_scope', 'ax_value'] } = {}) {
  return hostSequence({ capabilities, health: { input_enabled: true, input_post_permission: true,
    operator_input_monitor: 'event_tap', ...health }, alter(request, response) {
    if (request.action !== 'ax_value' || !response.success) return response;
    const custom = answer?.(request);
    if (custom && (custom.success === false || custom.result?.lease_lost)) return custom;
    const { params } = request;
    const steps = params.operation === 'set' ? 1 : params.steps;
    response.result.ax_value = { ref: params.ref, generation: params.generation, operation: params.operation,
      owner: 'target', role: 'AXSlider', value_before: '18', value_after: params.operation === 'set'
        ? String(params.value) : '20', steps, steps_performed: steps, verified: true, ax_result: 'performed',
      target_bundle_id: params.target.bundle_id, ...custom };
    return response;
  } });
}

async function executorFor(options = {}, profile = hostOnlyProfile({ hostInput: { applications: [LOGIC] } })) {
  const hosts = valueHost(options);
  const executor = await nativeFactory(profile, { hostSpawn: hosts.spawnImpl });
  return { executor, host: hosts.attachments[0] };
}

const sent = host => host.requests.filter(request => request.action === 'ax_value').map(request => request.params);

test('value actions appear only with hostInput and a Host that offers ax_value', async () => {
  for (const [profile, capabilities, expected] of [
    [hostOnlyProfile({ hostInput: { applications: [LOGIC] } }), ['input', 'ax_value'], true],
    [hostOnlyProfile({ hostInput: { applications: [LOGIC] } }), ['input'], false],
    [hostOnlyProfile(), ['input', 'ax_value'], false]]) {
    const { executor, host } = await executorFor({ capabilities }, profile);
    try {
      assert.equal(executor.capabilities.actions.includes('set_element_value'), expected);
      assert.equal(executor.capabilities.actions.includes('step_element'), expected);
      if (!expected) {
        await executor.execute([{ action: 'ax_snapshot' }]);
        await assert.rejects(executor.execute([{ action: 'set_element_value', ref: REF, value: 1 }]),
          error => isPreAdmissionRefusal(error) && error.code === 'unsupported_on_route');
        assert.equal(sent(host).length, 0);
      }
    } finally { await executor.close(); }
  }
  // The raw VNC route never forwards them, and they count as input.
  for (const action of ['set_element_value', 'step_element']) {
    assert.throws(() => requireNativeActions([{ action }], { known: false, actions: [] }),
      error => error.code === 'unsupported_on_route');
    assert.equal(INPUT_ACTIONS.has(action), true);
  }
});

test('set_element_value and step_element send one ax_value request and report the readback', async () => {
  const { executor, host } = await executorFor();
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    const [set] = await executor.execute([{ action: 'set_element_value', ref: REF, value: 40 }]);
    const [first] = sent(host);
    assert.deepEqual(first, { session_id: first.session_id, display_id: 42, capture_backend: 'owned_sck',
      generation: 4, ref: REF, operation: 'set', target: { bundle_id: LOGIC }, operator_input: 'yield',
      operator_idle_ms: 1000, value: 40 });
    assert.equal(set.result.ax_value.value_before, '18');
    assert.equal(set.result.ax_value.value_after, '40');
    assert.equal(set.result.ax_value.verified, true);
    assert.equal(set.result.ax_value.owner, 'target');
    assert.equal(set.result.detail, `set_element_value ${REF}: 1 AX calls, verified true`);
    // The journalled detail carries no value.
    assert.doesNotMatch(set.result.detail, /40|18/);
    const [down] = await executor.execute([{ action: 'step_element', ref: REF, steps: -3, app: LOGIC }]);
    const second = sent(host)[1];
    assert.deepEqual([second.operation, second.steps, second.value], ['decrement', 3, undefined]);
    assert.equal(down.result.ax_value.steps_performed, 3);
    await executor.execute([{ action: 'set_element_value', ref: REF, value: 'Orch' }]);
    assert.equal(sent(host)[2].value, 'Orch');
  } finally { await executor.close(); }
});

test('shape, policy and stale refs are refused before admission', async () => {
  const { executor, host } = await executorFor();
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    for (const [action, code] of [
      [{ action: 'set_element_value', ref: 'ax:77:0.5', value: 1 }, 'stale_ref'],
      [{ action: 'set_element_value', ref: REF, value: 1, app: 'com.cmuxterm.app' }, 'input_target_not_allowed'],
      [{ action: 'set_element_value', ref: REF, value: 'bell\u0007' }, 'invalid_input'],
      [{ action: 'set_element_value', ref: REF, value: 'x'.repeat(257) }, 'invalid_input'],
      [{ action: 'set_element_value', ref: REF, value: Number.NaN }, 'invalid_input'],
      [{ action: 'set_element_value', ref: REF, value: { raw: 1 } }, 'invalid_input'],
      [{ action: 'set_element_value', ref: REF, value: 1, steps: 2 }, 'invalid_input'],
      [{ action: 'step_element', ref: REF, steps: 0 }, 'invalid_input'],
      [{ action: 'step_element', ref: REF, steps: 11 }, 'invalid_input'],
      [{ action: 'step_element', ref: REF, steps: '3' }, 'invalid_input'],
      [{ action: 'step_element', ref: REF, steps: 1, value: 2 }, 'invalid_input'],
    ]) {
      await assert.rejects(executor.execute([action]), error => isPreAdmissionRefusal(error) && error.code === code,
        JSON.stringify(action));
    }
    assert.equal(sent(host).length, 0);
  } finally { await executor.close(); }
  const disabled = await executorFor({ health: { input_enabled: false } });
  try {
    await disabled.executor.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(disabled.executor.execute([{ action: 'step_element', ref: REF, steps: 1 }]),
      error => isPreAdmissionRefusal(error) && error.code === 'input_disabled');
  } finally { await disabled.executor.close(); }
  const stopped = await executorFor({ health: { human_stop_latched: true } });
  try {
    await assert.rejects(stopped.executor.execute([{ action: 'step_element', ref: REF, steps: 1 }]),
      error => isPreAdmissionRefusal(error));
  } finally { await stopped.executor.close(); }
});

test('a Host refusal is a per-call error that keeps the lane', async () => {
  let code = 'input_target_mismatch';
  const { executor } = await executorFor({ answer: request => code ? refusal(request, code) : undefined });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    for (const reason of ['input_target_mismatch', 'ax_action_unsupported', 'secure_input_active',
      'operator_input_detected', 'operator_input_monitor_unavailable', 'stale_ref', 'ax_unreachable',
      'human_consent_required']) {
      code = reason;
      const responses = await executor.execute([{ action: 'set_element_value', ref: REF, value: 4 },
        { action: 'screenshot' }]);
      assert.equal(responses.length, 1, reason);
      assert.equal(responses[0].error.data.code, reason);
      assert.equal(executor.failed, undefined);
    }
    code = undefined;
    const [done] = await executor.execute([{ action: 'set_element_value', ref: REF, value: 4 }]);
    assert.equal(done.result.ax_value.verified, true);
  } finally { await executor.close(); }
});

test('a step stopped part way names what ran; an unverified value is a result', async () => {
  let custom;
  const { executor } = await executorFor({ answer: () => custom });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    custom = { steps_performed: 2, verified: true, stop_reason: 'operator_input_detected' };
    const [stopped] = await executor.execute([{ action: 'step_element', ref: REF, steps: 5 }]);
    assert.equal(stopped.error.data.code, 'input_interrupted');
    assert.equal(stopped.error.data.reason, 'operator_input_detected');
    assert.equal(stopped.error.data.steps_performed, 2);
    assert.equal(executor.failed, undefined);
    // An unverified value may still have acted: it ends the batch.
    custom = { value_after: '18', verified: false, stop_reason: 'value_unverified' };
    const responses = await executor.execute([{ action: 'set_element_value', ref: REF, value: 40 },
      { action: 'screenshot' }]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.data.reason, 'value_unverified');
    assert.equal(responses[0].error.data.verified, false);
    assert.equal(responses[0].error.data.value_after, '18');
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('a receipt for another ref or owner retires the executor', async () => {
  for (const custom of [{ ref: 'ax:77:0' }, { owner: 'cmux' }, { steps_performed: 3 }, { target_bundle_id: 'x' },
    { steps_performed: 0 }, { verified: false }, { verified: true, stop_reason: 'value_unverified' },
    { steps: 2 }]) {
    const { executor } = await executorFor({ answer: () => custom });
    try {
      await executor.execute([{ action: 'ax_snapshot' }]);
      await assert.rejects(executor.execute([{ action: 'set_element_value', ref: REF, value: 1 }]),
        /Invalid host-helper ax_value receipt/, JSON.stringify(custom));
    } finally { await executor.close(); }
  }
});

test('the MCP schema takes value and steps only on their own actions', () => {
  assert.doesNotThrow(() => validateActionParameters({ action: 'set_element_value', ref: REF, value: '4' }));
  assert.doesNotThrow(() => validateActionParameters({ action: 'step_element', ref: REF, steps: -2, app: LOGIC }));
  assert.throws(() => validateActionParameters({ action: 'set_element_value', ref: REF }), /Missing value/);
  assert.throws(() => validateActionParameters({ action: 'step_element', ref: REF }), /Missing steps/);
  assert.throws(() => validateActionParameters({ action: 'step_element', ref: REF, steps: 0 }), /must not be 0/);
  assert.throws(() => validateActionParameters({ action: 'click_element', ref: REF, value: 1 }), /value applies/);
  assert.throws(() => validateActionParameters({ action: 'set_element_value', ref: REF, value: 1, steps: 1 }),
    /steps applies/);
  assert.throws(() => validateActionParameters({ action: 'set_element_value', ref: 'secret', value: 1 }),
    /element ref/);
  assert.throws(() => validateActionParameters({ action: 'set_element_value', ref: REF, value: 1, window: 'x' }),
    /window applies/);
});

test('a lease lost after an AX call retires the lane with the count', async () => {
  const { executor } = await executorFor({ answer: request => ({ success: true, id: request.id,
    result: { instance_id: 'resident-test-app', session_id: request.params.session_id, lease_lost: true,
      ax_value: { steps_performed: 2 } } }) });
  try {
    await executor.execute([{ action: 'ax_snapshot' }]);
    await assert.rejects(executor.execute([{ action: 'step_element', ref: REF, steps: 4 }]),
      /ax_value lease ended after 2 AX calls/);
    assert.ok(executor.failed);
  } finally { await executor.close(); }
});

// #181: a readout beside a control whose value is not settable. The mock matches
// neo evidence: a readout has no value, its figure is in the label, the slider
// holds a raw value, and a subtree read keeps refs under the root's own path.
const STRIP = 'ax:77:0.0';
const READOUT = `${STRIP}.1`;
const FADER = `${STRIP}.0`;
const NAME = `${STRIP}.2`;
const WHOLE = { pid: 77, ref: 'ax:77:0', bundle_id: LOGIC, name: 'Logic Pro' };

function stripNodes({ shown, raw, role, frame, readout = true, stripName = 'Bass Grit', slider = true }) {
  const root = { ref: STRIP, parent: null, depth: 0, role: 'AXGroup', frame: null };
  return [root, ...(slider ? [{ ref: FADER, parent: STRIP, depth: 1, role: 'AXSlider', label: 'volume fader', value: raw,
    frame: { x: 100, y: 100, width: 20, height: 100 } }] : []),
    ...(readout ? [{ ref: READOUT, parent: STRIP, depth: 1, role, frame,
      label: shown === undefined ? 'volume fader level' : `volume fader level, ${shown}` }] : []),
    { ref: NAME, parent: STRIP, depth: 1, role: 'AXTextField', label: 'name', value: stripName,
      frame: { x: 100, y: 20, width: 40, height: 20 } }];
}

const readoutHost = ({ shown = '-6.0 dB', raw = '113', role = 'AXTextField', answer, afterCommit = {},
  firstFrame = { x: 100, y: 50, width: 40, height: 20 }, liveFrame = { x: 200, y: 60, width: 40, height: 20 },
  bundle = LOGIC, readRefusal, shape = {} } = {}) => {
  let committed = false, reads = 0;
  return hostSequence({ capabilities: ['input', 'capture_scope', 'ax_value'], health: { input_enabled: true,
    input_post_permission: true, operator_input_monitor: 'event_tap' }, alter(request, response) {
    if (request.action === 'input' && response.success) {
      const custom = answer?.(request);
      if (custom) return custom;
      if (request.params.kind === 'key') committed = true;
      response.result.input = { kind: request.params.kind, posted_events: 2, released_events: 0, completed: true,
        operator_input_events: 0, operator_input_monitor: 'event_tap',
        target_bundle_id: request.params.target.bundle_id };
    }
    if (request.action === 'ax_snapshot' && response.success) {
      reads += 1;
      if (committed && readRefusal) return refusal(request, readRefusal);
      const nodes = reads === 1 ? stripNodes({ shown: '0.0 dB', raw: '90', role, frame: firstFrame, ...shape })
        : committed ? stripNodes({ shown, raw, role, frame: liveFrame, ...shape, ...afterCommit })
          : stripNodes({ shown: '0.0 dB', raw: '90', role, frame: liveFrame, ...shape });
      response.result.ax_snapshot = snapshot({ generation: 77, node_count: nodes.length, nodes,
        applications: [{ ...WHOLE, bundle_id: bundle }] });
    }
    return response;
  } });
};

async function entryExecutor(options) {
  const hosts = readoutHost(options);
  const executor = await nativeFactory(hostOnlyProfile({ hostInput: { applications: [LOGIC] } }),
    { hostSpawn: hosts.spawnImpl });
  await executor.execute([{ action: 'ax_snapshot' }]);
  return { executor, host: hosts.attachments[0] };
}

const inputs = host => host.requests.filter(request => request.action === 'input').map(request => request.params);
const captures = host => host.requests.filter(request => request.action === 'capture').length;

test('enter_element_value clicks the readout where it is now, then verifies the label figure', async () => {
  const { executor, host } = await entryExecutor();
  try {
    const before = captures(host);
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 }]);
    assert.equal(response.error, undefined);
    const { ax_value: value } = response.result;
    assert.equal(value.verified, true);
    assert.equal(value.slider_moved, true);
    assert.equal(value.value_after, '-6.0 dB');
    assert.equal(value.value_requested, '-6');
    assert.deepEqual([value.slider_ref, value.slider_before, value.slider_after], [FADER, '90', '113']);
    const sent = inputs(host);
    assert.deepEqual(sent.map(params => params.kind), ['double_click', 'type', 'key']);
    // The read just before acting moved the readout from x 100 to x 200.
    const scale = 512 / executor.native.display.width;
    assert.ok(sent[0].x >= 200 * scale && sent[0].x < 240 * scale, `x ${sent[0].x}`);
    assert.equal(sent[1].text, '-6');
    assert.deepEqual(sent[2].keys, ['return']);
    // One frame, on the last step only.
    assert.equal(captures(host) - before, 1);
    // Both reads ask for the strip, because the Host keeps refs under its root.
    const reads = host.requests.filter(request => request.action === 'ax_snapshot').slice(-2).map(request => request.params);
    for (const read of reads) assert.deepEqual([read.root, read.depth, read.max_nodes], [STRIP, 1, 256]);
    assert.ok(executor.axRefs.has(READOUT));
  } finally { await executor.close(); }
});

test('a slider that moved does not verify an entry the readout cannot show', async () => {
  const { executor } = await entryExecutor({ afterCommit: { shown: undefined } });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 }]);
    assert.equal(response.error.data.reason, 'value_not_verified');
    assert.equal(response.error.data.verified, false);
    assert.equal(response.error.data.slider_moved, true);
    assert.equal(response.error.data.value_after, null);
  } finally { await executor.close(); }
});

test('a strip name is not a readout, even a numeric one', async () => {
  // Its label does not start with the fader's, so the fader is not its slider.
  for (const [stripName, slider] of [['Bass Grit', true], ['808', true], ['808', false]]) {
    const { executor, host } = await entryExecutor({ shape: { stripName, slider } });
    try {
      const [response] = await executor.execute([{ action: 'enter_element_value', ref: NAME, value: -6 }]);
      assert.equal(response.error.data.code, 'ax_action_unsupported', stripName);
      assert.deepEqual(inputs(host), []);
    } finally { await executor.close(); }
  }
});

test('the typing step stops once its time to ask again runs out', async () => {
  const { executor, host } = await entryExecutor({ answer: request =>
    (request.params.kind === 'type' ? refusal(request, 'input_focus_unavailable') : undefined) });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 }]);
    assert.equal(response.error.data.code, 'input_focus_unavailable');
    assert.equal(response.error.data.entry_step, 'type');
    assert.ok(inputs(host).filter(params => params.kind === 'type').length <= 8);
    assert.equal(inputs(host).some(params => params.kind === 'key'), false);
  } finally { await executor.close(); }
});

test('the typing step asks again while the readout is still opening', async () => {
  let refusals = 2;
  const { executor, host } = await entryExecutor({ answer: request =>
    (request.params.kind === 'type' && refusals-- > 0 ? refusal(request, 'input_focus_unavailable') : undefined) });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 }]);
    assert.equal(response.error, undefined);
    assert.deepEqual(inputs(host).map(params => params.kind), ['double_click', 'type', 'type', 'type', 'key']);
  } finally { await executor.close(); }
});

test('enter_element_value reports a readout that shows another number', async () => {
  const { executor } = await entryExecutor({ shown: '0.0 dB', raw: '90' });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: '-6' }]);
    assert.equal(response.error.data.code, 'input_interrupted');
    assert.equal(response.error.data.reason, 'value_not_verified');
    assert.equal(response.error.data.value_after, '0.0 dB');
    assert.equal(response.error.data.verified, false);
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('enter_element_value reads the rounding, unit and formats a readout can show', async () => {
  for (const [shown, entered, verified] of [['-6.3', '-6.25', true], ['-6.0 dB', '-6', true], ['−6.0 dB', '-6', true],
    ['1000 Hz', '1000', true], ['6.0', '-6', false], ['-6.5', '-6', false], ['-6,5 dB', '-6', false],
    ['3.2.1.1', '3.2', false], ['1,000 Hz', '1', false], ['dB -6.0', '-6', false], ['-∞ dB', '-6', false]]) {
    const { executor } = await entryExecutor({ shown });
    try {
      const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: entered }]);
      assert.equal(response.error === undefined, verified, `${shown} for ${entered}`);
    } finally { await executor.close(); }
  }
});

test('enter_element_value keeps a read refusal after the entry as its reason', async () => {
  const { executor } = await entryExecutor({ readRefusal: 'accessibility_root_unavailable' });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 }]);
    assert.equal(response.error.data.code, 'input_interrupted');
    assert.equal(response.error.data.reason, 'accessibility_root_unavailable');
    assert.equal(executor.failed, undefined);
  } finally { await executor.close(); }
});

test('enter_element_value names the step a refusal stopped', async () => {
  for (const [kind, step, kinds] of [['double_click', 'open', ['double_click']], ['type', 'type', ['double_click', 'type']],
    ['key', 'commit', ['double_click', 'type', 'key']]]) {
    const { executor, host } = await entryExecutor({ answer: request => (request.params.kind === kind
      ? refusal(request, 'input_target_mismatch') : undefined) });
    try {
      const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: '-6' }]);
      assert.equal(response.error.data.code, 'input_target_mismatch');
      assert.equal(response.error.data.entry_step, step);
      assert.deepEqual(inputs(host).map(params => params.kind), kinds);
    } finally { await executor.close(); }
  }
});

test('a second entry in a batch whose ref the first read dropped is a per-call stale_ref', async () => {
  const { executor, host } = await entryExecutor({ liveFrame: { x: 200, y: 60, width: 40, height: 20 } });
  try {
    executor.axEntryNodes.set('ax:77:0.9.1', { parent: 'ax:77:0.9', bundle: LOGIC });
    executor.axRefs.add('ax:77:0.9.1');
    const responses = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: -6 },
      { action: 'enter_element_value', ref: 'ax:77:0.9.1', value: -6 }]);
    assert.equal(responses.length, 2);
    assert.equal(responses[1].error.data.code, 'stale_ref');
    assert.equal(executor.failed, undefined);
    assert.equal(inputs(host).length, 3);
  } finally { await executor.close(); }
});

test('enter_element_value refuses before admission what it cannot type or open', async () => {
  const { executor, host } = await entryExecutor();
  try {
    for (const value of ['abc', '1e5', '-6 dB', '12345678901234567', '-', 1e21]) {
      await assert.rejects(executor.execute([{ action: 'enter_element_value', ref: READOUT, value }]),
        error => isPreAdmissionRefusal(error) && error.code === 'invalid_input');
    }
    assert.deepEqual(inputs(host), []);
  } finally { await executor.close(); }
  const slider = await entryExecutor({ role: 'AXSlider' });
  try {
    await assert.rejects(slider.executor.execute([{ action: 'enter_element_value', ref: READOUT, value: 1 }]),
      error => isPreAdmissionRefusal(error) && error.code === 'ax_action_unsupported');
  } finally { await slider.executor.close(); }
  const other = await entryExecutor({ bundle: 'com.example.other' });
  try {
    await assert.rejects(other.executor.execute([{ action: 'enter_element_value', ref: READOUT, value: 1 }]),
      error => isPreAdmissionRefusal(error) && error.code === 'input_target_mismatch');
    assert.deepEqual(inputs(other.host), []);
  } finally { await other.executor.close(); }
});

test('enter_element_value does not click a readout with no frame on screen', async () => {
  const { executor, host } = await entryExecutor({ firstFrame: { x: 100, y: 50, width: 40, height: 20 }, liveFrame: null });
  try {
    const [response] = await executor.execute([{ action: 'enter_element_value', ref: READOUT, value: 1 }]);
    assert.equal(response.error.data.code, 'ax_action_unsupported');
    assert.match(response.error.message, /frame/);
    assert.deepEqual(inputs(host), []);
  } finally { await executor.close(); }
});

test('the tool schema takes value for enter_element_value and needs a ref', () => {
  assert.doesNotThrow(() => validateActionParameters({ action: 'enter_element_value', ref: READOUT, value: -6 }));
  assert.throws(() => validateActionParameters({ action: 'enter_element_value', value: -6 }), /Missing ref/);
  assert.throws(() => validateActionParameters({ action: 'enter_element_value', ref: READOUT }), /Missing value/);
});
