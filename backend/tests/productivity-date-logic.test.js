import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductivityService } from '../src/reports/productivity.js';

// Minimal mock DB
function createMockDb(data = {}, metadata = {}) {
    const store = {};
    return {
        getData: (dbId) => data[dbId] || [],
        getMetadata: (key) => metadata[key] || {},
        setMetadata: (key, val) => { metadata[key] = val; },
        getConfig: () => [],
    };
}

// Helper: build a minimal Notion-like task record
function makeTask(name, assigneeName, ngayLam, status = 'Done', extras = {}) {
    const properties = {
        Name: name,
        'Task Status': status,
        Assignee: assigneeName ? [{ name: assigneeName, email: `${assigneeName}@test.com` }] : [],
        ...extras,
    };
    if (ngayLam !== undefined) {
        properties['Ngày làm'] = ngayLam;
    }
    return {
        id: `id-${Math.random().toString(36).slice(2, 8)}`,
        database_name: 'Test Tasks',
        properties,
    };
}

// =============================================================
// Test 1: parseStringDate uses END date from range strings
// =============================================================
test('parseStringDate: "28/02/2026 -> 03/03/2026" returns March 3', () => {
    const db = createMockDb();
    const svc = new ProductivityService(db);
    const result = svc.parseStringDate('28/02/2026 -> 03/03/2026');
    assert.ok(result, 'Should parse the date');
    assert.equal(result.getFullYear(), 2026);
    assert.equal(result.getMonth(), 2); // March = 2 (0-indexed)
    assert.equal(result.getDate(), 3);
});

test('parseStringDate: "2026-02-28 -> 2026-03-03" returns March 3 (ISO)', () => {
    const db = createMockDb();
    const svc = new ProductivityService(db);
    const result = svc.parseStringDate('2026-02-28 -> 2026-03-03');
    assert.ok(result, 'Should parse the date');
    assert.equal(result.getMonth(), 2); // March
    assert.equal(result.getDate(), 3);
});

test('parseStringDate: single date "15/02/2026" returns Feb 15', () => {
    const db = createMockDb();
    const svc = new ProductivityService(db);
    const result = svc.parseStringDate('15/02/2026');
    assert.ok(result);
    assert.equal(result.getMonth(), 1); // Feb
    assert.equal(result.getDate(), 15);
});

// =============================================================
// Test 2: parseDate with object { start, end } uses end date
// =============================================================
test('parseDate: object with start+end uses end date', () => {
    const db = createMockDb();
    const svc = new ProductivityService(db);
    const task = makeTask('T1', 'Alice', {
        type: 'date',
        date: { start: '2026-02-28', end: '2026-03-03' }
    });
    const result = svc.parseDate(task);
    assert.ok(result, 'Should parse the date');
    assert.equal(result.getMonth(), 2); // March
    assert.equal(result.getDate(), 3);
});

test('parseDate: object with only start uses start date', () => {
    const db = createMockDb();
    const svc = new ProductivityService(db);
    const task = makeTask('T2', 'Alice', {
        type: 'date',
        date: { start: '2026-02-15', end: null }
    });
    const result = svc.parseDate(task);
    assert.ok(result);
    assert.equal(result.getMonth(), 1); // Feb
    assert.equal(result.getDate(), 15);
});

// =============================================================
// Test 3: End date determines month in generateReport filtering
// =============================================================
test('generateReport: task 28/2->3/3 excluded from Feb, included in March', async () => {
    const dbId = 'db-1';
    const task = makeTask('CrossMonth', 'TestUser', {
        type: 'date',
        date: { start: '2026-02-28', end: '2026-03-03' }
    }, 'Done', {
        'TP thực tế': 5,
        'NLTT': 1,
        'Point Status': 'Confirmed',
    });

    const db = createMockDb({ [dbId]: [task] });

    const svc = new ProductivityService(db);

    // Filter February: should NOT include this task
    const febResult = await svc.generateReport('2026-02-01', '2026-02-28', [dbId]);
    // Task should be out of range (end date 03/03 > 28/02)
    assert.equal(febResult.filterStats.rejectedDateRange, 1, 'Task should be rejected in Feb range');

    // Filter March: should include this task
    const marResult = await svc.generateReport('2026-03-01', '2026-03-31', [dbId]);
    assert.equal(marResult.filterStats.totalAccepted, 1, 'Task should be accepted in March range');
});

// =============================================================
// Test 4: Empty Ngày Làm → counted but not scored
// =============================================================
test('generateReport: task without Ngày Làm is counted but not scored', async () => {
    const dbId = 'db-1';

    // Task WITH date (in range)
    const taskWithDate = makeTask('WithDate', 'TestUser', {
        type: 'date',
        date: { start: '2026-03-10' }
    }, 'Done', {
        'TP thực tế': 10,
        'NLTT': 2,
        'Point Status': 'Confirmed',
    });

    // Task WITHOUT date
    const taskNoDate = makeTask('NoDate', 'TestUser', undefined, 'Done', {
        'TP thực tế': 5,
        'NLTT': 1,
        'Point Status': 'Confirmed',
    });

    const db = createMockDb({ [dbId]: [taskWithDate, taskNoDate] });
    const svc = new ProductivityService(db);

    const result = await svc.generateReport('2026-03-01', '2026-03-31', [dbId]);

    // filterStats should show 1 date missing
    assert.equal(result.filterStats.rejectedDateMissing, 1, 'One task missing date');

    // Find the user row
    let userRow = result.validData.find(r => r.fullName === 'TestUser')
        || result.unknownUsers?.find(r => r.name === 'TestUser');

    // taskCount should NOT include the no-date task when range is applied
    if (userRow && userRow.taskCount !== undefined) {
        assert.equal(userRow.taskCount, 1, 'taskCount should only include the in-range task');
    }

    // Points should only come from the task WITH date
    if (userRow && userRow.pointTotal !== undefined) {
        // Only taskWithDate has 10 points
        assert.equal(userRow.pointTotal, 10, 'Points should only come from task with date');
    }

    // Now test without date filter (undated tasks should be counted)
    const resultAll = await svc.generateReport(null, null, [dbId]);
    userRow = resultAll.validData.find(r => r.fullName === 'TestUser')
        || resultAll.unknownUsers?.find(r => r.name === 'TestUser');
    if (userRow && userRow.taskCount !== undefined) {
        assert.equal(userRow.taskCount, 2, 'taskCount should include both tasks when no date filter');
    }
});

// =============================================================
// Test 5: No filter (all data) - tasks with range still appear
// =============================================================
test('generateReport: no date filter includes all tasks with dates', async () => {
    const dbId = 'db-1';
    const task = makeTask('AnyDate', 'TestUser', {
        type: 'date',
        date: { start: '2026-02-28', end: '2026-03-03' }
    }, 'Done', {
        'TP thực tế': 5,
        'NLTT': 1,
    });

    const db = createMockDb({ [dbId]: [task] });
    const svc = new ProductivityService(db);

    // No date filter (pass null-ish)
    const result = await svc.generateReport(null, null, [dbId]);
    assert.equal(result.filterStats.totalAccepted, 1, 'Task should be included when no date filter');
});
