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
    emptyTrash, normalizeRecurringTasks, migrateLegacyData, loadTasks, loadSeries, saveTasks,
    dateKey, recurrenceDates, startOfDay, endOfDay, nextRecurrenceDate
  };
})();`;
const storage = new Map();
let blockedWriteKey = null;
let blockBackup = false;
const context = {
  console,
  Date,
  Set,
  Math,
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) {
      if (blockBackup && key.startsWith('tqm_migration_backup_v2_')) throw new Error('QuotaExceededError');
      if (key === blockedWriteKey) { blockedWriteKey = null; throw new Error('QuotaExceededError'); }
      storage.set(key, value);
    },
    removeItem(key) { storage.delete(key); },
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
root.createdAt = at(2026, 9, 20);
root.history[0].at = root.createdAt;
Object.assign(root, {
  recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24),
  recurrenceInitialStatus: 'todo', occurrenceDate: at(2026, 9, 24),
});
state.series[seriesId] = {
  title: 'Việc gốc', description: '', rule: 'daily', start: at(2026, 9, 24),
  createdAt: root.createdAt, anchorDate: '2026-09-24', initialStatus: 'todo', excludedDates: [],
};
api.saveTasks();

let day25 = occurrences(2026, 9, 25).find(t => t.isVirtual);
assert.ok(day25, 'ngày kế tiếp là bản ảo');
assert.equal(day25.createdAt, root.createdAt, 'bản ảo kế thừa ngày tạo của bản gốc');
assert.equal(day25.history[0].at, day25.occurrenceDate, 'hoạt động của bản ảo vẫn theo ngày riêng');
api.updateTaskHistoryTimes(root.id, [{index:0, iso:at(2026, 9, 21)}]);
assert.equal(state.series[seriesId].createdAt, root.createdAt, 'sửa mốc tạo của bản gốc đồng bộ cả chuỗi');
assert.equal(occurrences(2026, 9, 25).find(t => t.isVirtual).createdAt, root.createdAt);
assert.equal(state.tasks.length, 1, 'xem bản ảo không tạo bản ghi thật');
assert.equal(api.setStatus(day25.id, 'todo'), true);
assert.equal(state.tasks.length, 1, 'chọn lại trạng thái hiện tại không ghi dữ liệu');

assert.equal(api.setStatus(day25.id, 'inprogress'), true);
assert.equal(state.tasks.length, 2, 'chỉ ngày đổi trạng thái được materialize');
assert.equal(state.tasks.find(t => t.occurrenceDate === day25.occurrenceDate).status, 'inprogress');
assert.equal(state.tasks.find(t => t.occurrenceDate === day25.occurrenceDate).createdAt, root.createdAt,
  'bản ảo được sửa riêng vẫn giữ ngày tạo của chuỗi');
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
assert.equal(state.tasks[0].createdAt, root.createdAt, 'bản gốc được đôn lên giữ ngày tạo ban đầu');
assert.equal(state.series[seriesId].createdAt, root.createdAt);
assert.equal(occurrences(2026, 9, 28).find(t => t.isVirtual).createdAt, root.createdAt);
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
assert.equal(anchor.createdAt, root.createdAt, 'sửa hoạt động riêng không đổi ngày tạo của chuỗi');

api.deleteRecurringSeries(seriesId);
assert.equal(occurrences(2050, 6, 6).length, 0);
assert.equal(state.tasks.length, 0);

const promotedRoot = api.addTask('Bản gốc khác', 'todo', at(2026, 9, 24), 'existing-next', false);
promotedRoot.createdAt = at(2026, 9, 19);
Object.assign(promotedRoot, {recurrenceRule:'daily', recurrenceStart:at(2026, 9, 24), occurrenceDate:at(2026, 9, 24)});
const existingNext = api.addTask('Bản ngày 25 đã chỉnh', 'inprogress', at(2026, 9, 25), 'existing-next', false);
Object.assign(existingNext, {recurrenceRule:'daily', recurrenceStart:at(2026, 9, 24), occurrenceDate:at(2026, 9, 25)});
const existingHistory = JSON.stringify(existingNext.history);
state.series['existing-next'] = {title:'Bản gốc khác',description:'',rule:'daily',start:at(2026, 9, 24),
  createdAt:promotedRoot.createdAt,anchorDate:'2026-09-24',initialStatus:'todo',excludedDates:[]};
api.deleteTask(promotedRoot.id);
assert.equal(existingNext.createdAt, promotedRoot.createdAt, 'bản thật kế tiếp kế thừa ngày tạo khi thành bản gốc');
assert.equal(JSON.stringify(existingNext.history), existingHistory, 'lịch sử bản thật kế tiếp không bị đổi');
assert.equal(existingNext.title, 'Bản ngày 25 đã chỉnh');
api.deleteRecurringSeries('existing-next');

const skippedRoot = api.addTask('Gốc bỏ qua ngày rác', 'todo', at(2026, 9, 24), 'skip-trash', false);
skippedRoot.createdAt = at(2026, 9, 18);
Object.assign(skippedRoot, {recurrenceRule:'daily', recurrenceStart:at(2026, 9, 24), occurrenceDate:at(2026, 9, 24)});
const trashedNext = api.addTask('Bản đã vào rác', 'trash', at(2026, 9, 25), 'skip-trash', false);
Object.assign(trashedNext, {recurrenceRule:'daily', recurrenceStart:at(2026, 9, 24), occurrenceDate:at(2026, 9, 25)});
state.series['skip-trash'] = {title:'Gốc bỏ qua ngày rác',description:'',rule:'daily',start:at(2026, 9, 24),
  createdAt:skippedRoot.createdAt,anchorDate:'2026-09-24',initialStatus:'todo',excludedDates:[]};
api.deleteTask(skippedRoot.id);
assert.equal(state.series['skip-trash'].anchorDate, '2026-09-26', 'bản trong rác không thành bản gốc mới');
assert.equal(occurrences(2026, 9, 26).find(task => task.recurrenceId === 'skip-trash').createdAt, skippedRoot.createdAt);
assert.equal(trashedNext.status, 'trash', 'bản rác độc lập được giữ nguyên');
api.deleteRecurringSeries('skip-trash');

const trashRoot = api.addTask('Xóa hàng loạt', 'trash', at(2026, 9, 24), 'trash-series', false);
Object.assign(trashRoot, { recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24), occurrenceDate: at(2026, 9, 24) });
const trash25 = api.addTask('Xóa hàng loạt', 'trash', at(2026, 9, 25), 'trash-series', false);
Object.assign(trash25, { recurrenceRule: 'daily', recurrenceStart: at(2026, 9, 24), occurrenceDate: at(2026, 9, 25) });
state.series['trash-series'] = {
  title: 'Xóa hàng loạt', description: '', rule: 'daily', start: at(2026, 9, 24),
  createdAt: trashRoot.createdAt, anchorDate: '2026-09-24', initialStatus: 'todo', excludedDates: [],
};
api.emptyTrash();
assert.equal(state.tasks.length, 1, 'dọn nhiều ngày lặp chỉ giữ một anchor mới');
assert.equal(api.dateKey(state.tasks[0].occurrenceDate), '2026-09-26');
assert.equal(state.tasks[0].createdAt, trashRoot.createdAt, 'dọn rác bản gốc vẫn giữ ngày tạo');
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
assert.equal(state.series.legacy.createdAt, state.tasks[0].createdAt);
assert.equal(occurrences(2026, 9, 25).filter(t => t.recurrenceId === 'legacy').length, 0);
assert.equal(api.loadTasks().length, 1);
assert.ok(api.loadSeries().legacy);

const oldCreated = at(2026, 10, 2);
const oldGroupStart = at(2026, 10, 3);
const oldGroupNext = at(2026, 10, 4);
const oldGroupEdited = at(2026, 10, 5);
const oldTasks = [
  { id: 'old-standalone', title: 'Việc cũ riêng', status: 'todo', createdAt: oldCreated,
    history: [{ at: oldCreated, from: null, to: 'todo' }], reminderAt: null },
  { id: 'old-root', title: 'Việc lặp cũ', description: '', status: 'todo', createdAt: oldGroupStart,
    history: [{ at: oldGroupStart, from: null, to: 'todo' }], recurrenceId: 'old-group', recurrenceExcludedDates: ['2026-10-06'] },
  { id: 'old-duplicate', title: 'Việc lặp cũ', description: '', status: 'todo', createdAt: oldGroupNext,
    history: [{ at: oldGroupNext, from: null, to: 'todo' }], recurrenceId: 'old-group' },
  { id: 'old-edited', title: 'Việc riêng ngày 5', description: 'Ghi chú riêng', status: 'pending', createdAt: oldGroupEdited,
    history: [{ at: oldGroupEdited, from: null, to: 'todo' }, { at: oldGroupEdited, from: 'todo', to: 'pending' }],
    reminderAt: oldGroupEdited, recurrenceId: 'old-group' },
  { id: 'already-new', title: 'Đã có ngày thực hiện', status: 'todo', createdAt: at(2026, 9, 24),
    occurrenceDate: at(2026, 10, 10), history: [{ at: at(2026, 9, 24), from: null, to: 'todo' }] },
];
const oldTasksRaw = JSON.stringify(oldTasks);
storage.set('tqm_tasks_v1', oldTasksRaw);
storage.set('tqm_series_v1', '{}');
state.tasks = JSON.parse(oldTasksRaw);
state.series = {};
assert.equal(api.migrateLegacyData(), true);
const migratedRoot = state.tasks.find(task => task.id === 'old-root');
const migratedStandalone = state.tasks.find(task => task.id === 'old-standalone');
const migratedEdited = state.tasks.find(task => task.id === 'old-edited');
assert.equal(migratedStandalone.occurrenceDate, oldCreated);
assert.equal(migratedStandalone.createdAt, oldCreated, 'không tự đoán lại ngày tạo cũ');
assert.equal(migratedRoot.occurrenceDate, oldGroupStart);
assert.equal(state.tasks.some(task => task.id === 'old-duplicate'), false, 'bản cũ chưa sửa thành bản ảo');
assert.equal(migratedEdited.occurrenceDate, oldGroupEdited);
assert.equal(migratedEdited.title, 'Việc riêng ngày 5');
assert.equal(migratedEdited.description, 'Ghi chú riêng');
assert.equal(migratedEdited.status, 'pending');
assert.equal(migratedEdited.reminderAt, oldGroupEdited);
assert.equal(migratedEdited.history.length, 2);
assert.equal(state.tasks.find(task => task.id === 'already-new').occurrenceDate, at(2026, 10, 10));
assert.ok(state.series['old-group'].excludedDates.includes('2026-10-06'));
const backups = () => [...storage.keys()].filter(key => key.startsWith('tqm_migration_backup_v2_'));
assert.equal(backups().length, 1);
assert.equal(JSON.parse(storage.get(backups()[0])).tasks, oldTasksRaw, 'bản sao giữ nguyên JSON gốc');
const migratedTasksRaw = storage.get('tqm_tasks_v1');
assert.equal(api.migrateLegacyData(), false, 'chạy lại không migration lần nữa');
assert.equal(backups().length, 1, 'không tạo bản sao dư khi chạy lại');
assert.equal(storage.get('tqm_tasks_v1'), migratedTasksRaw);

const blockedFixture = JSON.stringify([oldTasks[0]]);
state.tasks = JSON.parse(blockedFixture);
state.series = {};
storage.set('tqm_tasks_v1', blockedFixture);
storage.set('tqm_series_v1', '{}');
blockBackup = true;
assert.equal(api.migrateLegacyData(), false);
assert.equal(storage.get('tqm_tasks_v1'), blockedFixture, 'không ghi đè nếu không thể sao lưu');
assert.equal(state.tasks[0].occurrenceDate, undefined);
assert.equal(state.migrationWarning, true);
blockBackup = false;
state.migrationWarning = false;
blockedWriteKey = 'tqm_tasks_v1';
assert.equal(api.migrateLegacyData(), false);
assert.equal(storage.get('tqm_tasks_v1'), blockedFixture, 'ghi lỗi phải phục hồi task gốc');
assert.equal(storage.get('tqm_series_v1'), '{}', 'ghi lỗi phải phục hồi chuỗi gốc');
assert.equal(backups().length, 1, 'bản sao của lần ghi lỗi được dọn sau khi phục hồi');
assert.equal(api.saveTasks(), false, 'khi migration lỗi không được ghi dữ liệu khác');

console.log('Recurrence regression tests: OK');
