const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Run Chrome headless with --remote-debugging-port=9233 and an isolated user-data-dir first.
const endpoint = process.argv[2] || 'http://localhost:9233';
const targetUrl = process.argv[3] || pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const outputDir = process.argv[4] || path.join(os.tmpdir(), 'tms-ui-qa');

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const tabs = await (await fetch(`${endpoint}/json/list`)).json();
  const tab = tabs.find(item => item.type === 'page');
  assert.ok(tab, 'Chrome needs an open page');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      try {
        const now = new Date();
        const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toISOString();
        if (!localStorage.getItem('tqm_tasks_v1')) localStorage.setItem('tqm_tasks_v1', JSON.stringify([
          {id:'qa1',title:'Chuẩn bị báo cáo tuần',description:'',status:'todo',createdAt:when,history:[{at:when,from:null,to:'todo'}],reminderAt:null,recurrenceId:null},
          {id:'qa2',title:'Kiểm tra công việc lặp',description:'',status:'inprogress',createdAt:when,history:[{at:when,from:null,to:'todo'},{at:when,from:'todo',to:'inprogress'}],reminderAt:null,recurrenceId:null}
        ]));
      } catch (e) {}
    ` });
    for (const width of [1440, 768, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: width < 600,
      });
      await send('Page.navigate', { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 700));
      const report = await evaluate(`({width:innerWidth,bodyWidth:document.body.scrollWidth,mainWidth:document.querySelector('main').getBoundingClientRect().width,toolbarWidth:document.querySelector('.toolbar').getBoundingClientRect().width})`);
      console.log(`report ${width}:`, report);
      assert.ok(report.bodyWidth <= report.width + 1, `report overflows horizontally at ${width}px`);
      const reportShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/report-${width}.png`, Buffer.from(reportShot.data, 'base64'));
      await evaluate(`document.getElementById('tab-work').click()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      const board = await evaluate(`({width:innerWidth,bodyWidth:document.body.scrollWidth,columns:document.querySelectorAll('.column,.trash-column').length})`);
      console.log(`board ${width}:`, board);
      assert.equal(board.columns, 6);
      assert.ok(board.bodyWidth <= board.width + 1, `board overflows horizontally at ${width}px`);
      const boardShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/board-${width}.png`, Buffer.from(boardShot.data, 'base64'));
      await evaluate(`document.querySelector('.task-card').click()`);
      const detail = await evaluate(`(() => { const modal=document.querySelector('.modal-detail'); const box=modal.getBoundingClientRect(); return {left:box.left,right:box.right,width:innerWidth,scrollWidth:modal.scrollWidth,clientWidth:modal.clientWidth}; })()`);
      console.log(`detail ${width}:`, detail);
      assert.ok(detail.left >= 0 && detail.right <= detail.width + 1, `detail modal outside viewport at ${width}px`);
      const detailShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/detail-${width}.png`, Buffer.from(detailShot.data, 'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 900, deviceScaleFactor: 1, mobile: true,
    });
    await evaluate(`(() => {
      const now=new Date();
      const start=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12).toISOString();
      const key=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
      localStorage.setItem('tqm_tasks_v1',JSON.stringify([{
        id:'recurring-root',title:'Lịch lặp thử nghiệm',description:'',status:'todo',
        createdAt:start,history:[{at:start,from:null,to:'todo'}],reminderAt:null,
        recurrenceId:'qa-series',recurrenceRule:'daily',recurrenceStart:start,
        recurrenceInitialStatus:'todo',occurrenceDate:start
      }]));
      localStorage.setItem('tqm_series_v1',JSON.stringify({'qa-series':{
        title:'Lịch lặp thử nghiệm',description:'',rule:'daily',start,
        anchorDate:key,initialStatus:'todo',excludedDates:[]
      }}));
    })()`);
    await send('Page.navigate', { url: targetUrl });
    await new Promise(resolve => setTimeout(resolve, 400));
    await evaluate(`document.getElementById('tab-work').click()`);
    await evaluate(`document.querySelector('.period-arrow[title="Kỳ sau"]').click()`);
    const virtual = await evaluate(`(() => { const card=document.querySelector('.task-card[data-virtual="true"]'); return card && {id:card.getAttribute('data-task-id'),title:card.querySelector('.t-title').textContent}; })()`);
    assert.ok(virtual && virtual.id.startsWith('virtual:qa-series:'), 'ngày kế tiếp hiển thị như công việc thật');
    await evaluate(`document.querySelector('.task-card[data-virtual="true"]').click()`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('tqm_tasks_v1')).length`), 1, 'mở bản ảo không lưu bản thật');
    assert.equal(await evaluate(`document.querySelector('.modal-detail .recurrence-note').textContent.includes('Chỉnh sửa chỉ áp dụng cho ngày này.')`), true);
    await evaluate(`document.querySelector('.modal-detail .modal-footer .btn-primary').click()`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('tqm_tasks_v1')).length`), 1, 'lưu không đổi không tạo bản thật');
    console.log('virtual detail: read-only open/save OK');
  } finally {
    socket.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
