import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, topSeverity } from '../../src/triage/route.ts';

const triage = (benign: number, minor: number, critical: number, fixable: number) => ({ severity: { benign, minor, critical }, fixable });

test('the guard blocks before Decisions counts', () => {
    for (const verdict of ['flagged', 'unchecked'] as const) {
        const decision = decide(verdict, triage(0.9, 0.05, 0.05, 0.9));
        assert.equal(decision.route, 'needs_human');
        assert.equal(decision.priority, 'high');
    }
});

test('no Decisions answer escalates: high, needs_human', () => {
    assert.deepEqual(
        { ...decide('clean', undefined), reason: '' },
        { route: 'needs_human', priority: 'high', reason: '' },
    );
});

test('benign → low, done, whatever fixable says', () => {
    const decision = decide('clean', triage(0.88, 0.09, 0.03, 0.95));
    assert.equal(decision.route, 'done');
    assert.equal(decision.priority, 'low');
    assert.equal(decision.severity, 'benign');
});

test('critical and fixable → factory, high', () => {
    const decision = decide('clean', triage(0.02, 0.14, 0.84, 0.93));
    assert.equal(decision.route, 'factory');
    assert.equal(decision.priority, 'high');
});

test('minor and fixable → factory, medium; examples count as clean', () => {
    const decision = decide('examples', triage(0.04, 0.79, 0.17, 0.6));
    assert.equal(decision.route, 'factory');
    assert.equal(decision.priority, 'medium');
});

test('not fixable → needs_human with the severity priority', () => {
    assert.deepEqual(
        { ...decide('clean', triage(0.06, 0.61, 0.33, 0.12)), reason: '' },
        { route: 'needs_human', priority: 'medium', severity: 'minor', reason: '' },
    );
    const critical = decide('clean', triage(0.01, 0.1, 0.89, 0.59));
    assert.equal(critical.route, 'needs_human');
    assert.equal(critical.priority, 'high');
});

test('ties go to the more severe option', () => {
    assert.equal(topSeverity({ benign: 0.4, minor: 0.4, critical: 0.2 }), 'minor');
    assert.equal(topSeverity({ benign: 0.2, minor: 0.4, critical: 0.4 }), 'critical');
    assert.equal(topSeverity({ benign: 0.5, minor: 0.3, critical: 0.2 }), 'benign');
});
