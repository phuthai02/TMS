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
      const report = await evaluate(`({width:innerWidth,bodyWidth:document.body.scrollWidth,mainWidth:document.querySelector('main').getBoundingClientRect().width,toolbarWidth:document.querySelector('.toolbar').getBoundingClientRect().width,insight:!!document.querySelector('.report-insight'),statButtons:document.querySelectorAll('.report-summary button').length,navPosition:getComputedStyle(document.querySelector('.sidebar')).position})`);
      console.log(`report ${width}:`, report);
      assert.ok(report.bodyWidth <= report.width + 1, `report overflows horizontally at ${width}px`);
      assert.equal(report.insight, true);
      assert.equal(report.statButtons, 4);
      if (width < 600) assert.equal(report.navPosition, 'fixed', 'mobile navigation stays accessible');
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
      if (width <= 820) {
        await evaluate(`document.querySelector('.detail-tabs button:nth-child(2)').click()`);
        assert.equal(await evaluate(`document.querySelector('.detail-tabs button:nth-child(2)').getAttribute('aria-selected')`), 'true');
        const activityShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(`${outputDir}/detail-activity-${width}.png`, Buffer.from(activityShot.data, 'base64'));
      }
      if (width === 1440 || width === 390 || width === 320) {
        await evaluate(`document.querySelector('.history-edit-btn').click()`);
        const edit = await evaluate(`(() => { const item=document.querySelector('.history-item.is-editing'); const input=item.querySelector('.history-time-input'); return {inputWidth:input.getBoundingClientRect().width,itemWidth:item.clientWidth,scrollWidth:item.scrollWidth}; })()`);
        assert.ok(edit.inputWidth >= 130, `history time input too narrow at ${width}px`);
        assert.ok(edit.scrollWidth <= edit.itemWidth + 1, `history edit row overflows at ${width}px`);
        const editShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(`${outputDir}/detail-edit-${width}.png`, Buffer.from(editShot.data, 'base64'));
        if (width === 390) {
          await evaluate(`document.querySelector('.detail-tabs button:first-child').click()`);
          await evaluate(`document.querySelector('.modal-detail .modal-footer .btn-primary').click()`);
          assert.equal(await evaluate(`document.querySelector('.detail-tabs button:nth-child(2)').getAttribute('aria-selected')`), 'true', 'save redirects to unfinished history edit');
          assert.equal(await evaluate(`document.querySelectorAll('.history-item.is-editing .history-row-error.show').length`), 1);
        }
        await evaluate(`document.querySelector('.history-cancel-btn').click()`);
        assert.equal(await evaluate(`document.querySelectorAll('.history-row-error.show').length`), 0);
      }
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
    await evaluate(`document.querySelector('.modal-detail .btn-danger').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.modal-confirm.has-extra,.modal-confirm .confirm-extra').length`), 1, 'recurring delete offers a series action');
    const seriesConfirmShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/confirm-series-390.png`, Buffer.from(seriesConfirmShot.data, 'base64'));
    await evaluate(`document.querySelector('.modal-confirm .confirm-cancel').click()`);
    await evaluate(`document.querySelector('.modal-detail .modal-footer .btn-primary').click()`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('tqm_tasks_v1')).length`), 1, 'lưu không đổi không tạo bản thật');
    console.log('virtual detail: read-only open/save OK');

    await evaluate(`(() => {
      const now=new Date();
      const today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12).toISOString();
      const statuses=['todo','inprogress','pending','done','closed'];
      const names=['Việc mới','Đang triển khai','Chờ duyệt','Đã hoàn tất','Đã đóng'];
      const tasks=statuses.map((status,index)=>({
        id:'rich-'+index,title:names[index],description:'',status,createdAt:today,
        history:status==='done' ? [{at:today,from:null,to:'todo'},{at:today,from:'todo',to:'inprogress'},{at:today,from:'inprogress',to:'done'}]
          :[{at:today,from:null,to:status}],
        reminderAt:index===0 ? today : null,recurrenceId:null
      }));
      localStorage.setItem('tqm_tasks_v1',JSON.stringify(tasks));
      localStorage.setItem('tqm_series_v1','{}');
    })()`);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: targetUrl });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await evaluate(`document.querySelectorAll('.status-legend-row').length`), 5);
    assert.equal(await evaluate(`document.querySelectorAll('.report-top-grid .report-todo-list tbody tr').length`), 1);
    const populatedShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/report-populated-1440.png`, Buffer.from(populatedShot.data, 'base64'));
    await evaluate(`document.querySelector('.report-top-grid .report-todo-list tbody tr').click()`);
    assert.equal(await evaluate(`document.querySelector('.modal-detail input[type="text"]').value`), 'Đã hoàn tất');
    console.log('completed report row: detail opens OK');
    const historyRows = await evaluate(`Array.from(document.querySelectorAll('.modal-detail .history-item')).map(item=>({scrollWidth:item.scrollWidth,clientWidth:item.clientWidth}))`);
    assert.equal(historyRows.length, 3);
    assert.ok(historyRows.every(row => row.scrollWidth <= row.clientWidth + 1), 'history badges stay within event cards');
    await evaluate(`(() => {
      const item=document.querySelectorAll('.modal-detail .history-item')[1];
      item.querySelector('.history-edit-btn').click();
      const input=item.querySelector('.history-time-input');
      input.value=input.value.slice(0,-2)+'01';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      item.querySelector('.history-confirm-btn').click();
    })()`);
    assert.equal(await evaluate(`document.querySelectorAll('.history-item.is-editing').length`), 1, 'invalid time cannot be confirmed');
    assert.equal(await evaluate(`document.querySelector('.history-item.is-editing .history-row-error.show').textContent.includes('trước hoạt động sau')`), true, 'validation appears below edited input');
    const validationShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/detail-history-validation-1440.png`, Buffer.from(validationShot.data, 'base64'));
    await evaluate(`document.querySelector('.history-item.is-editing .history-cancel-btn').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.history-row-error.show').length`), 0);
    const storedBeforeDraft = await evaluate(`localStorage.getItem('tqm_tasks_v1')`);
    await evaluate(`(() => {
      const item=document.querySelector('.modal-detail .history-item');
      item.querySelector('.history-edit-btn').click();
      const input=item.querySelector('.history-time-input');
      input.value=input.value.slice(0,-2)+'01';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      item.querySelector('.history-confirm-btn').click();
    })()`);
    assert.equal(await evaluate(`document.querySelectorAll('.history-item.is-draft').length`), 1);
    assert.equal(await evaluate(`localStorage.getItem('tqm_tasks_v1')`), storedBeforeDraft, 'confirming an edit does not save before main save');
    const draftRow = await evaluate(`(() => { const item=document.querySelector('.history-item.is-draft'); return {scrollWidth:item.scrollWidth,clientWidth:item.clientWidth}; })()`);
    assert.ok(draftRow.scrollWidth <= draftRow.clientWidth + 1, 'unsaved label does not overflow event card');
    const draftShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/detail-history-draft-1440.png`, Buffer.from(draftShot.data, 'base64'));
    await evaluate(`document.querySelector('.modal-detail .modal-header .icon-btn').click()`);
    assert.equal(await evaluate(`localStorage.getItem('tqm_tasks_v1')`), storedBeforeDraft, 'closing modal discards draft');
    await evaluate(`document.querySelector('.report-top-grid .report-todo-list tbody tr').click()`);
    await evaluate(`(() => {
      const item=document.querySelector('.modal-detail .history-item');
      item.querySelector('.history-edit-btn').click();
      const input=item.querySelector('.history-time-input');
      input.value=input.value.slice(0,-2)+'01';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      item.querySelector('.history-confirm-btn').click();
      document.querySelector('.modal-detail .modal-footer .btn-primary').click();
    })()`);
    assert.notEqual(await evaluate(`JSON.parse(localStorage.getItem('tqm_tasks_v1')).find(task=>task.id==='rich-3').history[2].at`), JSON.parse(storedBeforeDraft).find(task => task.id === 'rich-3').history[2].at, 'main save persists confirmed time');
    for (const width of [1440, 320]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 1, mobile: width < 600,
      });
      const chart = await evaluate(`(() => { const panel=document.querySelector('.report-top-grid .panel'); return {clientHeight:panel.clientHeight,scrollHeight:panel.scrollHeight}; })()`);
      assert.ok(chart.scrollHeight <= chart.clientHeight + 1, `status chart clips at ${width}px`);
    }
    for (const width of [1440, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate(`(() => {
        const now=new Date();
        const today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12).toISOString();
        const notified=now.toISOString();
        const tasks=[
          {id:'modal-1',title:'Chuẩn bị báo cáo khách hàng',description:'',status:'todo',createdAt:today,history:[{at:today,from:null,to:'todo'}],reminderAt:today,reminderNotifiedAt:notified,recurrenceId:null},
          {id:'modal-2',title:'Kiểm tra bản giao diện trên điện thoại',description:'',status:'inprogress',createdAt:today,history:[{at:today,from:null,to:'todo'},{at:today,from:'todo',to:'inprogress'}],reminderAt:today,reminderNotifiedAt:notified,recurrenceId:null}
        ];
        localStorage.setItem('tqm_tasks_v1',JSON.stringify(tasks));
        localStorage.setItem('tqm_series_v1','{}');
      })()`);
      await send('Page.navigate', { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await evaluate(`document.querySelectorAll('.report-reminder-item').length`), 2, 'report reminders are a list');
      assert.equal(await evaluate(`document.querySelectorAll('.report-reminder-item .btn').length`), 2, 'each report reminder has a view button');
      await evaluate(`document.querySelector('.report-reminder-list').scrollIntoView({block:'center'})`);
      const reportReminderShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/report-reminders-${width}.png`, Buffer.from(reportReminderShot.data, 'base64'));
      await evaluate(`document.querySelector('.report-reminder-item .btn').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'report reminder opens task detail');
      await evaluate(`document.querySelector('.modal-detail .modal-header .icon-btn').click()`);
      await evaluate(`document.querySelector('.report-summary button').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.summary-task-item').length`), 2, 'summary modal shows task cards');
      const summaryBounds = await evaluate(`(() => { const box=document.querySelector('.summary-list-modal'); return {scrollWidth:box.scrollWidth,clientWidth:box.clientWidth}; })()`);
      assert.ok(summaryBounds.scrollWidth <= summaryBounds.clientWidth + 1, `summary modal overflows at ${width}px`);
      const summaryShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/summary-modal-${width}.png`, Buffer.from(summaryShot.data, 'base64'));
      await evaluate(`(() => { const input=document.querySelector('.summary-search'); input.value='khách hàng'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      assert.equal(await evaluate(`document.querySelectorAll('.summary-task-item').length`), 1, 'summary search filters cards');
      await evaluate(`document.querySelector('.summary-task-item .btn').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'summary view button opens task detail');
      await evaluate(`document.querySelector('.modal-detail .btn-danger').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-confirm.is-danger')`), 'delete opens danger confirmation');
      const confirmShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/confirm-modal-${width}.png`, Buffer.from(confirmShot.data, 'base64'));
      await evaluate(`document.querySelector('.modal-confirm .btn-outline').click()`);
      await evaluate(`document.querySelector('.modal-detail .modal-header .icon-btn').click()`);
      await evaluate(`document.getElementById('tab-work').click()`);
      await evaluate(`document.querySelector('.toolbar > .btn-primary').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-bulk')`), 'bulk modal opens');
      await evaluate(`document.querySelector('.modal-bulk .modal-footer .btn-primary').click()`);
      assert.equal(await evaluate(`document.querySelector('.modal-bulk .field-error.show').textContent`), 'Vui lòng nhập ít nhất một công việc.');
      const bulkShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/bulk-modal-${width}.png`, Buffer.from(bulkShot.data, 'base64'));
      await evaluate(`document.querySelector('.modal-bulk .modal-header .icon-btn').click()`);
      await evaluate(`(() => { const tasks=JSON.parse(localStorage.getItem('tqm_tasks_v1')); tasks.forEach(task => { task.reminderNotifiedAt=null; task.reminderAt=new Date(Date.now()-60000).toISOString(); }); localStorage.setItem('tqm_tasks_v1',JSON.stringify(tasks)); })()`);
      await send('Page.navigate', { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await evaluate(`document.querySelectorAll('.reminder-item').length`), 2, 'due reminders are listed');
      assert.equal(await evaluate(`document.querySelectorAll('.reminder-item .btn').length`), 2, 'each due reminder has a view button');
      const reminderShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/reminder-modal-${width}.png`, Buffer.from(reminderShot.data, 'base64'));
      await evaluate(`document.querySelector('.reminder-item .btn').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'reminder view button opens task detail');
      if (width === 320) {
        await evaluate(`(() => {
          const base=JSON.parse(localStorage.getItem('tqm_tasks_v1'))[0];
          const tasks=Array.from({length:25},(_,index)=>({...base,id:'long-reminder-'+index,title:'Nhắc việc số '+(index+1),reminderNotifiedAt:null}));
          localStorage.setItem('tqm_tasks_v1',JSON.stringify(tasks));
        })()`);
        await send('Page.navigate', { url: targetUrl });
        await new Promise(resolve => setTimeout(resolve, 350));
        const longReminder = await evaluate(`(() => { const modal=document.querySelector('.modal-reminder'); const body=modal.querySelector('.modal-body'); const rect=modal.getBoundingClientRect(); return {count:modal.querySelectorAll('.reminder-item').length,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,top:rect.top,bottom:rect.bottom}; })()`);
        assert.equal(longReminder.count, 25);
        assert.ok(longReminder.scrollHeight > longReminder.clientHeight, 'long reminder list scrolls inside modal');
        assert.ok(longReminder.top >= 0 && longReminder.bottom <= 901, 'long reminder modal stays in viewport');
      }
    }
    for (const width of [1790, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate(`(() => {
        const today=new Date(); today.setHours(0,0,0,0);
        const at=hours=>new Date(today.getTime()+hours*3600000).toISOString();
        localStorage.setItem('tqm_tasks_v1',JSON.stringify([{
          id:'metric-done',title:'Hoàn tất bản kế hoạch triển khai',
          description:'Tổng hợp phản hồi, hoàn thiện nội dung và gửi bản cuối cho nhóm phê duyệt.',
          status:'done',createdAt:at(0),occurrenceDate:at(0),recurrenceId:null,
          history:[{at:at(0),from:null,to:'todo'},{at:at(0.5),from:'todo',to:'inprogress'},{at:at(1.5),from:'inprogress',to:'pending'},{at:at(2.5),from:'pending',to:'done'}],
          reminderAt:at(20),reminderNotifiedAt:null
        }]));
        localStorage.setItem('tqm_series_v1','{}');
      })()`);
      await send('Page.navigate', { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 350));
      await evaluate(`document.getElementById('tab-work').click()`);
      const facts = await evaluate(`(() => { const card=document.querySelector('[data-task-id="metric-done"]'); return Array.from(card.querySelectorAll('.task-card-fact')).map(node=>[node.querySelector('.task-card-fact-label').textContent,node.querySelector('.task-card-fact-value').textContent]); })()`);
      assert.ok(facts.some(([label]) => label === 'Bắt đầu'));
      assert.ok(facts.some(([label]) => label === 'Kết thúc'));
      assert.ok(facts.some(([label, value]) => label === 'Tổng xử lý' && value === '2 giờ'));
      assert.ok(facts.some(([label, value]) => label === 'Tổng chờ duyệt' && value === '1 giờ'));
      assert.ok(await evaluate(`!!document.querySelector('[data-task-id="metric-done"] .t-description')`));
      if (width === 320) await evaluate(`document.querySelector('[data-task-id="metric-done"]').scrollIntoView({block:'center'})`);
      const cardShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/detailed-card-${width}.png`, Buffer.from(cardShot.data, 'base64'));
      if (width === 320) {
        const moved = await evaluate(`(() => {
          const board=document.querySelector('.board');
          const target=document.querySelector('.trash-column .card-list');
          const transfer=new DataTransfer(); transfer.setData('text/plain','metric-done');
          target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
          const card=target.querySelector('[data-task-id="metric-done"]');
          return {sameBoard:document.querySelector('.board')===board,inTrash:!!card,deletedFact:card?.textContent.includes('Chuyển vào rác'),hasProgress:!!card?.querySelector('.progress-track')};
        })()`);
        assert.deepEqual(moved, {sameBoard:true,inTrash:true,deletedFact:true,hasProgress:false});
      }
    }
  } finally {
    socket.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
