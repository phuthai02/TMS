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
      assert.equal(report.statButtons, 5);
      const defaultPeriod = await evaluate(`(() => {
        const now=new Date();
        const first=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
        const lastDay=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
        const last=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(lastDay).padStart(2,'0');
        const dates=Array.from(document.querySelectorAll('.period-range input')).map(input=>input.value);
        return {monthSelected:document.querySelectorAll('.period-quick-button')[2].classList.contains('active'),dates,expected:[first,last]};
      })()`);
      assert.equal(defaultPeriod.monthSelected, true, 'report defaults to current month');
      assert.deepEqual(defaultPeriod.dates, defaultPeriod.expected, 'report range spans current month');
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
        assert.ok(await evaluate(`(() => { const input=document.querySelector('.history-item.is-editing .history-time-input'); return input.type==='text' && new RegExp('^[0-9]{2}/[0-9]{2}/[0-9]{4} [0-9]{2}:[0-9]{2}$').test(input.value); })()`), 'activity editor uses dd/mm/yyyy 24-hour time');
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
    assert.equal(await evaluate(`document.querySelector('.modal-detail .recurrence-note').textContent`), 'Lặp: hàng ngày');
    assert.equal(await evaluate(`document.querySelector('.modal-detail .recurrence-rule-select').disabled`), true, 'virtual occurrence cannot change repeat rule');
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
      assert.equal(await evaluate(`document.querySelectorAll('.report-bottom-grid .panel:last-child tbody tr').length`), 2, 'report reminders remain a table');
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.report-bottom-grid .panel:last-child th')).map(th=>th.textContent)`), ['Tên công việc','Trạng thái','Nhắc lúc','Phê duyệt']);
      await evaluate(`document.querySelector('.report-bottom-grid .panel:last-child').scrollIntoView({block:'center'})`);
      const reportReminderShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/report-reminders-${width}.png`, Buffer.from(reportReminderShot.data, 'base64'));
      await evaluate(`document.querySelector('.report-bottom-grid .panel:last-child tbody tr').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'report reminder opens task detail');
      await evaluate(`document.querySelector('.modal-detail .modal-header .icon-btn').click()`);
      await evaluate(`document.querySelector('.report-summary button').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.summary-list-modal tbody tr').length`), 2, 'summary modal remains a table');
      assert.equal(await evaluate(`document.querySelectorAll('.summary-list-modal th').length`), 7);
      const summaryBounds = await evaluate(`(() => { const box=document.querySelector('.summary-list-modal'); return {scrollWidth:box.scrollWidth,clientWidth:box.clientWidth}; })()`);
      assert.ok(summaryBounds.scrollWidth <= summaryBounds.clientWidth + 1, `summary modal overflows at ${width}px`);
      if (width === 320) {
        const tableScroll = await evaluate(`(() => { const wrap=document.querySelector('.summary-list-modal .clickable-table'); wrap.scrollLeft=wrap.scrollWidth; return {scrollWidth:wrap.scrollWidth,clientWidth:wrap.clientWidth,scrollLeft:wrap.scrollLeft}; })()`);
        assert.ok(tableScroll.scrollWidth > tableScroll.clientWidth && tableScroll.scrollLeft > 0, 'summary table scrolls horizontally on mobile');
        await evaluate(`document.querySelector('.summary-list-modal .clickable-table').scrollLeft=0`);
      }
      const summaryShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(`${outputDir}/summary-modal-${width}.png`, Buffer.from(summaryShot.data, 'base64'));
      await evaluate(`(() => { const input=document.querySelector('.summary-search'); input.value='khách hàng'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      assert.equal(await evaluate(`document.querySelectorAll('.summary-list-modal tbody tr').length`), 1, 'summary search filters rows');
      await evaluate(`document.querySelector('.summary-list-modal tbody tr').click()`);
      assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'summary row opens task detail');
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
          reminderAt:at(20),reminderNotifiedAt:at(20)
        }]));
        localStorage.setItem('tqm_series_v1','{}');
      })()`);
      await send('Page.navigate', { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await evaluate(`document.querySelector('.report-top-grid .report-todo-list .approval-timing strong').textContent`), '1 giờ');
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('.report-top-grid .report-todo-list th')).some(th=>th.textContent==='Tổng thực hiện')`));
      assert.equal(await evaluate(`document.querySelector('.report-top-grid .report-todo-list tbody tr td:nth-child(4)').textContent`), '1 giờ');
      await evaluate(`document.getElementById('tab-work').click()`);
      const facts = await evaluate(`(() => { const card=document.querySelector('[data-task-id="metric-done"]'); return Array.from(card.querySelectorAll('.task-card-fact')).map(node=>[node.querySelector('.task-card-fact-label').textContent,node.querySelector('.task-card-fact-value').textContent]); })()`);
      assert.ok(facts.some(([label]) => label === 'Bắt đầu'));
      assert.ok(facts.some(([label]) => label === 'Kết thúc'));
      assert.ok(facts.some(([label, value]) => label === 'Tổng thực hiện' && value === '1 giờ'));
      assert.ok(facts.some(([label, value]) => label === 'Tổng chờ phê duyệt' && value === '1 giờ'));
      assert.ok(!facts.some(([label]) => label === 'Tổng xử lý'));
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
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
    await evaluate(`(() => {
      const now=Date.now();
      const today=new Date(now); today.setHours(0,0,0,0);
      const at=(minutes,seconds=0)=>new Date(now-minutes*60000-seconds*1000).toISOString();
      localStorage.setItem('tqm_tasks_v1',JSON.stringify([{
        id:'metric-pending',title:'Chờ duyệt lần hai',description:'Đã gửi lại sau khi chỉnh sửa.',status:'pending',
        createdAt:today.toISOString(),history:[
          {at:at(10),from:null,to:'todo'},
          {at:at(8,10),from:'todo',to:'inprogress'},
          {at:at(6,20),from:'inprogress',to:'pending'},
          {at:at(4,10),from:'pending',to:'inprogress'},
          {at:at(2,10),from:'inprogress',to:'pending'}
        ],reminderAt:null,recurrenceId:null
      }]));
      localStorage.setItem('tqm_series_v1','{}');
    })()`);
    await send('Page.navigate', { url: targetUrl });
    await new Promise(resolve => setTimeout(resolve, 350));
    await evaluate(`document.getElementById('tab-work').click()`);
    const pendingBefore = await evaluate(`(() => {
      const card=document.querySelector('[data-task-id="metric-pending"]');
      window.__qaTimingBoard=document.querySelector('.board');
      window.__qaTimingCard=card;
      return Object.fromEntries(Array.from(card.querySelectorAll('.task-card-fact')).map(row=>[row.querySelector('.task-card-fact-label').textContent,row.querySelector('.task-card-fact-value').textContent]));
    })()`);
    assert.equal(pendingBefore['Đang chờ phê duyệt'], '2 phút');
    assert.equal(pendingBefore['Tổng chờ phê duyệt'], '4 phút');
    assert.deepEqual(Object.keys(pendingBefore), ['Ngày thực hiện','Đang chờ phê duyệt','Tổng chờ phê duyệt']);
    await evaluate(`(() => { window.__qaOriginalDateNow=Date.now; Date.now=()=>window.__qaOriginalDateNow()+120000; })()`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const pendingAfter = await evaluate(`(() => {
      const card=document.querySelector('[data-task-id="metric-pending"]');
      return {sameBoard:document.querySelector('.board')===window.__qaTimingBoard,sameCard:card===window.__qaTimingCard,
        facts:Object.fromEntries(Array.from(card.querySelectorAll('.task-card-fact')).map(row=>[row.querySelector('.task-card-fact-label').textContent,row.querySelector('.task-card-fact-value').textContent]))};
    })()`);
    assert.equal(pendingAfter.sameBoard, true, 'live timer does not rebuild board');
    assert.equal(pendingAfter.sameCard, true, 'live timer does not rebuild card');
    assert.equal(pendingAfter.facts['Đang chờ phê duyệt'], '4 phút');
    assert.equal(pendingAfter.facts['Tổng chờ phê duyệt'], '6 phút');
    assert.deepEqual(Object.keys(pendingAfter.facts), ['Ngày thực hiện','Đang chờ phê duyệt','Tổng chờ phê duyệt']);
    await evaluate(`(() => { Date.now=window.__qaOriginalDateNow; delete window.__qaOriginalDateNow; document.querySelector('[data-task-id="metric-pending"]').scrollIntoView({block:'center'}); })()`);
    const pendingShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/pending-realtime-320.png`, Buffer.from(pendingShot.data, 'base64'));
    const resumed = await evaluate(`(() => {
      const transfer=new DataTransfer(); transfer.setData('text/plain','metric-pending');
      document.querySelectorAll('.column .card-list')[1].dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
      const card=document.querySelector('[data-task-id="metric-pending"]');
      return {sameBoard:document.querySelector('.board')===window.__qaTimingBoard,sameCard:card===window.__qaTimingCard,
        live:card.getAttribute('data-live-timing'),labels:Array.from(card.querySelectorAll('.task-card-fact-label')).map(node=>node.textContent)};
    })()`);
    assert.equal(resumed.sameBoard, true);
    assert.equal(resumed.sameCard, true);
    assert.equal(resumed.live, 'true');
    assert.ok(resumed.labels.includes('Đang thực hiện'));
    assert.ok(!resumed.labels.includes('Đang chờ phê duyệt'));
    assert.deepEqual(resumed.labels, ['Ngày thực hiện','Đang thực hiện','Tổng thực hiện']);
    await evaluate(`(() => { window.__qaOriginalDateNow=Date.now; Date.now=()=>window.__qaOriginalDateNow()+120000; })()`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const resumedAfter = await evaluate(`(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-task-id="metric-pending"] .task-card-fact')).map(row=>[row.querySelector('.task-card-fact-label').textContent,row.querySelector('.task-card-fact-value').textContent])))()`);
    assert.equal(resumedAfter['Đang thực hiện'], '2 phút');
    assert.equal(resumedAfter['Tổng thực hiện'], '5 phút');
    assert.deepEqual(Object.keys(resumedAfter), ['Ngày thực hiện','Đang thực hiện','Tổng thực hiện']);
    await evaluate(`(() => { Date.now=window.__qaOriginalDateNow; delete window.__qaOriginalDateNow; })()`);
    const pendingAgain = await evaluate(`(() => {
      const transfer=new DataTransfer(); transfer.setData('text/plain','metric-pending');
      document.querySelectorAll('.column .card-list')[2].dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
      const card=document.querySelector('[data-task-id="metric-pending"]');
      return {sameBoard:document.querySelector('.board')===window.__qaTimingBoard,sameCard:card===window.__qaTimingCard,
        facts:Object.fromEntries(Array.from(card.querySelectorAll('.task-card-fact')).map(row=>[row.querySelector('.task-card-fact-label').textContent,row.querySelector('.task-card-fact-value').textContent]))};
    })()`);
    assert.equal(pendingAgain.sameBoard, true);
    assert.equal(pendingAgain.sameCard, true);
    assert.deepEqual(Object.keys(pendingAgain.facts), ['Ngày thực hiện','Đang chờ phê duyệt','Tổng chờ phê duyệt']);
    assert.match(pendingAgain.facts['Đang chờ phê duyệt'], /^\d+ giây$/);
    await evaluate(`document.querySelector('[data-task-id="metric-pending"]').click()`);
    const detailApproval = await evaluate(`Array.from(document.querySelectorAll('.detail-approval .approval-timing-row strong')).map(node=>node.textContent)`);
    assert.match(detailApproval[0], /^\d+ giây$/);
    assert.equal(detailApproval[1], '4 phút', 'detail retains total waiting across approval rounds');

    await evaluate(`(() => {
      const now=Date.now();
      const ago=ms=>new Date(now-ms).toISOString();
      localStorage.setItem('tqm_tasks_v1',JSON.stringify([{
        id:'approval-boundary',title:'Duyệt hồ sơ lần hai',description:'Đã trả về và gửi duyệt lại.',status:'pending',
        createdAt:ago(14*3600000),history:[
          {at:ago(14*3600000),from:null,to:'todo'},
          {at:ago(13.5*3600000),from:'todo',to:'inprogress'},
          {at:ago(13*3600000),from:'inprogress',to:'pending'},
          {at:ago(12.5*3600000),from:'pending',to:'inprogress'},
          {at:ago(12*3600000-30000),from:'inprogress',to:'pending'}
        ],reminderAt:null,recurrenceId:null
      }]));
      localStorage.setItem('tqm_series_v1','{}');
    })()`);
    await send('Page.navigate', { url: targetUrl });
    await new Promise(resolve => setTimeout(resolve, 350));
    await evaluate(`document.querySelectorAll('.period-quick-button')[3].click()`);
    const approvalReport = await evaluate(`(() => {
      const overdue=document.querySelector('[data-overdue-card="true"]');
      const row=Array.from(document.querySelectorAll('.report-bottom-grid .panel:first-child tbody tr')).find(row=>row.textContent.includes('Duyệt hồ sơ lần hai'));
      window.__qaOverdueCard=overdue;
      window.__qaApprovalRow=row;
      return {count:overdue.querySelector('.num').textContent,labels:Array.from(row.querySelectorAll('.approval-timing-row')).map(row=>[row.querySelector('span').textContent,row.querySelector('strong').textContent])};
    })()`);
    assert.equal(approvalReport.count, '0');
    assert.equal(approvalReport.labels[0][0], 'Đang chờ');
    assert.equal(approvalReport.labels[0][1], '11 giờ 59 phút');
    assert.equal(approvalReport.labels[1][0], 'Tổng chờ');
    assert.equal(approvalReport.labels[1][1], '12 giờ 29 phút');
    await evaluate(`(() => { window.__qaOriginalDateNow=Date.now; Date.now=()=>window.__qaOriginalDateNow()+40000; })()`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const approvalReportAfter = await evaluate(`(() => {
      const card=document.querySelector('[data-overdue-card="true"]');
      const row=Array.from(document.querySelectorAll('.report-bottom-grid .panel:first-child tbody tr')).find(row=>row.textContent.includes('Duyệt hồ sơ lần hai'));
      return {sameCard:card===window.__qaOverdueCard,sameRow:row===window.__qaApprovalRow,count:card.querySelector('.num').textContent,
        values:Array.from(row.querySelectorAll('.approval-timing strong')).map(node=>node.textContent)};
    })()`);
    assert.equal(approvalReportAfter.sameCard, true, 'report card updates without rebuilding');
    assert.equal(approvalReportAfter.sameRow, true, 'report row updates without rebuilding');
    assert.equal(approvalReportAfter.count, '1', '12-hour threshold updates without refresh');
    assert.equal(approvalReportAfter.values[0], '12 giờ');
    assert.equal(approvalReportAfter.values[1], '12 giờ 30 phút');
    await evaluate(`document.querySelector('.report-bottom-grid .panel:first-child').scrollIntoView({block:'center'})`);
    const approvalReportShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/approval-report-320.png`, Buffer.from(approvalReportShot.data, 'base64'));
    await evaluate(`document.querySelector('[data-overdue-card="true"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.summary-list-modal tbody tr').length`), 1);
    assert.equal(await evaluate(`document.querySelector('.summary-list-modal .approval-timing-row strong').textContent`), approvalReportAfter.values[0]);
    await evaluate(`document.querySelector('.summary-list-modal tbody tr').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.detail-approval .approval-timing-row').length`), 2);
    assert.equal(await evaluate(`document.querySelector('.detail-approval .approval-timing-row strong').textContent`), '12 giờ');
    const approvalDetailShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${outputDir}/approval-detail-320.png`, Buffer.from(approvalDetailShot.data, 'base64'));
    await evaluate(`(() => { Date.now=window.__qaOriginalDateNow; delete window.__qaOriginalDateNow; })()`);

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await evaluate(`(() => {
      const now=new Date();
      const created=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,9).toISOString();
      const due=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12).toISOString();
      const at=hour=>new Date(now.getFullYear(),now.getMonth(),now.getDate(),hour).toISOString();
      localStorage.setItem('tqm_tasks_v1',JSON.stringify([
        {id:'qa-inline',title:'Tên ban đầu',description:'Mô tả ban đầu',status:'todo',createdAt:created,occurrenceDate:due,history:[{at:created,from:null,to:'todo'}],reminderAt:null,recurrenceId:null},
        {id:'qa-done-return',title:'Việc đã xong',description:'',status:'done',createdAt:at(8),occurrenceDate:due,
          history:[{at:at(8),from:null,to:'todo'},{at:at(9),from:'todo',to:'inprogress'},{at:at(10),from:'inprogress',to:'done'}],reminderAt:null,recurrenceId:null}
      ]));
      localStorage.setItem('tqm_series_v1','{}');
    })()`);
    await send('Page.navigate', { url: targetUrl });
    await new Promise(resolve => setTimeout(resolve, 350));
    await evaluate(`document.getElementById('tab-work').click()`);
    const inlineStart = await evaluate(`(() => {
      const card=document.querySelector('[data-task-id="qa-inline"]');
      window.__qaInlineCard=card;
      const title=card.querySelector('.t-title');
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));
      title.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));
      return {editor:!!card.querySelector('.task-card-inline-editor input'),modal:!!document.querySelector('.modal-detail')};
    })()`);
    assert.deepEqual(inlineStart, {editor:true,modal:false}, 'double-click title edits inline');
    await evaluate(`(() => {
      const card=document.querySelector('[data-task-id="qa-inline"]');
      const nameInput=card.querySelector('.task-card-inline-editor input');
      nameInput.value='Tên đã sửa nhanh';
      nameInput.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));
      nameInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      const description=card.querySelector('.t-description');
      description.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
      description.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));
      description.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));
      card.querySelector('.task-card-inline-editor textarea').value='Mô tả đã sửa nhanh';
      card.querySelector('.task-card-inline-editor textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
    })()`);
    const inlineSaved = await evaluate(`(() => {
      const card=document.querySelector('[data-task-id="qa-inline"]');
      const task=JSON.parse(localStorage.getItem('tqm_tasks_v1')).find(item=>item.id==='qa-inline');
      return {sameCard:card===window.__qaInlineCard,title:card.querySelector('.t-title').textContent,description:card.querySelector('.t-description').textContent,
        savedTitle:task.title,savedDescription:task.description,modal:!!document.querySelector('.modal-detail')};
    })()`);
    assert.deepEqual(inlineSaved, {sameCard:true,title:'Tên đã sửa nhanh',description:'Mô tả đã sửa nhanh',savedTitle:'Tên đã sửa nhanh',savedDescription:'Mô tả đã sửa nhanh',modal:false});
    await evaluate(`(() => {
      const title=document.querySelector('[data-task-id="qa-inline"] .t-title');
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
    })()`);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.ok(await evaluate(`!!document.querySelector('.modal-detail')`), 'single click still opens detail');
    const separateDates = await evaluate(`(() => {
      const modal=document.querySelector('.modal-detail');
      return {execution:modal.querySelector('.execution-date-field input[type=text]').value,
        created:modal.querySelector('.created-date-field input').value,
        recurrenceDisabled:modal.querySelector('.recurrence-rule-select').disabled};
    })()`);
    assert.notEqual(separateDates.execution, separateDates.created, 'execution and creation dates are distinct');
    assert.match(separateDates.created, /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/);
    assert.equal(separateDates.recurrenceDisabled, false);
    await evaluate(`(() => {
      const now=new Date(); const next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,12);
      const value=String(next.getDate()).padStart(2,'0')+'/'+String(next.getMonth()+1).padStart(2,'0')+'/'+next.getFullYear();
      document.querySelector('.execution-date-field input[type=text]').value=value;
      document.querySelector('.modal-detail .modal-footer .btn-primary').click();
    })()`);
    const movedDate = await evaluate(`(() => {
      const task=JSON.parse(localStorage.getItem('tqm_tasks_v1')).find(item=>item.id==='qa-inline');
      const card=document.querySelector('[data-task-id="qa-inline"]');
      return {created:new Date(task.createdAt).toDateString(),execution:new Date(task.occurrenceDate).toDateString(),onToday:!!card && !card.classList.contains('search-hidden')};
    })()`);
    assert.notEqual(movedDate.created, movedDate.execution);
    assert.equal(movedDate.onToday, false, 'scheduled task leaves the original day');
    const returnedToWork = await evaluate(`(() => {
      const transfer=new DataTransfer(); transfer.setData('text/plain','qa-done-return');
      document.querySelectorAll('.column .card-list')[1].dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
      const task=JSON.parse(localStorage.getItem('tqm_tasks_v1')).find(item=>item.id==='qa-done-return');
      return {status:task.status,lastFrom:task.history.at(-1).from,lastTo:task.history.at(-1).to,
        inColumn:!!document.querySelectorAll('.column .card-list')[1].querySelector('[data-task-id="qa-done-return"]')};
    })()`);
    assert.deepEqual(returnedToWork, {status:'inprogress',lastFrom:'done',lastTo:'inprogress',inColumn:true});
    await evaluate(`document.querySelector('.period-arrow[title="Kỳ sau"]').click()`);
    assert.ok(await evaluate(`!document.querySelector('[data-task-id="qa-inline"]').classList.contains('search-hidden')`), 'task appears on new execution day');
    await evaluate(`document.querySelector('[data-task-id="qa-inline"]').click()`);
    await evaluate(`(() => {
      document.querySelector('.recurrence-rule-select').value='daily';
      document.querySelector('.modal-detail .modal-footer .btn-primary').click();
    })()`);
    const seriesCreated = await evaluate(`(() => {
      const task=JSON.parse(localStorage.getItem('tqm_tasks_v1')).find(item=>item.id==='qa-inline');
      const series=JSON.parse(localStorage.getItem('tqm_series_v1'));
      return {rule:task.recurrenceRule,count:Object.keys(series).length,definition:series[task.recurrenceId]?.rule};
    })()`);
    assert.deepEqual(seriesCreated, {rule:'daily',count:1,definition:'daily'});
    await evaluate(`document.querySelector('.period-arrow[title="Kỳ sau"]').click()`);
    assert.ok(await evaluate(`!!document.querySelector('.task-card[data-virtual="true"]')`), 'repeat rule generates virtual next day');
    await evaluate(`document.querySelector('.task-card[data-virtual="true"]').click()`);
    assert.equal(await evaluate(`document.querySelector('.recurrence-rule-select').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('.created-date-field input').value`), '—');
    await evaluate(`document.querySelector('.modal-detail .modal-header .icon-btn').click()`);
    await evaluate(`document.querySelector('.period-arrow[title="Kỳ trước"]').click()`);
    await evaluate(`document.querySelector('[data-task-id="qa-inline"]').click()`);
    await evaluate(`(() => {
      document.querySelector('.recurrence-rule-select').value='weekly';
      document.querySelector('.modal-detail .modal-footer .btn-primary').click();
    })()`);
    assert.equal(await evaluate(`Object.values(JSON.parse(localStorage.getItem('tqm_series_v1')))[0].rule`), 'weekly');
    await evaluate(`document.querySelector('.period-arrow[title="Kỳ sau"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.task-card[data-virtual="true"]').length`), 0, 'changed weekly rule removes daily virtual occurrence');
    await evaluate(`(() => { for(let day=0;day<6;day++) document.querySelector('.period-arrow[title="Kỳ sau"]').click(); })()`);
    assert.ok(await evaluate(`!!document.querySelector('.task-card[data-virtual="true"]:not(.search-hidden)')`), 'weekly occurrence appears seven days after root');
    const virtualEdited = await evaluate(`(() => {
      const card=document.querySelector('.task-card[data-virtual="true"]:not(.search-hidden)');
      const title=card.querySelector('.t-title');
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
      title.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));
      title.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));
      card.querySelector('.task-card-inline-editor input').value='Bản tuần sửa riêng';
      card.querySelector('.inline-save').click();
      const tasks=JSON.parse(localStorage.getItem('tqm_tasks_v1'));
      return {real:card.getAttribute('data-virtual'),title:card.querySelector('.t-title').textContent,
        root:tasks.find(item=>item.id==='qa-inline').title,override:tasks.find(item=>item.title==='Bản tuần sửa riêng')?.title};
    })()`);
    assert.deepEqual(virtualEdited, {real:'false',title:'Bản tuần sửa riêng',root:'Tên đã sửa nhanh',override:'Bản tuần sửa riêng'});
    await evaluate(`(() => { for(let day=0;day<7;day++) document.querySelector('.period-arrow[title="Kỳ trước"]').click(); })()`);
    await evaluate(`document.querySelector('[data-task-id="qa-inline"]').click()`);
    await evaluate(`(() => {
      document.querySelector('.recurrence-rule-select').value='none';
      document.querySelector('.modal-detail .modal-footer .btn-primary').click();
    })()`);
    const detached = await evaluate(`(() => {
      const tasks=JSON.parse(localStorage.getItem('tqm_tasks_v1'));
      return {series:Object.keys(JSON.parse(localStorage.getItem('tqm_series_v1'))).length,
        root:tasks.find(item=>item.id==='qa-inline')?.recurrenceId,
        override:tasks.find(item=>item.title==='Bản tuần sửa riêng')?.recurrenceId,
        count:tasks.length};
    })()`);
    assert.deepEqual(detached, {series:0,root:null,override:null,count:3}, 'turning off repeat keeps real occurrences');
  } finally {
    socket.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
