'use strict';
// API v3 example. Feature-detect: older Relink versions do not have these methods.
const bridge = window.relinkPlugin;
const people = document.getElementById('people'), empty = document.getElementById('empty'), marks = document.getElementById('marks');
let current = [];

function render(list) {
  current = list;
  people.replaceChildren(...list.map(person => {
    const item = document.createElement('li');
    item.dataset.speaking = String(person.speaking);
    item.dataset.muted = String(person.muted);
    item.textContent = person.name + (person.self ? '（你）' : '');
    const state = document.createElement('small');
    state.textContent = person.muted ? '闭麦' : person.speaking ? '正在说话' : '';
    item.append(state);
    return item;
  }));
  empty.hidden = list.length > 0;
}

if (bridge.getParticipants && bridge.onParticipants) {
  bridge.getParticipants().then(render).catch(() => render([]));
  const stop = bridge.onParticipants(render);
  addEventListener('pagehide', stop, { once: true });
} else {
  empty.hidden = false;
  empty.textContent = '这个 Relink 版本还不支持说话者接口，请更新 Relink。';
}

bridge.onCommand?.(command => {
  if (command.id !== 'mark') return;
  const speaking = current.filter(person => person.speaking).map(person => person.name);
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${speaking.join('、') || '安静'}`;
  marks.prepend(item);
  while (marks.children.length > 20) marks.lastElementChild.remove();
});
