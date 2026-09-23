const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const testScript = script.slice(0, script.indexOf('  // ---------- init ----------')) + `
  globalThis.testApi = {
    state, addTask, getDisplayTasks, getTaskById, setStatus, setTaskToTrash,
    updateTaskFields, updateTaskHistoryTimes, deleteTask, deleteRecurringSeries,
    emptyTrash, normalizeRecurringTasks, loadTasks, loadSeries, saveTasks,
    dateKey, recurrenceDates, startOfDay, endOfDay, nextRecurrenceDate
  };
})();`;
const storage = new Map();
const context = {
  console,
  Date,
  Set,
  Math,
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
  },
  document: { getElementById() { return { addEventListener() {} }; } },
};
vm.createContext(context);
vm.runInContext(testScript, context, { filename: htmlPath });
const api = context.testApi;
const { state } = api;
const at = (year, month, day) => new Date(year, month - 1, day, 12).toISOString();
const range = (year, month, day) => [api.startOfDay(at(year, month, day)), api.endOfDay(at(year, month, day))];
const occurrences = (year, month, day) => api.getDisplayTasks(range(year, month, day))
  .filter(task => api.dateKey(task.occurrenceDate || task.createdAt) === `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
const seriesId = 'daily-test';
const root = api.addTask('Việc gốc', 'todo', at(2026, 9, 24), seriesId, false);
Object.assign(root, {
  recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24),
  recurrenceInitialStatus: 'todo', occurrenceDate: at(2026, 9, 24),
});
state.series[seriesId] = {
  title: 'Việc gốc', description: '', rule: 'daily', start: at(2026, 9, 24),
  anchorDate: '2026-09-24', initialStatus: 'todo', excludedDates: [],
};
api.saveTasks();

let day25 = occurrences(2026, 9, 25).find(t => t.isVirtual);
assert.ok(day25, 'ngày kế tiếp là bản ảo');
assert.equal(state.tasks.length, 1, 'xem bản ảo không tạo bản ghi thật');
assert.equal(api.setStatus(day25.id, 'todo'), true);
assert.equal(state.tasks.length, 1, 'chọn lại trạng thái hiện tại không ghi dữ liệu');

assert.equal(api.setStatus(day25.id, 'inprogress'), true);
assert.equal(state.tasks.length, 2, 'chỉ ngày đổi trạng thái được materialize');
assert.equal(state.tasks.find(t => t.occurrenceDate === day25.occurrenceDate).status, 'inprogress');
assert.equal(occurrences(2026, 9, 26).find(t => t.isVirtual).status, 'todo');
api.updateTaskFields(day25.id, 'Việc riêng ngày 25', 'Ghi chú riêng', at(2026, 9, 25));
assert.equal(state.tasks.length, 2);
assert.equal(occurrences(2026, 9, 26).find(t => t.isVirtual).title, 'Việc gốc');
assert.equal(occurrences(2026, 9, 26).find(t => t.isVirtual).reminderAt, null);
assert.equal(occurrences(2026, 9, 26).find(t => t.isVirtual).history.length, 1);

api.setTaskToTrash(day25.id);
assert.equal(occurrences(2026, 9, 25).find(t => t.status === 'trash').occurrenceDate, at(2026, 9, 25));
assert.equal(occurrences(2026, 9, 24).find(t => t.status === 'trash'), undefined);
api.emptyTrash();
assert.equal(occurrences(2026, 9, 25).filter(t => t.recurrenceId === seriesId).length, 0);
assert.equal(state.tasks.length, 1, 'xóa giữa chuỗi không tạo anchor mới');
assert.equal(state.series[seriesId].anchorDate, '2026-09-24');
assert.ok(occurrences(2026, 9, 26).find(t => t.isVirtual), 'chuỗi vẫn tiếp tục');

api.deleteTask(root.id);
assert.equal(state.series[seriesId].anchorDate, '2026-09-26');
assert.equal(state.tasks.length, 1, 'xóa bản gốc chỉ tạo một anchor kế tiếp');
assert.equal(api.dateKey(state.tasks[0].occurrenceDate), '2026-09-26');
assert.equal(occurrences(2026, 9, 24).filter(t => t.recurrenceId === seriesId).length, 0);

const year2027 = api.getDisplayTasks([api.startOfDay(at(2027, 1, 1)), api.endOfDay(at(2027, 12, 31))]);
assert.equal(year2027.filter(t => t.recurrenceId === seriesId && t.occurrenceDate.startsWith('2027-')).length, 365);
assert.equal(occurrences(2050, 6, 6).filter(t => t.recurrenceId === seriesId).length, 1);
assert.equal(state.tasks.length, 1, 'xem năm xa không sinh hàng nghìn bản ghi thật');
assert.equal(api.getTaskById('virtual:daily-test:2050-06-06').title, 'Việc gốc', 'có thể mở bản ảo theo ngày mà không cần cache');
assert.equal(api.getTaskById('virtual:daily-test:2026-09-25'), null, 'ngày đã xóa không quay lại');
assert.equal(Object.hasOwn(state, 'virtualTasks'), false, 'không giữ cache bản ảo tăng mãi trong bộ nhớ');
const day27 = occurrences(2026, 9, 27).find(t => t.isVirtual);
api.deleteTask(day27.id);
assert.equal(state.tasks.length, 1, 'xóa bản ảo giữa chuỗi không materialize ngày khác');
assert.equal(occurrences(2026, 9, 27).length, 0);
assert.equal(occurrences(2026, 9, 28).length, 1);

const anchor = state.tasks[0];
const changedHistoryAt = at(2026, 9, 27);
api.updateTaskHistoryTimes(anchor.id, [{ index: 0, iso: changedHistoryAt }]);
assert.equal(api.dateKey(anchor.occurrenceDate), '2026-09-26', 'sửa lịch sử không dời ngày lặp');

api.deleteRecurringSeries(seriesId);
assert.equal(occurrences(2050, 6, 6).length, 0);
assert.equal(state.tasks.length, 0);

const trashRoot = api.addTask('Xóa hàng loạt', 'trash', at(2026, 9, 24), 'trash-series', false);
Object.assign(trashRoot, { recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24), occurrenceDate: at(2026, 9, 24) });
const trash25 = api.addTask('Xóa hàng loạt', 'trash', at(2026, 9, 25), 'trash-series', false);
Object.assign(trash25, { recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24), occurrenceDate: at(2026, 9, 25) });
state.series['trash-series'] = {
  title: 'Xóa hàng loạt', description: '', rule: 'daily', start: at(2026, 9, 24),
  anchorDate: '2026-09-24', initialStatus: 'todo', excludedDates: [],
};
api.emptyTrash();
assert.equal(state.tasks.length, 1, 'dọn nhiều ngày lặp chỉ giữ một anchor mới');
assert.equal(api.dateKey(state.tasks[0].occurrenceDate), '2026-09-26');
assert.equal(occurrences(2026, 9, 24).length, 0);
assert.equal(occurrences(2026, 9, 25).length, 0);
api.deleteRecurringSeries('trash-series');

const monthly = {
  recurrenceId: 'monthly', recurrenceRule: 'monthly', recurrenceStart: at(2027, 1, 31),
};
assert.equal(api.dateKey(api.nextRecurrenceDate(at(2027, 1, 31), 'monthly', monthly.recurrenceStart)), '2027-02-28');
assert.equal(api.dateKey(api.nextRecurrenceDate(at(2027, 2, 28), 'monthly', monthly.recurrenceStart)), '2027-03-31');
assert.equal(api.dateKey(api.nextRecurrenceDate(at(2028, 2, 29), 'yearly', at(2028, 2, 29))), '2029-02-28');

state.tasks = [{
  id: 'legacy-root', title: 'Lịch cũ', description: '', status: 'todo',
  createdAt: at(2026, 9, 24), history: [{ at: at(2026, 9, 24), from: null, to: 'todo' }],
  recurrenceId: 'legacy', recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24),
  recurrenceExcludedDates: ['2026-09-25'], occurrenceDate: at(2026, 9, 24),
}];
state.series = {};
api.normalizeRecurringTasks();
assert.ok(state.series.legacy.excludedDates.includes('2026-09-25'));
assert.equal(occurrences(2026, 9, 25).filter(t => t.recurrenceId === 'legacy').length, 0);
assert.equal(api.loadTasks().length, 1);
assert.ok(api.loadSeries().legacy);

console.log('Recurrence regression tests: OK');
