// SPDX-License-Identifier: MIT
// #161 broker side of set_element_value and step_element: admission, the
// ax_value request, readback and typed refusals. Mock SSH Host only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFactory } from '../lib/broker/server.mjs';
import { isPreAdmissionRefusal, requireNativeActions, INPUT_ACTIONS } from '../lib/mcp/capabilities.js';
import { validateActionParameters } from '../tools/index.js';
import { hostOnlyProfile, hostSequence, refusal } from './host-mock.mjs';

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
